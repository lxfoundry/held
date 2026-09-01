import { test } from "node:test";
import assert from "node:assert/strict";
import { mediate, deadlineFor } from "../src/mediator.mjs";
import { STATUS, forParty } from "../src/proposal.mjs";
import { ESCALATE_LEAD, MalformedRecordError, leadMs } from "../src/adapter.mjs";
import { UnusableModelResponse } from "../src/model.mjs";

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

// ⚠️ The clerk runs on exactly the cases mediation did not close — the cap
// exhausted, the deadline reached — so a conclude path that drops `requests`
// drops them from every case the clerk exists for. Spec §6: every request
// across every round appears in the case file, answered or not.
test("concluding on the provisional keeps the requests that went unanswered", async () => {
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(asking), recordings: recordings() },
  });
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.deepEqual(out.requests.map((r) => r.what), ["the carton"]);
});

// Spec §5.1: an unanswered request degrades into a decision, and the mediator
// records which branch it assumed.
test("concluding records the branch it assumed", async () => {
  const matched = {
    ...asking,
    provisional: { buyerPercent: 20, reasoning: "pending" },
  };
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(matched), recordings: recordings() },
  });
  assert.deepEqual(out.assumed, [{ what: "the carton", split: 20, branch: "a" }]);
});

// ⚠️ `provisional.reasoning` is written as an internal note — spec §5.1 says a
// provisional is never shown to a party, and the model is told nothing about
// that string being read by anyone. Promoting it to the shown `reasoning`
// renames the field on the way through, which is exactly where forParty stops
// being able to catch it.
test("the internal note is never promoted to the shown reasoning", async () => {
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(asking), recordings: recordings() },
  });
  assert.notEqual(out.reasoning, "pending");
  assert.ok(out.reasoning.length > 0, "a conclusion with no reasoning at all");
});

test("nothing internal survives the party projection of a concluded question", async () => {
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(asking), recordings: recordings() },
  });
  const shown = JSON.stringify(forParty(out));
  assert.ok(!shown.includes("wouldChange"), "the branches reached a party");
  assert.ok(!shown.includes("provisional"), "a provisional reached a party");
  assert.ok(!shown.includes("assumed"), "the assumed branch reached a party");
  assert.ok(!shown.includes("pending"), "the internal note reached a party");
});

// ⚠️ src/adapter.mjs raises on a deadline it cannot compute rather than
// absorbing it, because NaN compares false against everything: a mediator that
// swallowed a malformed record would keep asking for evidence, past the
// instant the money moves, and look healthy doing it.
test("a record whose deadline cannot be computed is refused, not absorbed", () => {
  assert.throws(
    () => deadlineFor({ exchangeId: "241", disputeRaisedAt: 0, disputeTimeoutAt: null }),
    MalformedRecordError,
  );
});

test("a malformed record stops the mediator rather than letting it ask on", async () => {
  await assert.rejects(
    mediate({
      bundle,
      record: { exchangeId: "241", disputeRaisedAt: 0, resolutionPeriodMs: "7 days" },
      now: 999 * DAY,
      deps: { call: answering(asking), recordings: recordings() },
    }),
    MalformedRecordError,
  );
});

// ⚠️ The lead is a fraction of the period with a floor under it, and the
// watchdog computes it that way. A constant 24h is only correct at the 7-day
// protocol floor: on a longer period the watchdog escalates before the
// mediator's deadline, so the mediator keeps asking after rung 4 took over.
test("the escalation lead follows the resolution period, not a constant", () => {
  const period = 28 * DAY;
  assert.equal(leadMs(period, ESCALATE_LEAD), 4 * DAY);
  assert.equal(
    deadlineFor(record({ resolutionPeriodMs: period })),
    period - leadMs(period, ESCALATE_LEAD),
  );
});

// ⚠️ The retry has to cover a malformed response, not only an ungrounded one.
// A truncated or refused call is the likelier of the two, and it used to
// propagate straight out of mediate and fail the case on the first attempt
// while a merely ungrounded answer got a second chance.
test("an unusable response is retried once, then fails the case", async () => {
  let calls = 0;
  await assert.rejects(
    mediate({
      bundle, record: record(), now: 0,
      deps: {
        call: async () => { calls += 1; throw new UnusableModelResponse("truncated"); },
        recordings: recordings(),
      },
    }),
    UnusableModelResponse,
  );
  assert.equal(calls, 2);
});

test("a retry that comes back usable settles the case", async () => {
  let calls = 0;
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: {
      call: async () => {
        calls += 1;
        if (calls === 1) throw new UnusableModelResponse("truncated");
        return { model: "claude-opus-5", result: proposal };
      },
      recordings: recordings(),
    },
  });
  assert.equal(calls, 2);
  assert.equal(out.status, STATUS.PROPOSAL);
});
