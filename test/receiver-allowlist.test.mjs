// The allowlist, exercised over HTTP.
//
// It lives in its own file because the receiver reads its configuration once at
// import time, and node's test runner gives each file its own process — so this
// is the only way to exercise a second configuration of the same module.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const eventsDir = mkdtempSync(join(tmpdir(), "held-allowlist-"));
const SECRET = "test-secret";
const REGISTERED = "8645991e-538a-40a2-8618-6f9d3777a6ae";
const STRANGER = "271cea63-072b-4d31-b13d-33200f386d18";

process.env.EVENTS_DIR = eventsDir;
process.env.SHIP24_WEBHOOK_SECRET = SECRET;
process.env.RETAIN_LOCATIONS = "false";
process.env.SHIP24_TRACKER_ALLOWLIST = REGISTERED;

const { server, store, hookPath } = await import("../src/receiver.mjs");

let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(eventsDir, { recursive: true, force: true });
});

function tracking(trackerId) {
  return {
    tracker: { trackerId, trackingNumber: "MZ544750899GB", shipmentReference: "parcel A" },
    shipment: { statusMilestone: "in_transit", recipient: {} },
    events: [
      {
        eventId: `event-for-${trackerId}`,
        trackingNumber: "MZ544750899GB",
        occurrenceDatetime: "2026-08-26T15:21:01+01:00",
        statusMilestone: "in_transit",
      },
    ],
    statistics: { timestamps: {} },
  };
}

function post(body) {
  return fetch(`${origin}${hookPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a push for a registered tracker is stored", async () => {
  const res = await post({ trackings: [tracking(REGISTERED)] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, trackings: 1, added: 1, rejected: 0 });
  assert.ok(store.read(REGISTERED), "the registered tracker was not stored");
});

// This is the case the change exists for: on D2 the provider itself pushed a
// tracker nobody registered, carrying a live tracking number in state
// delivered. An adapter reading that would have paid the seller.
test("a push for a tracker we never registered is not stored", async () => {
  const res = await post({ trackings: [tracking(STRANGER)] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, trackings: 1, added: 0, rejected: 1 });
  assert.equal(store.read(STRANGER), null, "an unregistered tracker was stored");
});

// Nothing may be written for a refused tracker — not a snapshot, not an event
// log, not a lock file. A rejected push must leave no trace on the volume.
test("a refused push writes nothing at all to the store", async () => {
  await post({ trackings: [tracking(STRANGER)] });
  for (const suffix of [".json", ".events.ndjson", ".lock"]) {
    assert.equal(
      existsSync(join(eventsDir, `${STRANGER}${suffix}`)),
      false,
      `a refused push created ${suffix}`,
    );
  }
});

// A tracker that is not on the list will never be on it by being sent again,
// so asking for a redelivery would wedge the provider's queue behind it.
test("a refused push is not asked for again", async () => {
  const res = await post({ trackings: [tracking(STRANGER)] });
  assert.equal(res.status, 200, "a refusal asked the provider to retry");
});

// One stranger in a batch must not cost the registered trackers alongside it.
test("a mixed batch stores the registered tracker and refuses the stranger", async () => {
  const res = await post({ trackings: [tracking(STRANGER), tracking(REGISTERED)] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, trackings: 2, added: 0, rejected: 1 });
  assert.ok(store.read(REGISTERED), "the registered tracker was lost to its neighbour");
});
