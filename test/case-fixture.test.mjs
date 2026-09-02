import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { applyPhotos, photoPathsFor, ROUNDS } from "../src/case-fixture.mjs";

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
