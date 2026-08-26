import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, deriveState } from "../src/store.mjs";

function tracking(events) {
  return {
    tracker: { trackerId: "test-tracker", trackingNumber: "MZ544750899GB", shipmentReference: "parcel A" },
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
