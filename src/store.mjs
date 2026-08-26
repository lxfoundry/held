// The captured event store.
//
// Scrubbing is done here rather than by callers, so there is exactly one path
// from a courier payload to disk and no way to write around it.
//
// The provider's event lists are cumulative: a later fetch returns everything
// to date. This store is therefore a convenience and a record of when each
// event actually arrived — not the only copy. Losing it costs nothing that a
// fetch cannot recover.
//
// ⚠️ Two processes write here: the receiver and the fetch script. Every write
// takes a per-tracker lock and uses a private temporary file, because the
// documented recovery workflow runs the fetch script against a live receiver.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { scrub, assertClean } from "./scrub.mjs";

// Milestones, coarsest granularity, per docs/specs/tracking-state-mapping.md.
// The mapping keys on statusMilestone; reading statusCode here is a defect.
const MILESTONE_UNKNOWN = "pending";

// The provider's tracker ids are UUIDs, but the id arrives in an
// unauthenticated payload and is used to build a filename. Anything outside
// this shape is rejected before a path is constructed: join() normalises "..",
// so an unvalidated id is an arbitrary file write.
const SAFE_TRACKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function timeOf(event) {
  const raw = event?.datetime ?? event?.occurrenceDatetime;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byDatetime(a, b) {
  const at = timeOf(a);
  const bt = timeOf(b);
  if (at !== bt) return at - bt;
  return String(a?.eventId ?? "").localeCompare(String(b?.eventId ?? ""));
}

// Key order must not change the digest below: the same event serialised in a
// different order is the same event.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

// Events are keyed on the provider's event id. Where one is absent, a digest of
// the event's own content stands in, so a repeated delivery still deduplicates.
//
// No status field is read to build it, deliberately. statusCode is finer than
// the milestone the mapping keys on and varies between carriers, so using it as
// identity can split one logical event into two; statusMilestone is coarser than
// identity, so it can merge two distinct ones. A content digest avoids choosing
// between them and is exact.
export function eventKey(event) {
  if (event?.eventId) return String(event.eventId);
  const digest = createHash("sha1")
    .update(JSON.stringify(canonical(event ?? null)))
    .digest("hex");
  return `content:${digest}`;
}

export function isSafeTrackerId(id) {
  return typeof id === "string" && SAFE_TRACKER_ID.test(id) && !id.includes("..");
}

// Derived from the full event list, never from the event that happened to
// arrive last: pushes are not ordered and may repeat.
export function deriveState(events = []) {
  const sorted = [...events].sort(byDatetime);
  const observed = new Set(sorted.map((e) => e?.statusMilestone).filter(Boolean));
  const last = sorted.at(-1) ?? null;

  // A milestone never regresses. Once delivered has been seen, a later
  // in_transit does not undo it.
  const delivered = observed.has("delivered");

  // Sticky, and deliberately so. Once a parcel has been made available for
  // collection the seller has performed, and the watchdog stands down for that
  // exchange permanently — including if the parcel is later returned to sender
  // and the milestone becomes exception. See the spec, section 2.
  const everAvailableForPickup = observed.has("available_for_pickup");

  return {
    current: delivered ? "delivered" : (last?.statusMilestone ?? MILESTONE_UNKNOWN),
    delivered,
    everAvailableForPickup,
    observed: [...observed],
    eventCount: sorted.length,
    lastEventAt: last ? (last.datetime ?? last.occurrenceDatetime ?? null) : null,
  };
}

// Thrown when a snapshot exists but cannot be read. Never treated as "new
// tracker": doing so would rewrite the file with only the current push, losing
// the sticky flags the spec says are permanent.
export class CorruptSnapshotError extends Error {
  constructor(path, cause) {
    super(`snapshot at ${path} exists but could not be read: ${cause}`);
    this.name = "CorruptSnapshotError";
    this.path = path;
    this.permanent = true;
  }
}

// A payload that cannot be stored no matter how many times it is redelivered.
// Marked permanent so callers do not ask for a retry that cannot succeed.
export class InvalidPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPayloadError";
    this.permanent = true;
  }
}

