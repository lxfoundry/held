import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProposal, toBasisPoints, forParty, STATUS } from "../src/proposal.mjs";

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
