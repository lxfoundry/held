// The captured event store.
//
// Scrubbing is done here rather than by callers, so there is exactly one path
// from a courier payload to disk and no way to write around it.
//
// The provider's event lists are cumulative: a later fetch returns everything
// to date. This store is therefore a convenience and a record of when each
// event actually arrived — not the only copy. Losing it costs nothing that a
// fetch cannot recover.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scrub, assertClean } from "./scrub.mjs";

// Milestones, coarsest granularity, per docs/specs/tracking-state-mapping.md.
// The mapping keys on statusMilestone; reading statusCode here is a defect.
const MILESTONE_UNKNOWN = "pending";

function byDatetime(a, b) {
  const at = Date.parse(a?.datetime ?? a?.occurrenceDatetime ?? 0) || 0;
  const bt = Date.parse(b?.datetime ?? b?.occurrenceDatetime ?? 0) || 0;
  if (at !== bt) return at - bt;
  return String(a?.eventId ?? "").localeCompare(String(b?.eventId ?? ""));
}

// Events are keyed on the provider's event id. Where one is absent, a stable
// composite stands in, so a repeated delivery still deduplicates.
export function eventKey(event) {
  if (event?.eventId) return String(event.eventId);
  return [
    event?.trackingNumber ?? "",
    event?.datetime ?? event?.occurrenceDatetime ?? "",
    event?.statusCode ?? "",
  ].join("|");
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
    lastEventAt: last?.datetime ?? null,
  };
}

export function createStore(dir, { retainPlaces = false } = {}) {
  mkdirSync(dir, { recursive: true });

  const snapshotPath = (trackerId) => join(dir, `${trackerId}.json`);
  const logPath = (trackerId) => join(dir, `${trackerId}.events.ndjson`);

  function read(trackerId) {
    try {
      return JSON.parse(readFileSync(snapshotPath(trackerId), "utf8"));
    } catch {
      return null;
    }
  }

  function writeAtomic(path, contents) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  // Takes one entry of the provider's trackings array: { tracker, shipment,
  // events, statistics }. Returns what changed, so a caller can log it without
  // touching the payload itself.
  function ingest(rawTracking, { receivedAt = new Date().toISOString() } = {}) {
    const { data: tracking, report } = scrub(rawTracking, { retainPlaces });
    assertClean(tracking);

    const trackerId = tracking?.tracker?.trackerId;
    if (!trackerId) throw new Error("payload has no tracker.trackerId");

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

    // Append-only arrival log: records when each event reached us, which the
    // snapshot cannot show because it is rewritten in place.
    if (added.length) {
      const lines = added.map((e) => `${JSON.stringify({ receivedAt, event: e })}\n`).join("");
      appendFileSync(logPath(trackerId), lines);
    }

    return {
      trackerId,
      trackingNumber: snapshot.trackingNumber,
      shipmentReference: snapshot.shipmentReference,
      added: added.length,
      duplicates: incoming.length - added.length,
      total: events.length,
      state,
      report,
    };
  }

  // Deliberately free of location data: this is what an operator checks from a
  // phone, and it should carry nothing that would matter if it leaked.
  function summary() {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    return files
      .map((f) => read(f.replace(/\.json$/, "")))
      .filter(Boolean)
      .map((s) => ({
        trackerId: s.trackerId,
        trackingNumber: s.trackingNumber,
        shipmentReference: s.shipmentReference,
        milestone: s.state?.current ?? null,
        events: s.state?.eventCount ?? 0,
        lastEventAt: s.state?.lastEventAt ?? null,
        lastUpdatedAt: s.lastUpdatedAt ?? null,
      }));
  }

  return { ingest, summary, read, dir };
}