// Synchronous, because ingest is synchronous end to end. That is load-bearing:
// within one process the read-modify-write cannot interleave, so the lock below
// only has to defend against other processes.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createStore(dir, { retainPlaces = false } = {}) {
  mkdirSync(dir, { recursive: true });

  const snapshotPath = (trackerId) => join(dir, `${trackerId}.json`);
  const logPath = (trackerId) => join(dir, `${trackerId}.events.ndjson`);
  const lockPath = (trackerId) => join(dir, `${trackerId}.lock`);

  // mkdir is atomic across processes, needs no dependency, and leaves a
  // recognisable artefact if a process dies holding it.
  function withLock(trackerId, fn) {
    const lock = lockPath(trackerId);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;

        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue; // released between the failed mkdir and the stat
        }

        if (age > LOCK_STALE_MS) {
          // The holder died. Breaking the lock is safer than blocking for ever:
          // the writes it guards are idempotent and a fetch can rebuild.
          try {
            rmSync(lock, { recursive: true, force: true });
          } catch {
            /* another process broke it first */
          }
          continue;
        }

        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the lock on ${trackerId}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        /* nothing useful to do; a stale lock is broken by age */
      }
    }
  }

  // Distinguishes "no snapshot yet" from "snapshot unreadable". The second must
  // never be silently treated as the first.
  function read(trackerId) {
    const path = snapshotPath(trackerId);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new CorruptSnapshotError(path, err.message);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new CorruptSnapshotError(path, err.message);
    }
  }

  // A private temporary name per write. A shared one lets a concurrent writer
  // rename the file out from under this process mid-write.
  function writeAtomic(path, contents) {
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const tmp = `${path}.${unique}.tmp`;
    try {
      writeFileSync(tmp, contents);
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing left to clean up */
      }
      throw err;
    }
  }

  // Takes one entry of the provider's trackings array: { tracker, shipment,
  // events, statistics }. Returns what changed, so a caller can log it without
  // touching the payload itself.
  function ingest(rawTracking, { receivedAt = new Date().toISOString() } = {}) {
    const { data: tracking, report } = scrub(rawTracking, { retainPlaces });
    assertClean(tracking);

    const trackerId = tracking?.tracker?.trackerId;
    if (!isSafeTrackerId(trackerId)) {
      throw new InvalidPayloadError(
        `tracker.trackerId is missing or not a usable identifier: ${JSON.stringify(trackerId)}`,
      );
    }

    return withLock(trackerId, () => {
      const existing = read(trackerId);
      const known = new Map((existing?.events ?? []).map((e) => [eventKey(e), e]));

      const incoming = Array.isArray(tracking.events) ? tracking.events : [];
      const added = [];
      for (const event of incoming) {
        const key = eventKey(event);
        if (known.has(key)) continue;
        known.set(key, event);
        added.push(event);
      }

      const events = [...known.values()].sort(byDatetime);
      const state = deriveState(events);

      // The append-only arrival log records when each event reached us, which
      // the snapshot cannot show because it is rewritten in place. Written
      // first, so the durable record survives a crash mid-snapshot.
      if (added.length) {
        const lines = added.map((e) => `${JSON.stringify({ receivedAt, event: e })}\n`).join("");
        appendFileSync(logPath(trackerId), lines);
      }

      // A redelivery of events already held changes nothing. Rewriting the
      // snapshot anyway would widen the torn-write window for no benefit and
      // move lastUpdatedAt when nothing was updated.
      if (existing && added.length === 0) {
        return {
          trackerId,
          trackingNumber: existing.trackingNumber ?? null,
          shipmentReference: existing.shipmentReference ?? null,
          added: 0,
          duplicates: incoming.length,
          total: (existing.events ?? []).length,
          state: existing.state ?? state,
          report,
          unchanged: true,
        };
      }

      const snapshot = {
        trackerId,
        trackingNumber: tracking?.tracker?.trackingNumber ?? null,
        shipmentReference: tracking?.tracker?.shipmentReference ?? null,
        courierCode: tracking?.tracker?.courierCode ?? null,
        state,
        shipment: tracking.shipment ?? null,
        statistics: tracking.statistics ?? null,
        events,
        firstSeenAt: existing?.firstSeenAt ?? receivedAt,
        lastUpdatedAt: receivedAt,
      };

      assertClean(snapshot);
      writeAtomic(snapshotPath(trackerId), `${JSON.stringify(snapshot, null, 2)}\n`);

      return {
        trackerId,
        trackingNumber: snapshot.trackingNumber,
        shipmentReference: snapshot.shipmentReference,
        added: added.length,
        duplicates: incoming.length - added.length,
        total: events.length,
        state,
        report,
        unchanged: false,
      };
    });
  }

  function trackerIds() {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  }

  // Cheap enough for a liveness probe every few seconds: it counts files rather
  // than parsing them.
  function count() {
    return trackerIds().length;
  }

  // Deliberately free of location data: this is what an operator checks, and it
  // should carry nothing that would matter if it leaked.
  function summary() {
    return trackerIds().map((id) => {
      let snapshot;
      try {
        snapshot = read(id);
      } catch {
        return { trackerId: id, unreadable: true };
      }
      if (!snapshot) return { trackerId: id, unreadable: true };
      return {
        trackerId: snapshot.trackerId ?? id,
        trackingNumber: snapshot.trackingNumber ?? null,
        shipmentReference: snapshot.shipmentReference ?? null,
        milestone: snapshot.state?.current ?? null,
        events: snapshot.state?.eventCount ?? 0,
        lastEventAt: snapshot.state?.lastEventAt ?? null,
        lastUpdatedAt: snapshot.lastUpdatedAt ?? null,
      };
    });
  }

  return { ingest, summary, count, read, trackerIds, dir };
}
