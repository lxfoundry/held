import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { assembleBundle, bundleHash, PROVENANCE } from "../src/evidence.mjs";

// ⚠️ The fixture is the event store's own artefact, not a shape written to
// match this module. Assembly's guarantees are about the events this system
// actually captures, and a hand-written `{ at, milestone }` event proves them
// only against itself — see fixtures/parcels.md for what parcel A is.
const PARCEL_A = JSON.parse(
  readFileSync(join(ROOT, "fixtures/events/8645991e-538a-40a2-8618-6f9d3777a6ae.json"), "utf8"),
).events;

const sources = (over = {}) => ({
  exchangeId: "241",
  tracking: { events: PARCEL_A.slice(0, 2) },
  offerTerms: { price: "200", currency: "USDC", disputePeriodMs: 604800000 },
  photos: [{ path: "fixtures/case/photos/inner.jpg", sha256: "aa" }],
  messages: [
    { from: "seller", at: 3, text: "Posted today" },
    { from: "buyer", at: 4, text: "Nothing has arrived" },
  ],
  listing: { title: "Four sets", body: "Used, like new", priceText: "200" },
  viewer: "mediator",
  ...over,
});

test("the same sources produce the same ids and the same hash", () => {
  const a = assembleBundle(sources());
  const b = assembleBundle(sources());
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
  assert.equal(a.hash, b.hash);
});

test("adding one photograph changes the hash", () => {
  const before = assembleBundle(sources());
  const after = assembleBundle(sources({
    photos: [
      { path: "fixtures/case/photos/inner.jpg", sha256: "aa" },
      { path: "fixtures/case/photos/carton.jpg", sha256: "bb" },
    ],
  }));
  assert.notEqual(before.hash, after.hash);
});

test("every item carries a known provenance and a visibility", () => {
  for (const item of assembleBundle(sources()).items) {
    assert.ok(PROVENANCE.includes(item.provenance), `unknown provenance ${item.provenance}`);
    assert.equal(item.visibility, "shared");
  }
});

test("authored items stay marked", () => {
  const { items } = assembleBundle(sources());
  const byKind = (k) => items.find((i) => i.kind === k);
  assert.equal(byKind("message").authored, true);
  assert.equal(byKind("listing").authored, true);
  assert.equal(byKind("tracking_event").authored, false);
  assert.equal(byKind("offer_terms").authored, false);
});

test("a photograph is referenced, never inlined", () => {
  const photo = assembleBundle(sources()).items.find((i) => i.kind === "photo");
  assert.deepEqual(Object.keys(photo.content).sort(), ["path", "sha256"]);
});

// Two of each orderable kind, handed over in the opposite order. With one item
// per kind a reversal is a no-op and this passes with the sorting deleted.
test("ids are stable across a reordering of the same sources", () => {
  const forward = assembleBundle(sources());
  const reversed = assembleBundle(sources({
    messages: [...sources().messages].reverse(),
    tracking: { events: [...sources().tracking.events].reverse() },
    photos: [
      { path: "fixtures/case/photos/zzz.jpg", sha256: "bb" },
      { path: "fixtures/case/photos/inner.jpg", sha256: "aa" },
    ],
  }));
  const forwardPlus = assembleBundle(sources({
    photos: [
      { path: "fixtures/case/photos/inner.jpg", sha256: "aa" },
      { path: "fixtures/case/photos/zzz.jpg", sha256: "bb" },
    ],
  }));
  assert.deepEqual(reversed.items.map((i) => i.id), forwardPlus.items.map((i) => i.id));
  assert.equal(reversed.hash, forwardPlus.hash);
  assert.notEqual(forward.hash, reversed.hash, "the extra photograph must still change the hash");
});

test("hash is over content, not over object key order", () => {
  const a = bundleHash([{ id: "x", kind: "k", provenance: "chain", visibility: "shared", authored: false, content: { a: 1, b: 2 } }]);
  const b = bundleHash([{ content: { b: 2, a: 1 }, authored: false, visibility: "shared", provenance: "chain", kind: "k", id: "x" }]);
  assert.equal(a, b);
});


test("real captured events sort chronologically", () => {
  const { items } = assembleBundle({ exchangeId: "241", tracking: { events: PARCEL_A } });
  const events = items.filter((i) => i.kind === "tracking_event");
  assert.equal(events.length, PARCEL_A.length);
  const times = events.map((i) => i.at);
  assert.ok(times.every((t) => typeof t === "number"), "an event has no usable time");
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "events are not in chronological order");
  // trk-1 is the first thing that happened. Reverse-chronological ids would
  // make every citation in every finding point at the wrong event.
  assert.equal(events.at(-1).content.statusMilestone, "delivered");
});

test("real captured events keep their ids across a reordering", () => {
  const forward = assembleBundle({ exchangeId: "241", tracking: { events: PARCEL_A } });
  const reversed = assembleBundle({ exchangeId: "241", tracking: { events: [...PARCEL_A].reverse() } });
  assert.deepEqual(
    reversed.items.map((i) => [i.id, i.content.eventId]),
    forward.items.map((i) => [i.id, i.content.eventId]),
  );
  assert.equal(reversed.hash, forward.hash);
});
