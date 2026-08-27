import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  deriveState,
  eventKey,
  isSafeTrackerId,
  CorruptSnapshotError,
  InvalidPayloadError,
} from "../src/store.mjs";

function tracking(events, trackerId = "test-tracker") {
  return {
    tracker: { trackerId, trackingNumber: "MZ544750899GB", shipmentReference: "parcel A" },
    shipment: { statusMilestone: events.at(-1)?.statusMilestone ?? "pending", recipient: {} },
    events,
    statistics: { timestamps: {} },
  };
}

const event = (id, milestone, datetime) => ({
  eventId: id,
  trackingNumber: "MZ544750899GB",
  datetime,
  statusMilestone: milestone,
  location: "<Town> Post Office [AB12 3CD]",
});

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "held-store-"));
  try {
    return fn(createStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the same push twice adds the event once", () => {
  withStore((store) => {
    const payload = tracking([event("a", "in_transit", "2026-08-26T15:21:01.000Z")]);
    const first = store.ingest(payload);
    const second = store.ingest(payload);
    assert.equal(first.added, 1);
    assert.equal(second.added, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(second.total, 1);
  });
});

test("state comes from the full event list, not from arrival order", () => {
  withStore((store) => {
    store.ingest(tracking([event("c", "delivered", "2026-08-28T09:00:00.000Z")]));
    const out = store.ingest(tracking([event("a", "in_transit", "2026-08-26T15:21:01.000Z")]));
    assert.equal(out.total, 2);
    assert.equal(out.state.current, "delivered");
  });
});

test("a milestone never regresses once delivered is seen", () => {
  const state = deriveState([
    { eventId: "a", statusMilestone: "in_transit", datetime: "2026-08-26T00:00:00.000Z" },
    { eventId: "b", statusMilestone: "delivered", datetime: "2026-08-27T00:00:00.000Z" },
    { eventId: "c", statusMilestone: "in_transit", datetime: "2026-08-28T00:00:00.000Z" },
  ]);
  assert.equal(state.current, "delivered");
  assert.equal(state.delivered, true);
});

test("available_for_pickup is sticky even when the parcel is later an exception", () => {
  const state = deriveState([
    { eventId: "a", statusMilestone: "available_for_pickup", datetime: "2026-08-26T00:00:00.000Z" },
    { eventId: "b", statusMilestone: "exception", datetime: "2026-09-05T00:00:00.000Z" },
  ]);
  assert.equal(state.current, "exception");
  assert.equal(state.everAvailableForPickup, true, "the watchdog must stand down for this exchange");
});

test("an empty event list is a resting state, not a failure", () => {
  withStore((store) => {
    const out = store.ingest(tracking([]));
    assert.equal(out.total, 0);
    assert.equal(out.state.current, "pending");
  });
});

test("nothing reaches disk with a postcode in it", () => {
  withStore((store, dir) => {
    store.ingest(tracking([event("a", "in_transit", "2026-08-26T15:21:01.000Z")]));
    const written = readFileSync(join(dir, "test-tracker.json"), "utf8");
    assert.ok(!/AB12\s*3CD/i.test(written), "a postcode was written to the store");
    assert.ok(!/Post Office/i.test(written), "a place name was written to the store");
    assert.match(written, /\[location\]/);
    const log = readFileSync(join(dir, "test-tracker.events.ndjson"), "utf8");
    assert.ok(!/AB12\s*3CD/i.test(log), "a postcode was written to the arrival log");
  });
});

// The tracker id arrives in an unauthenticated payload and becomes a filename.
test("only a filename-safe tracker id is accepted", () => {
  assert.equal(isSafeTrackerId("8645991e-538a-40a2-8618-6f9d3777a6ae"), true);
  assert.equal(isSafeTrackerId("test-tracker"), true);
  for (const bad of [
    "../escaped",
    "a/../b",
    "sub/dir",
    "\\\\server\\share",
    "",
    ".hidden",
    null,
    42,
    { nested: true },
    "x".repeat(200),
  ]) {
    assert.equal(isSafeTrackerId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a payload whose tracker id would escape the store is refused", () => {
  withStore((store, dir) => {
    assert.throws(
      () => store.ingest(tracking([event("a", "in_transit", "2026-08-26T15:21:01.000Z")], "../escaped")),
      InvalidPayloadError,
    );
    assert.equal(readdirSync(dir).length, 0);
  });
});

// A snapshot that exists but cannot be parsed must never be mistaken for a new
// tracker: rewriting it would discard the sticky flags the spec calls permanent.
test("an unreadable snapshot is an error, not an empty history", () => {
  withStore((store, dir) => {
    store.ingest(tracking([event("a", "available_for_pickup", "2026-08-26T00:00:00.000Z")]));
    assert.equal(store.read("test-tracker").state.everAvailableForPickup, true);

    writeFileSync(join(dir, "test-tracker.json"), "{ truncated");

    assert.throws(() => store.read("test-tracker"), CorruptSnapshotError);
    assert.throws(
      () => store.ingest(tracking([event("b", "exception", "2026-09-05T00:00:00.000Z")])),
      CorruptSnapshotError,
    );
    assert.ok(
      readFileSync(join(dir, "test-tracker.json"), "utf8").startsWith("{ truncated"),
      "the corrupt snapshot was overwritten",
    );
  });
});

test("a redelivery holding no new events does not rewrite the snapshot", () => {
  withStore((store, dir) => {
    const payload = tracking([event("a", "in_transit", "2026-08-26T15:21:01.000Z")]);
    store.ingest(payload, { receivedAt: "2026-08-26T15:00:00.000Z" });
    const first = readFileSync(join(dir, "test-tracker.json"), "utf8");

    const again = store.ingest(payload, { receivedAt: "2026-08-27T09:00:00.000Z" });
    assert.equal(again.unchanged, true);
    assert.equal(
      readFileSync(join(dir, "test-tracker.json"), "utf8"),
      first,
      "lastUpdatedAt moved when nothing was updated",
    );
  });
});

test("lastEventAt falls back to occurrenceDatetime", () => {
  const state = deriveState([
    { eventId: "a", statusMilestone: "in_transit", occurrenceDatetime: "2026-08-26T15:21:01+01:00" },
  ]);
  assert.equal(state.eventCount, 1);
  assert.equal(state.lastEventAt, "2026-08-26T15:21:01+01:00");
});

test("concurrent writes within one process do not lose events", () => {
  withStore((store) => {
    for (let i = 0; i < 25; i += 1) {
      store.ingest(tracking([event(`e${i}`, "in_transit", `2026-08-26T15:${String(i).padStart(2, "0")}:00.000Z`)]));
    }
    assert.equal(store.read("test-tracker").events.length, 25);
  });
});

// An event without a provider id is identified by its own content. No status
// field is read to do it: statusCode is finer than the milestone the mapping
// keys on and can split one logical event in two, and statusMilestone is
// coarser than identity and can merge two distinct ones.
test("an event with no id is keyed on its content, not on a status field", () => {
  const event = {
    trackingNumber: "MZ544750899GB",
    datetime: "2026-08-26T15:21:01.000Z",
    statusMilestone: "in_transit",
    statusCode: "transit_handover",
  };
  const reordered = {
    statusCode: "transit_handover",
    statusMilestone: "in_transit",
    datetime: "2026-08-26T15:21:01.000Z",
    trackingNumber: "MZ544750899GB",
  };

  assert.equal(eventKey(event), eventKey(reordered), "key order changed the identity");
  assert.ok(!eventKey(event).includes("transit_handover"), "a status code leaked into the key");
  assert.notEqual(eventKey(event), eventKey({ ...event, datetime: "2026-08-27T00:00:00.000Z" }));
  assert.equal(eventKey({ eventId: "provided" }), "provided");
});

test("an id-less event still deduplicates across redeliveries", () => {
  withStore((store) => {
    const bare = {
      trackingNumber: "MZ544750899GB",
      datetime: "2026-08-26T15:21:01.000Z",
      statusMilestone: "in_transit",
    };
    assert.equal(store.ingest(tracking([bare])).added, 1);
    assert.equal(store.ingest(tracking([bare])).added, 0);
    assert.equal(store.read("test-tracker").events.length, 1);
  });
});
