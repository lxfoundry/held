// src/mediator.mjs
// One round is one call over one bundle. Rounds are not a conversation: each is
// independent, with its own hash and its own recording, which is why there can
// be several of them without any history to carry.

import { STATUS, checkProposal } from "./proposal.mjs";
import { ESCALATE_LEAD, leadMs, resolutionDueAt } from "./adapter.mjs";
import { UnusableModelResponse } from "./model.mjs";

// ⚠️ A constant, not a process.env read. Nothing in this repository reads
// process.env outside src/env.mjs: loadEnv parses .env without mutating the
// environment, so a module reading process.env directly never sees a value set
// in .env — MEDIATOR_MAX_ROUNDS=3 would silently do nothing — and it steps
// around loadEnv's `only` allowlist while it is at it. The composition root
// calls loadEnv and passes the value in.
export const DEFAULT_MAX_ROUNDS = 3;

// ⭐ One trigger: a dispute exists on the exchange. Delivery state, evidence
// quality and which rung of the ladder the case resembles have no part in it,
// and neither does who raised it — the watchdog on the buyer's behalf and the
// buyer directly produce the same fact. Rungs are outcomes, not code paths, so
// a rule deciding which disputes deserved mediation would be tracking-derived
// policy sitting exactly where the bounds exist to keep it out.
//
// The two exclusions are not such a rule. They are the same terminal facts the
// decision function already reads: rung four has the case, or it is finished.
// Mediation runs on every dispute that is still open.
export function shouldMediate(record) {
  if (record?.disputeRaisedAt == null) return false;
  return record.escalatedAt == null && record.finalisedAt == null;
}

// ⚠️ The deadline is the protocol's, not this component's. A resolution period
// that lapses pays the seller, and the watchdog already escalates a lead before
// that instant — so mediation runs inside a window something else guards, and
// reads the instant rather than starting a timer of its own.
//
// Both halves come from src/adapter.mjs for that reason: `resolutionDueAt`
// carries the malformed-record guard, and the lead is a fraction of the period
// with a floor under it. A constant 24h here would be correct only at the
// 7-day protocol floor — on a longer period the watchdog escalates first and
// the mediator carries on asking after rung 4 has taken the case.
export function deadlineFor(record, escalateLeadMs = null) {
  const dueAt = resolutionDueAt(record);
  if (dueAt == null) return null;
  const lead = escalateLeadMs ?? leadMs(record.resolutionPeriodMs, ESCALATE_LEAD);
  return dueAt - lead;
}

// What the mediator said it would settle on if nothing further arrived. The
// model committed to it at the moment of asking, which is why a deadline or an
// exhausted cap produces a decision rather than a number invented under time
// pressure.
const CONCLUDED_REASONING =
  "Nothing further was provided in time, so this is the split the evidence on file supports.";

// The request went unanswered, so the split stands on the evidence that exists.
// Naming the branch that split corresponds to is what makes the assumption
// auditable afterwards — and where no branch matches it exactly, recording that
// is more honest than rounding to the nearest one.
function assumedBranches(result) {
  const split = result.provisional?.buyerPercent;
  return (result.requests ?? []).map((req) => ({
    what: req.what,
    split,
    branch: (req.wouldChange ?? []).find((b) => b.split === split)?.answer ?? null,
  }));
}

// Falling back to the provisional is what makes a deadline or an exhausted cap
// produce a decision rather than an invented number: the model has already said
// what it would propose on the evidence it has.
function concludeFrom(result) {
  if (result.status !== STATUS.NEEDS_EVIDENCE) return result;
  return {
    status: STATUS.PROPOSAL,
    buyerPercent: result.provisional.buyerPercent,
    // ⚠️ Not `provisional.reasoning`. That string is written as an internal
    // note — the model is told the provisional is never shown — and promoting
    // it here renames the field on the way through, which is precisely where
    // forParty loses the ability to strip it. What a party is owed is what
    // actually happened, and that is the same sentence in every such case.
    reasoning: CONCLUDED_REASONING,
    findings: result.findings ?? [],
    // ⚠️ Carried, not dropped. The clerk runs on the cases mediation did not
    // close, which are exactly these — so a conclude path that discards the
    // requests discards them from every case file that needs them.
    requests: result.requests ?? [],
    assumed: assumedBranches(result),
  };
}

export async function mediate({
  bundle,
  record,
  now,
  deps,
  maxRounds = DEFAULT_MAX_ROUNDS,
  // Null means "derive it from the record". An explicit value is the same
  // override the watchdog takes from ESCALATION_LEAD_MS, so a demonstration
  // configuration moves both together or neither.
  escalateLeadMs = null,
  caseRecord = null,
  system = "",
  photos = [],
}) {
  // ⚠️ Derived from what has been recorded, never passed in and trusted.
  //
  // There is no loop here on purpose: a round asks a *person* for a photograph
  // and the answer arrives hours or days later, against a new bundle with a new
  // hash. Rounds are separate invocations, so the only durable count of them is
  // the case record — and a `round` argument the caller had to remember to
  // increment pinned every call at round one, which left the cap unreachable
  // and this component with no bound it actually owned.
  const round = (Array.isArray(caseRecord?.rounds) ? caseRecord.rounds.length : 0) + 1;
  const deadline = deadlineFor(record, escalateLeadMs);
  // A round that cannot be answered before the deadline must not ask for
  // anything, so it is run as a final round and concludes on what it has.
  const outOfTime = deadline != null && now >= deadline;
  const final = outOfTime || round >= maxRounds;

  // ⚠️ Decided before the cache is consulted, and applied to a replay too. A
  // recording holds what the model actually said - that is what makes it a
  // faithful replay - so the rule that a final round may not present a question
  // has to live here rather than in what gets written. Returning the recording
  // untouched would hand back an unanswerable question past the very deadline
  // this logic exists to respect.
  const cached = deps.recordings.find(bundle.hash);
  if (cached) {
    const replayed = final ? concludeFrom(cached.response) : cached.response;
    return { ...replayed, replayed: true };
  }

  // One retry, then fail the case rather than present something ungrounded.
  //
  // ⚠️ The retry covers both ways a call comes back unusable: a response that
  // fails its bounds, and one that never became a result at all — truncated,
  // refused, or not JSON. Retrying only the first left the likelier failure
  // with no second attempt.
  //
  // ⚠️ The model name arrives beside the answer, never inside it. checkProposal
  // refuses any key outside the schema, so a result carrying `model` would be
  // rejected as an unknown field — which is why reading it off the result would
  // record null for every case ever mediated.
  let model;
  let result;
  for (let attempt = 1; ; attempt += 1) {
    try {
      ({ model, result } = await deps.call({ bundle, system, photos, final }));
      const check = checkProposal(result, bundle);
      if (!check.ok) throw new UnusableModelResponse(check.reason);
      break;
    } catch (err) {
      if (attempt > 1 || !(err instanceof UnusableModelResponse)) throw err;
    }
  }

  deps.recordings.save(bundle.hash, { model, response: result });

  if (final) return { ...concludeFrom(result), replayed: false };
  return { ...result, replayed: false };
}
