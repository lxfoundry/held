import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaseFile } from "../src/clerk.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { ROOT } from "../src/env.mjs";

// Parcel A's real captured stream, through the real assembler. A hand-built
// bundle proves the clerk only against a shape written to match it — which is
// how a case file that dropped every genuine tracking event passed its tests.
const PARCEL_A = JSON.parse(
  readFileSync(join(ROOT, "fixtures/events/8645991e-538a-40a2-8618-6f9d3777a6ae.json"), "utf8"),
).events;

// The seller's message predates the first carrier scan, so the timeline is only
// right if it is actually sorted across kinds: assembly emits every tracking
// event before any message.
const bundle = assembleBundle({
  exchangeId: "241",
  tracking: { events: PARCEL_A },
  messages: [
    { from: "seller", at: Date.parse("2026-08-26T09:00:00Z"), text: "Posted this morning" },
    { from: "buyer", at: Date.parse("2026-08-29T09:00:00Z"), text: "It arrived damaged" },
  ],
  photos: [{ path: "fixtures/case/photos/inner.jpg", sha256: "aa" }],
});

const request = (what, whoCanProvide) => ({
  what,
  whyItMatters: "cause",
  whoCanProvide,
  wouldChange: [{ answer: "a", implies: "p", split: 20 }, { answer: "b", implies: "q", split: 8 }],
});

const caseRecord = {
  exchangeId: "241",
  rounds: [
    {
      requests: [request("the outer carton", "buyer")],
      provisional: { buyerPercent: 14, reasoning: "pending" },
      provided: [],
    },
  ],
  proposal: { status: "proposal", buyerPercent: 20, reasoning: "settled" },
};

test("the case file carries no proposed split anywhere", () => {
  const serialised = JSON.stringify(buildCaseFile({ bundle, caseRecord }));
  assert.ok(!serialised.includes("buyerPercent"), "a split reached the case file");
  assert.ok(!serialised.includes("provisional"), "a provisional reached the case file");
  assert.ok(!serialised.includes("wouldChange"), "the branches reached the case file");
  assert.ok(!serialised.includes("settled"), "the proposal's reasoning reached the case file");
});

test("every evidence item keeps its provenance and its authored mark", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  const msg = file.evidence.find((e) => e.id === "msg-1");
  assert.equal(msg.provenance, "seller");
  assert.equal(msg.authored, true);
  assert.equal(file.evidence.find((e) => e.id === "trk-1").authored, false);
});

test("a request that was never answered still appears, marked unanswered", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  assert.equal(file.requests.length, 1);
  assert.equal(file.requests[0].answered, false);
  assert.equal(file.requests[0].what, "the outer carton");
  assert.deepEqual(file.contested, ["the outer carton"]);
});

// The C1 regression: every real carrier event has occurrenceDatetime and no
// `at` of its own, so a timeline keyed off content.at was empty on real input.
test("the timeline carries every real tracking event", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  const events = file.timeline.filter((t) => t.id.startsWith("trk-"));
  assert.equal(events.length, PARCEL_A.length);
  assert.equal(file.timeline.length, PARCEL_A.length + 2, "the messages are missing");
  assert.ok(events.every((e) => typeof e.what === "string" && e.what.length > 0));
  assert.ok(events.some((e) => /delivered/i.test(e.what)), "no event reads as the delivery");
});

// ⚠️ Assembly emits all tracking events before any message, and the seller's
// message predates the first scan — so this fails if the sort is deleted.
test("the timeline is ordered across kinds, not just within one", () => {
  const { timeline } = buildCaseFile({ bundle, caseRecord });
  assert.equal(timeline[0].id, "msg-1", "the earliest item is not first");
  assert.deepEqual(timeline.map((t) => t.at), [...timeline.map((t) => t.at)].sort((a, b) => a - b));
});

// There is no seller-side interface, so a request addressed to the seller goes
// unanswered while the buyer answers theirs in the same round. Marking both
// answered tells the human decider the opposite of what happened.
test("evidence answers the request it names, not every request in the round", () => {
  const file = buildCaseFile({
    bundle,
    caseRecord: {
      exchangeId: "241",
      rounds: [{
        requests: [request("the outer carton", "buyer"), request("the seller's receipt", "seller")],
        provided: [{ what: "the outer carton", evidenceIds: ["pho-1"] }],
      }],
    },
  });
  assert.deepEqual(
    file.requests.map((r) => [r.what, r.answered]),
    [["the outer carton", true], ["the seller's receipt", false]],
  );
  assert.deepEqual(file.contested, ["the seller's receipt"]);
});
