import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { checkProposal, toBasisPoints, forParty, STATUS, FIELDS } from "../src/proposal.mjs";
import { FORMAT } from "../src/model.mjs";

const bundle = { items: [{ id: "pho-1" }, { id: "lst-1" }] };

const proposal = (over = {}) => ({
  status: STATUS.PROPOSAL,
  buyerPercent: 20,
  reasoning: "The outer carton is intact, so the damage predates postage.",
  findings: [{ statement: "carton intact", evidenceIds: ["pho-1"] }],
  ...over,
});

const needsEvidence = (over = {}) => ({
  status: STATUS.NEEDS_EVIDENCE,
  requests: [{
    what: "a photograph of the outer shipping carton",
    whyItMatters: "It distinguishes damage in transit from damage before postage.",
    whoCanProvide: "buyer",
    wouldChange: [
      { answer: "intact", implies: "pre-existing", split: 20 },
      { answer: "crushed", implies: "in transit", split: 8 },
    ],
  }],
  provisional: { buyerPercent: 14, reasoning: "Split the difference pending the carton." },
  findings: [{ statement: "inner box crushed", evidenceIds: ["pho-1"] }],
  ...over,
});

// --- the action space ---

test("a percentage outside 0-100 is rejected", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: 101 }), bundle).ok, false);
  assert.equal(checkProposal(proposal({ buyerPercent: -1 }), bundle).ok, false);
});

test("a non-numeric percentage is rejected", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: "20" }), bundle).ok, false);
});

test("both endpoints are accepted", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: 0 }), bundle).ok, true);
  assert.equal(checkProposal(proposal({ buyerPercent: 100 }), bundle).ok, true);
});

test("a remedy field that is not a percentage is rejected", () => {
  const r = checkProposal(proposal({ replacement: true }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown field/);
});

// --- grounding ---

test("a citation to an absent id is rejected", () => {
  const r = checkProposal(proposal({
    findings: [{ statement: "x", evidenceIds: ["pho-9"] }],
  }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /pho-9/);
});

test("grounding is checked on needs_evidence too", () => {
  const r = checkProposal(needsEvidence({
    findings: [{ statement: "x", evidenceIds: ["nope-1"] }],
  }), bundle);
  assert.equal(r.ok, false);
});

// --- the three variants ---

test("needs_evidence must carry a provisional split", () => {
  const r = checkProposal(needsEvidence({ provisional: undefined }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /provisional/);
});

test("cannot_settle must not carry a provisional split", () => {
  const r = checkProposal({
    status: STATUS.CANNOT_SETTLE,
    reasoning: "The accounts cannot both be true and nothing obtainable separates them.",
    findings: [{ statement: "x", evidenceIds: ["pho-1"] }],
    provisional: { buyerPercent: 50, reasoning: "…" },
  }, bundle);
  assert.equal(r.ok, false);
  // Asserting only ok:false would still pass with CANNOT_SETTLE removed from
  // FIELDS entirely, because the reason would become "unknown status".
  assert.match(r.reason, /provisional/);
});

test("every request names at least two branches that do not all agree", () => {
  const same = needsEvidence({
    requests: [{
      what: "x", whyItMatters: "y", whoCanProvide: "buyer",
      wouldChange: [
        { answer: "a", implies: "p", split: 20 },
        { answer: "b", implies: "q", split: 20 },
      ],
    }],
  });
  const r = checkProposal(same, bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same split/);
});

// --- basis points: direction as well as scale ---

test("basis points carry the buyer's share, in the buyer's direction", () => {
  assert.equal(toBasisPoints(0), 0);
  assert.equal(toBasisPoints(100), 10000);
  // A refund of 40 on an item priced at 200 is a buyer share of 20%.
  assert.equal(toBasisPoints(20), 2000);
});

test("basis points reject anything outside the action space", () => {
  assert.throws(() => toBasisPoints(101));
  assert.throws(() => toBasisPoints(-1));
});

// --- display isolation ---

test("nothing shown to a party carries wouldChange or provisional", () => {
  const shown = JSON.stringify(forParty(needsEvidence()));
  assert.ok(!shown.includes("wouldChange"), "wouldChange leaked");
  assert.ok(!shown.includes("provisional"), "provisional leaked");
  assert.ok(!shown.includes("14"), "the provisional split leaked");
  // whyItMatters is the shown field and must survive.
  assert.match(shown, /distinguishes damage in transit/);
});

// --- the schema and the bounds are one description ---

// ⚠️ The schema describes one object, not three: it offers every field on every
// status, so `requests: []` alongside a proposal is a schema-legal answer. The
// bounds refused it as an unknown field, which burned the single retry and
// failed the whole case over a field carrying nothing at all.
test("a schema-legal field carrying nothing is not a rejection", () => {
  for (const extra of [{ requests: [] }, { provisional: null }, { reasoning: "" }]) {
    const r = checkProposal({ status: STATUS.PROPOSAL, buyerPercent: 20, reasoning: "r", findings: [], ...extra }, bundle);
    assert.equal(r.ok, true, `${JSON.stringify(extra)} was refused: ${r.reason}`);
  }
});

// The other half of the same rule: a field with content in it is the action
// space actually widening, and that is still refused.
test("a schema-legal field carrying content is still refused", () => {
  const r = checkProposal({
    status: STATUS.PROPOSAL,
    buyerPercent: 20,
    reasoning: "r",
    findings: [],
    requests: [{ what: "the carton", whyItMatters: "c", whoCanProvide: "buyer", wouldChange: [] }],
  }, bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /requests/);
});

// ⭐ The schema used to carry this bound and can no longer: minimum/maximum on
// a number is rejected by the API. A branch split is a percentage of the same
// pot as every other number here, and it reaches the record through the
// concluded path's `assumed`, so it is bounded where every other percentage is.
test("a request branch whose split is outside 0-100 is refused", () => {
  const r = checkProposal({
    status: "needs_evidence",
    provisional: { buyerPercent: 20, reasoning: "n" },
    requests: [{
      what: "a photograph of the outer carton",
      whyItMatters: "w",
      whoCanProvide: "buyer",
      wouldChange: [
        { answer: "intact", implies: "i", split: 20 },
        { answer: "crushed", implies: "i", split: 140 },
      ],
    }],
    findings: [],
  }, bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /0-100/);
});

// ⭐ The third description of the same action space, and the only one the model
// ever reads. The first live round returned a top-level buyerPercent on a
// needs_evidence answer, and another returned status "proposal" carrying
// requests — both refused by the bounds, both because the prompt never said
// which fields a status carries. A contract the model is not told is a contract
// it breaks, and the retry then spends the case's one second attempt on the
// same mistake.
test("the system prompt names every status and every field the bounds accept", () => {
  const prompt = readFileSync(new URL("../fixtures/case/system.md", import.meta.url), "utf8");
  const missing = [...new Set([...Object.keys(FIELDS), ...Object.values(FIELDS).flat()])]
    .filter((name) => name !== "status")
    .filter((name) => !prompt.includes(name));
  assert.deepEqual(missing, [], "the model is never told about these, so it fills them by guesswork");
});

// Two independently-maintained descriptions of the action space drift. This is
// the test that says so on the commit that does it, rather than on the first
// case that hits the difference.
test("the schema offers exactly the fields the bounds know about", () => {
  const offered = Object.keys(FORMAT.schema.properties).sort();
  const bounded = [...new Set(Object.values(FIELDS).flat())].sort();
  assert.deepEqual(offered, bounded);
});
