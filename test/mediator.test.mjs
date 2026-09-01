import { test } from "node:test";
import assert from "node:assert/strict";
import { mediate, deadlineFor } from "../src/mediator.mjs";
import { STATUS } from "../src/proposal.mjs";

const DAY = 86_400_000;
const bundle = { exchangeId: "241", hash: "a".repeat(64), items: [{ id: "pho-1" }] };
const record = (over = {}) => ({
  exchangeId: "241",
  disputeRaisedAt: 0,
  resolutionPeriodMs: 7 * DAY,
  disputeTimeoutAt: null,
  ...over,
});

const recordings = () => {
  const map = new Map();
  return { find: (h) => map.get(h) ?? null, save: (h, v) => map.set(h, v) };
};

// deps.call reports { model, result }: the model beside the answer, because the
// answer is schema-bound and cannot carry it.
const answering = (result, model = "claude-opus-5") => async () => ({ model, result });

const proposal = { status: STATUS.PROPOSAL, buyerPercent: 20, reasoning: "r", findings: [] };
const asking = {
  status: STATUS.NEEDS_EVIDENCE,
  requests: [{
    what: "the carton", whyItMatters: "cause", whoCanProvide: "buyer",
    wouldChange: [{ answer: "a", implies: "p", split: 20 }, { answer: "b", implies: "q", split: 8 }],
  }],
  provisional: { buyerPercent: 14, reasoning: "pending" },
  findings: [],
};

test("the deadline is the escalation instant, from the record", () => {
  assert.equal(deadlineFor(record(), DAY), 7 * DAY - DAY);
});

test("the protocol's own timeout wins over the computed one", () => {
  assert.equal(deadlineFor(record({ disputeTimeoutAt: 3 * DAY }), DAY), 2 * DAY);
});

test("a proposal comes straight back", async () => {
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: { call: answering(proposal), recordings: recordings() },
  });
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.replayed, false);
});

test("a matching hash replays and never calls the model", async () => {
  const store = recordings();
  store.save(bundle.hash, { model: "m", response: proposal });
  let called = false;
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: { call: async () => { called = true; }, recordings: store },
  });
  assert.equal(called, false);
  assert.equal(out.replayed, true);
  assert.equal(out.buyerPercent, 20);
});

test("the final round is told it is final and may not ask", async () => {
  let sawFinal = false;
  const out = await mediate({
    bundle, record: record(), now: 0, maxRounds: 1,
    deps: {
      call: async ({ final }) => { sawFinal = final; return { model: "claude-opus-5", result: asking }; },
      recordings: recordings(),
    },
  });
  assert.equal(sawFinal, true);
  // It asked anyway; the mediator falls back to the provisional rather than
  // presenting a question nobody can answer.
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.buyerPercent, 14);
});

test("past the deadline it does not ask, it concludes", async () => {
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(asking), recordings: recordings() },
  });
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.buyerPercent, 14);
});

test("an ungrounded response is retried once, then fails the case", async () => {
  let calls = 0;
  const bad = { ...proposal, findings: [{ statement: "x", evidenceIds: ["nope"] }] };
  await assert.rejects(
    mediate({
      bundle, record: record(), now: 0,
      deps: { call: async () => { calls += 1; return { model: "claude-opus-5", result: bad }; }, recordings: recordings() },
    }),
    /not in the bundle/,
  );
  assert.equal(calls, 2);
});

test("cannot_settle is returned as it is", async () => {
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: {
      call: answering({ status: STATUS.CANNOT_SETTLE, reasoning: "r", findings: [] }),
      recordings: recordings(),
    },
  });
  assert.equal(out.status, STATUS.CANNOT_SETTLE);
});

// The recording stores what the model actually said, which is its job. The
// policy that a final round may not present a question has to be applied on
// the replay path too, or a recorded needs_evidence comes back past its
// deadline as a question nobody can answer.
test("a replayed question past the deadline still concludes", async () => {
  const store = recordings();
  store.save(bundle.hash, { model: "m", response: asking });
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: async () => { throw new Error("must not call the model"); }, recordings: store },
  });
  assert.equal(out.replayed, true);
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.buyerPercent, 14);
});

test("a replayed question with rounds still available stays a question", async () => {
  const store = recordings();
  store.save(bundle.hash, { model: "m", response: asking });
  const out = await mediate({
    bundle, record: record(), now: 0, maxRounds: 3,
    deps: { call: async () => { throw new Error("must not call the model"); }, recordings: store },
  });
  assert.equal(out.replayed, true);
  assert.equal(out.status, STATUS.NEEDS_EVIDENCE);
});

// The spec requires a case to state which model produced its proposal. The
// model name cannot arrive on the result itself: checkProposal's field
// allowlist rejects any key outside the schema, so a result carrying `model`
// would be refused as an unknown field. It has to come from the caller.
test("the recording captures which model produced it", async () => {
  const store = recordings();
  await mediate({
    bundle, record: record(), now: 0,
    deps: { call: answering(proposal), recordings: store },
  });
  assert.equal(store.find(bundle.hash).model, "claude-opus-5");
});
