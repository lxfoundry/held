import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaseFile } from "../src/clerk.mjs";

const bundle = {
  exchangeId: "241",
  hash: "b".repeat(64),
  items: [
    { id: "trk-1", kind: "tracking_event", provenance: "carrier", authored: false, content: { at: 1, description: "Delivered" } },
    { id: "msg-1", kind: "message", provenance: "seller", authored: true, content: { at: 2, text: "Posted" } },
  ],
};

const caseRecord = {
  exchangeId: "241",
  rounds: [
    {
      requests: [{ what: "the carton", whyItMatters: "cause", whoCanProvide: "buyer", wouldChange: [{ answer: "a", implies: "p", split: 20 }, { answer: "b", implies: "q", split: 8 }] }],
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
});

test("a request that was never answered still appears, marked unanswered", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  assert.equal(file.requests.length, 1);
  assert.equal(file.requests[0].answered, false);
  assert.equal(file.requests[0].what, "the carton");
});

test("the timeline is ordered", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  assert.deepEqual(file.timeline.map((t) => t.at), [1, 2]);
});
