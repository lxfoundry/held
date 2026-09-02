// The catalogue in src/demo-states.mjs claims, for each entry, which screen it
// produces. This renders every entry through the real view and checks the
// claim — so the catalogue cannot drift from the view, and a change to either
// that breaks a state fails here rather than on a browser during a demo.
//
// ⭐ The two mediated entries are seeded from committed recordings of real
// model calls, in the shape scripts/mediate.mjs writes. That is deliberate:
// the view once reached for a `result` wrapper no writer has ever produced, and
// every test asserting the mediation block built that wrapper itself, so the
// suite stayed green while the mediation screens were unreachable from real
// data. A test that reads what the system actually writes cannot repeat that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { viewFor } from "../src/buyer-view.mjs";
import { applyPhotos } from "../src/case-fixture.mjs";
import { ROOT } from "../src/env.mjs";
import {
  CATALOGUE,
  DEMO_ID_PREFIX,
  DEMO_TRACKERS,
  caseRecordFor,
  isDemoId,
  recordFor,
  trackingFor,
} from "../src/demo-states.mjs";

// Fixed, so a rendered deadline or finalisation date is the same on every run.
const NOW = Date.parse("2026-09-02T12:00:00Z");

const snapshot = (trackerId) =>
  JSON.parse(readFileSync(join(ROOT, "fixtures/events", `${trackerId}.json`), "utf8"));

const recording = (hash) =>
  JSON.parse(readFileSync(join(ROOT, "fixtures/case/recordings", `${hash}.json`), "utf8"));

// The captured snapshots the catalogue points at, read once. Committed, so a
// fresh clone has them and this test needs nothing generated first.
const captured = {};
for (const entry of CATALOGUE) {
  if (!DEMO_TRACKERS[entry.tracker] && !captured[entry.tracker]) {
    captured[entry.tracker] = snapshot(entry.tracker);
  }
}

const eventsFor = (entry) =>
  DEMO_TRACKERS[entry.tracker]?.events ?? captured[entry.tracker]?.events ?? [];

// The evidence an entry's case holds, derived the way scripts/demo-states.mjs
// derives the file it writes: the source fixture, moved to the round the entry
// stands at. Reading the generated copy instead would make this test depend on
// the script having been run.
const photosFor = (entry) => {
  if (!entry.caseInput) return [];
  const source = readFileSync(join(ROOT, `fixtures/case/${entry.caseInput.from}.json`), "utf8");
  return JSON.parse(applyPhotos(source, entry.caseInput.round)).photos;
};

function render(entry, { allowConfirm = false } = {}) {
  return viewFor({
    record: recordFor(entry, NOW),
    tracking: trackingFor(entry, captured),
    caseRecord: entry.recording ? caseRecordFor(entry, recording(entry.recording)) : null,
    listing: entry.listing,
    events: eventsFor(entry),
    photos: photosFor(entry),
    allowConfirm,
  });
}

test("every id is a demo id, and no two entries share one", () => {
  const ids = CATALOGUE.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in the catalogue");
  for (const id of ids) {
    assert.ok(isDemoId(id), `${id} does not carry the ${DEMO_ID_PREFIX} prefix`);
    // The server's own route only ever matches digits, so an id that is not
    // one would be unreachable from the page that is supposed to show it.
    assert.match(id, /^\d+$/);
  }
});

// The claim each entry makes, checked against the view it actually produces.
for (const entry of CATALOGUE) {
  test(`${entry.id} — ${entry.name}`, () => {
    // allowConfirm on, so an action the model would draw disabled for want of
    // an operator setting still appears in the list: this asserts which actions
    // exist, not how the operator configured them.
    const v = render(entry, { allowConfirm: true });

    assert.equal(v.money.key, entry.expect.money, "money line");
    assert.equal(v.parcel.key, entry.expect.parcel, "parcel line");
    assert.deepEqual(v.actions.map((a) => a.id), entry.expect.actions, "actions");
    assert.equal(v.notice != null, entry.expect.notice, "deadline notice");
    assert.equal(v.timeline != null, entry.expect.timeline, "timeline");

    // ⚠️ "no mediation" is two different shapes: null when the exchange is not
    // in dispute, and a pair of nulls when it is but no round has produced
    // anything yet. Both draw nothing, and the entry claims only that.
    const drawn = v.mediation?.question ? "question" : v.mediation?.proposal ? "proposal" : false;
    assert.equal(drawn, entry.expect.mediation, "mediation block");

    // ⭐ Absent unless the entry says otherwise, so the ten states that hold no
    // evidence assert that they draw none without each having to say so.
    assert.equal(v.evidence?.summary ?? false, entry.expect.evidence ?? false, "evidence block");
  });
}

test("the mediated entries carry the model's own words, not copy written for a demo", () => {
  const asked = CATALOGUE.find((e) => e.expect.mediation === "question");
  const proposed = CATALOGUE.find((e) => e.expect.mediation === "proposal");

  const question = render(asked).mediation.question;
  assert.equal(question, recording(asked.recording).response.requests.find(
    (r) => r.whoCanProvide === "buyer",
  ).what);

  const proposal = render(proposed).mediation.proposal;
  const response = recording(proposed.recording).response;
  assert.equal(proposal.reasoning, response.reasoning);
  // The recording's own percentage of a £200 listing — read from the response
  // rather than written here, so a re-recorded round moves this with it —
  // formatted by the one formatter the proposal and the ending it settles to
  // share.
  assert.equal(proposal.refund, `£${(200 * response.buyerPercent) / 100}`);
});

// The two mediated entries state the listing inline, and the model's recorded
// reasoning names the item it describes — so if the committed case those
// recordings belong to is ever re-shot around a different item, the catalogue
// would be putting the model's words against the wrong thing.
test("an entry seeded from a recording carries the listing that recording is about", () => {
  const source = JSON.parse(readFileSync(join(ROOT, "fixtures/case/241.json"), "utf8"));
  for (const entry of CATALOGUE.filter((e) => e.caseInput)) {
    assert.equal(entry.caseInput.from, "241");
    assert.deepEqual(entry.listing, source.listing);
  }
});

test("an unarmed operator disables the completing action rather than removing it", () => {
  const delivered = CATALOGUE.find((e) => e.expect.actions.includes("complete"));
  const v = render(delivered, { allowConfirm: false });
  const complete = v.actions.find((a) => a.id === "complete");
  assert.equal(complete.enabled, false);
  assert.ok(complete.reason, "a disabled action must say why");
  // Disputing is never gated on the operator: it is the action with no
  // backstop behind it.
  assert.equal(v.actions.find((a) => a.id === "raise").enabled, true);
});

test("every demo tracker's events derive to a milestone some entry needs", () => {
  for (const [trackerId, tracker] of Object.entries(DEMO_TRACKERS)) {
    const used = CATALOGUE.filter((e) => e.tracker === trackerId);
    assert.ok(used.length > 0, `${trackerId} is defined and never used`);
    // Nothing here writes a derived state — the store derives it from the
    // events, exactly as it would from a carrier push, and the entry's claimed
    // parcel line above is what pins the result.
    assert.ok(tracker.events.length > 0, `${trackerId} has no events`);
    assert.match(tracker.trackingNumber, /^DE\d{9}GB$/, "a demo number, not one a carrier issued");
  }
});
