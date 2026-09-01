// src/mediator.mjs
// One round is one call over one bundle. Rounds are not a conversation: each is
// independent, with its own hash and its own recording, which is why there can
// be several of them without any history to carry.

import { STATUS, checkProposal } from "./proposal.mjs";

const DEFAULT_MAX_ROUNDS = Number(process.env.MEDIATOR_MAX_ROUNDS ?? 3);

// ⚠️ The deadline is the protocol's, not this component's. A resolution period
// that lapses pays the seller, and the watchdog already escalates a lead before
// that instant — so mediation runs inside a window something else guards, and
// reads the instant rather than starting a timer of its own.
export function deadlineFor(record, escalateLeadMs) {
  if (record?.disputeRaisedAt == null) return null;
  const expiry = record.disputeTimeoutAt != null
    ? record.disputeTimeoutAt
    : record.disputeRaisedAt + record.resolutionPeriodMs;
  return expiry - escalateLeadMs;
}

// Falling back to the provisional is what makes a deadline or an exhausted cap
// produce a decision rather than an invented number: the model has already said
// what it would propose on the evidence it has.
function concludeFrom(result) {
  if (result.status !== STATUS.NEEDS_EVIDENCE) return result;
  return {
    status: STATUS.PROPOSAL,
    buyerPercent: result.provisional.buyerPercent,
    reasoning: result.provisional.reasoning,
    findings: result.findings ?? [],
  };
}

export async function mediate({
  bundle,
  record,
  now,
  deps,
  maxRounds = DEFAULT_MAX_ROUNDS,
  escalateLeadMs = 86_400_000,
  round = 1,
  system = "",
  photos = [],
}) {
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

  // ⚠️ The model name arrives beside the answer, never inside it. checkProposal
  // refuses any key outside the schema, so a result carrying `model` would be
  // rejected as an unknown field — which is why reading it off the result would
  // record null for every case ever mediated.
  let { model, result } = await deps.call({ bundle, system, photos, final });
  let check = checkProposal(result, bundle);

  if (!check.ok) {
    // One retry, then fail the case rather than present something ungrounded.
    ({ model, result } = await deps.call({ bundle, system, photos, final }));
    check = checkProposal(result, bundle);
    if (!check.ok) throw new Error(`the mediator returned an unusable result: ${check.reason}`);
  }

  deps.recordings.save(bundle.hash, { model, response: result });

  if (final) return { ...concludeFrom(result), replayed: false };
  return { ...result, replayed: false };
}
