import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { applyPhotos, buildCaseInput, photoPathsFor, roundAdding, OPENING_ROUND, PHOTOS, ROUNDS, ROUND_NUMBER } from "../src/case-fixture.mjs";

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

// ⭐ The mapping the buyer's "Add a photo" runs on: a photograph names the
// round the case reaches once it has been added, and that is what makes the one
// edit in this file the only writer of a case's photographs. Pinned to the three
// answers it must give, so a change to ROUNDS that silently stopped naming a
// branch is a failure here rather than a wrong evidence set written at run time.
test("a branch photograph names the round that adds it", () => {
  assert.equal(roundAdding("carton"), "2");
  assert.equal(roundAdding("carton-crushed"), "2b");
  assert.equal(roundAdding("carton-crushed-padded"), "2c");
});

test("the round a photograph names is the opening round plus that photograph", () => {
  for (const name of ["carton", "carton-crushed", "carton-crushed-padded"]) {
    assert.deepEqual(
      photoPathsFor(roundAdding(name)),
      [...photoPathsFor(OPENING_ROUND), PHOTOS[name].path],
      name
    );
  }
});

// ⚠️ Not an answer, rather than a wrong one. The opening round already holds
// `inner`, so no round adds it; a traversal attempt names no round for the same
// reason anything else does not. The caller decides what an absent round means —
// src/case-input.mjs refuses the request.
test("a photograph no round adds names no round", () => {
  assert.equal(roundAdding("inner"), undefined);
  assert.equal(roundAdding("../../etc/passwd"), undefined);
  assert.equal(roundAdding(""), undefined);
  assert.equal(roundAdding(undefined), undefined);
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

// ⭐ The property the comparison rests on. Each branch differs from round 2 by
// one photograph, and it is only a controlled test if that photograph lands in
// the same evidence slot: src/evidence.mjs numbers photographs by sorted path, so
// a filename sorting differently would silently renumber both and any change in
// the model's answer could be the renumbering rather than the image.
//
// ⚠️ The tracking and the offer terms are the parts a real run supplies from the
// exchange record rather than from the case file, and they are handed to every
// round here as the same value — parcel A's own events, not a shape written to
// match. That is the other half of the comparison: it is only controlled if
// nothing outside the photographs moves, and a stand-in that varied per round
// would hide exactly the failure this asserts against.
const PARCEL_A = JSON.parse(
  readFileSync(join(ROOT, "fixtures/events/8645991e-538a-40a2-8618-6f9d3777a6ae.json"), "utf8"),
).events;
const OFFER_TERMS = { price: "200", currency: "USDC", disputePeriodMs: 604800000 };

const bundleFor = (round) => {
  const parsed = JSON.parse(applyPhotos(committed, round));
  return assembleBundle({
    exchangeId: "241",
    tracking: { events: PARCEL_A },
    offerTerms: OFFER_TERMS,
    photos: parsed.photos.map((p) => ({ path: p.path, sha256: "0".repeat(64) })),
    messages: parsed.messages,
    listing: parsed.listing,
    viewer: "mediator",
  });
};

const photoIds = (round) =>
  bundleFor(round)
    .items.filter((i) => i.kind === "photo")
    .map((i) => [i.id, i.content.path.split("/").pop()]);

test("every branch puts its carton in the slot the intact one held", () => {
  const two = photoIds("2");
  assert.deepEqual(two[0], ["pho-1", "carton.jpg"]);
  assert.deepEqual(two[1], ["pho-2", "inner.jpg"]);
  for (const [round, filename] of [
    ["2b", "carton-crushed.jpg"],
    ["2c", "carton-crushed-padded.jpg"],
  ]) {
    const branch = photoIds(round);
    assert.deepEqual(two.map(([id]) => id), branch.map(([id]) => id), `${round}: same evidence ids`);
    assert.deepEqual(branch[0], ["pho-1", filename], round);
    // The unchanged photograph must not move either, or the swap is not the only
    // difference the model sees.
    assert.deepEqual(branch[1], ["pho-2", "inner.jpg"], round);
  }
});

test("the branch rounds are round 2s, so they want the opening round on file", () => {
  assert.equal(ROUND_NUMBER["2b"], 2);
  assert.equal(ROUND_NUMBER["2c"], 2);
  assert.equal(ROUND_NUMBER["2"], 2);
  assert.equal(ROUND_NUMBER["1"], 1);
});

test("every branch differs from round 2 in exactly one photograph", () => {
  const two = photoPathsFor("2");
  for (const round of ["2b", "2c"]) {
    const branch = photoPathsFor(round);
    assert.equal(two.length, branch.length, round);
    const differing = two.filter((p, i) => p !== branch[i]);
    assert.equal(differing.length, 1, `${round}: one photograph, or the comparison is not controlled`);
  }
});

// ⭐ The claim docs/specs/evidence-and-mediation.md §7.1 makes about the branches
// being one case, asserted over the assembled evidence rather than over the
// file: the tracking, the offer terms, the message thread and the listing reach
// the model identically, so the only thing that can account for a difference in
// what it says is the photograph. The test above fixes the photographs; this
// one fixes everything else.
test("every branch is the same case outside the swapped photograph", () => {
  const others = (round) => bundleFor(round).items.filter((i) => i.kind !== "photo");
  const two = others("2");
  const kinds = [...new Set(two.map((i) => i.kind))];
  assert.deepEqual(
    kinds.sort(),
    ["listing", "message", "offer_terms", "tracking_event"],
    "a bundle missing a kind would leave this asserting less than it claims",
  );
  for (const round of ["2b", "2c"]) assert.deepEqual(others(round), two, round);
});

// ⭐ A case input for an exchange that has none. The evidence a case carries
// beyond the chain and the carrier — the listing, the thread, the photographs —
// is the one part nothing can derive, so a new exchange has no case file and
// scripts/mediate.mjs reads one unconditionally. This writes the smallest file
// that is still a case, and the tests below fix what "smallest" means.
const parse = (id, over = {}) => JSON.parse(buildCaseInput({ exchangeId: id, ...over }));

test("a fresh case input is for the exchange it was asked for", () => {
  assert.equal(parse("300").exchangeId, "300");
});

// ⚠️ The id is asserted on the *line*, not just the value. scripts/demo-states.mjs
// copies a case to another exchange by replacing exactly this text, so a file
// that serialised it differently would be unusable as a copy source.
test("the exchange id is written on the line a copy replaces", () => {
  assert.match(buildCaseInput({ exchangeId: "300" }), /"exchangeId": "300"/);
});

test("the title names the exchange, and the body repeats the title", () => {
  const { listing } = parse("300");
  assert.equal(listing.title, "Offer 300");
  assert.equal(listing.body, "Offer 300");
});

test("a title given without a body becomes both", () => {
  const { listing } = parse("300", { title: "Teak bench" });
  assert.equal(listing.title, "Teak bench");
  assert.equal(listing.body, "Teak bench");
});

test("a body given is kept beside the title rather than replacing it", () => {
  const { listing } = parse("300", { title: "Teak bench", body: "Weathered, collected from the shed" });
  assert.equal(listing.title, "Teak bench");
  assert.equal(listing.body, "Weathered, collected from the shed");
});

test("the price defaults to 200 and is written as the text a listing shows", () => {
  assert.equal(parse("300").listing.priceText, "200");
  assert.equal(parse("300", { price: 75 }).listing.priceText, "75");
});

// A case with neither is still a case: src/demo-states.mjs writes listing-only
// inputs for the purchases that only need a card on screen.
test("photographs and messages are absent unless they are asked for", () => {
  const input = parse("300");
  assert.deepEqual(input.photos, []);
  assert.deepEqual(input.messages, []);
});

test("asking for a photograph gives the one the opening round holds", () => {
  const input = parse("300", { photos: true });
  assert.deepEqual(input.photos.map((p) => p.path), photoPathsFor(OPENING_ROUND));
  assert.deepEqual(input.photos[0], PHOTOS.inner);
});

test("asking for messages gives the buyer's complaint and nothing from the seller", () => {
  const input = parse("300", { messages: true, now: 1788288220000 });
  assert.equal(input.messages.length, 1);
  assert.deepEqual(input.messages[0], {
    from: "buyer",
    at: 1788288220000,
    text: "It arrived today. One box has a badly crushed corner, split right open. That isn't what I paid for.",
  });
});

// ⭐ The property that makes the file usable rather than merely valid: the
// buyer's "Add a photo" and scripts/demo-reset.mjs both move a case between
// rounds through applyPhotos, which edits one region of the *text*. A file
// whose photos array it could not find would parse fine and be inert.
test("a fresh case input can be moved between rounds like a committed one", () => {
  for (const photos of [false, true]) {
    const text = buildCaseInput({ exchangeId: "300", photos });
    for (const round of Object.keys(ROUNDS)) {
      const moved = JSON.parse(applyPhotos(text, round));
      assert.deepEqual(moved.photos.map((p) => p.path), photoPathsFor(round), `photos:${photos} round:${round}`);
      assert.equal(moved.exchangeId, "300");
    }
  }
});

test("an exchange id is required, because the file is named after it", () => {
  assert.throws(() => buildCaseInput({}), /exchangeId/);
  assert.throws(() => buildCaseInput({ exchangeId: "" }), /exchangeId/);
});
