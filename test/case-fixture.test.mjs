import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { applyPhotos, photoPathsFor, ROUNDS, ROUND_NUMBER } from "../src/case-fixture.mjs";

// ⭐ The real committed fixture, not a copy shaped like one. The property under
// test is that the edit is an exact inverse over *this file's* formatting, so a
// stand-in with tidy spacing would assert nothing: the failure being guarded
// against is the fixture drifting away from what the replacement reproduces.
const FIXTURE = join(ROOT, "fixtures/case/241.json");
const committed = readFileSync(FIXTURE, "utf8");

test("the committed fixture is the round-2 form, unchanged by re-applying it", () => {
  assert.equal(applyPhotos(committed, 2), committed);
});

test("round 1 then round 2 restores the fixture byte for byte", () => {
  const atRoundOne = applyPhotos(committed, 1);
  assert.notEqual(atRoundOne, committed, "round 1 must actually differ, or the test proves nothing");
  assert.equal(applyPhotos(atRoundOne, 2), committed);
});

test("each round holds exactly the photographs it is defined to hold", () => {
  for (const round of Object.keys(ROUNDS)) {
    const parsed = JSON.parse(applyPhotos(committed, round));
    assert.deepEqual(
      parsed.photos.map((p) => p.path),
      photoPathsFor(round),
      `round ${round}`
    );
  }
});

test("the edit leaves everything outside the photographs alone", () => {
  const before = JSON.parse(committed);
  const after = JSON.parse(applyPhotos(committed, 1));
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.listing, before.listing);
  assert.equal(after.exchangeId, before.exchangeId);
});

test("an unknown round is refused rather than silently emptying the evidence", () => {
  assert.throws(() => applyPhotos(committed, "3"), /round must be/);
  assert.throws(() => applyPhotos(committed, undefined), /round must be/);
});

test("a fixture with no photographs region is refused", () => {
  assert.throws(() => applyPhotos('{ "exchangeId": "241" }', 1), /could not find the photos array/);
});

// ⭐ The property the comparison rests on. 2b differs from round 2 by one
// photograph, and it is only a controlled test if that photograph lands in the
// same evidence slot: src/evidence.mjs numbers photographs by sorted path, so
// a filename sorting differently would silently renumber both and any change in
// the model's answer could be the renumbering rather than the image.
const photoIds = (round) => {
  const parsed = JSON.parse(applyPhotos(committed, round));
  return assembleBundle({
    exchangeId: "241",
    tracking: { events: [] },
    photos: parsed.photos.map((p) => ({ path: p.path, sha256: "0".repeat(64) })),
    messages: parsed.messages,
    listing: parsed.listing,
    viewer: "mediator",
  })
    .items.filter((i) => i.kind === "photo")
    .map((i) => [i.id, i.content.path.split("/").pop()]);
};

test("2b puts the crushed carton in the slot the intact one held", () => {
  const two = photoIds("2");
  const twoB = photoIds("2b");
  assert.deepEqual(two.map(([id]) => id), twoB.map(([id]) => id), "same evidence ids");
  assert.deepEqual(two[0], ["pho-1", "carton.jpg"]);
  assert.deepEqual(twoB[0], ["pho-1", "carton-crushed.jpg"]);
  // The unchanged photograph must not move either, or the swap is not the only
  // difference the model sees.
  assert.deepEqual(two[1], ["pho-2", "inner.jpg"]);
  assert.deepEqual(twoB[1], ["pho-2", "inner.jpg"]);
});

test("2b is a round 2, so it wants the opening round already on file", () => {
  assert.equal(ROUND_NUMBER["2b"], 2);
  assert.equal(ROUND_NUMBER["2"], 2);
  assert.equal(ROUND_NUMBER["1"], 1);
});

test("2b differs from round 2 in exactly one photograph", () => {
  const two = photoPathsFor("2");
  const twoB = photoPathsFor("2b");
  assert.equal(two.length, twoB.length);
  const differing = two.filter((p, i) => p !== twoB[i]);
  assert.equal(differing.length, 1, "one photograph, or the comparison is not controlled");
});
