import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBundle, bundleHash, PROVENANCE } from "../src/evidence.mjs";

const sources = (over = {}) => ({
  exchangeId: "241",
  tracking: { events: [
    { milestone: "in_transit", at: 1, description: "Accepted" },
    { milestone: "delivered",  at: 2, description: "Delivered" },
  ] },
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
