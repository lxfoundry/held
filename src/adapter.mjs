// src/adapter.mjs
// Tracking state in, protocol action out.
//
// This is the whole of the mapping's protocol-action column, and it is
// deliberately pure: no chain, no filesystem, no ambient clock. Everything it
// needs arrives as an argument, so every row of the mapping is tested in
// milliseconds and none of it depends on a parcel or a network.
//
// It reads no raw event and no statusCode. What it consumes are the derived,
// sticky, never-regressing flags that src/store.mjs computes from the full
// event list — which is what makes out-of-order and duplicate pushes a
// non-issue here rather than a special case.

export const ACTIONS = {
  NONE: "none",
  RAISE: "raiseDispute",
  ESCALATE: "escalateDispute",
};

const HOUR = 3_600_000;

// Expressed as a fraction with a floor under it, so the relationship to the
// period holds if a period is ever configured longer than the protocol minimum.
// At the 7-day floor both resolve to the stated values: 48h and 24h.
export const RAISE_LEAD = { fraction: 2 / 7, floorMs: 48 * HOUR };
export const ESCALATE_LEAD = { fraction: 1 / 7, floorMs: 24 * HOUR };

export function leadMs(periodMs, { fraction, floorMs }) {
  return Math.max(Math.round(fraction * periodMs), floorMs);
}

// A lead approaching its period raises before a parcel could plausibly arrive,
// or escalates the instant a dispute is raised — so the parties never get the
// chance to settle between themselves and the cheapest path stops existing.
// A lead at or beyond the period is not a configuration, it is a mistake.
export function assertLeadSane(periodMs, ms, name) {
  if (!(ms > 0)) throw new Error(`${name} must be a positive number of milliseconds`);
  if (ms >= periodMs) {
    throw new Error(`${name} is ${ms}ms and must be shorter than the ${periodMs}ms period it guards`);
  }
  if (ms > periodMs / 2) {
    return [
      `${name} is ${ms}ms against a ${periodMs}ms period. That is a demonstration ` +
        "configuration and must not ship: say so wherever it is shown.",
    ];
  }
  return [];
}

export class MalformedRecordError extends Error {
  constructor(exchangeId, detail) {
    super(`exchange ${exchangeId}: ${detail}`);
    this.name = "MalformedRecordError";
  }
}

// ⚠️ Every way of getting a deadline wrong fails in the same direction, and it
// is the direction that pays the other party. NaN compares false against
// everything, so a missing period — or a timestamp that arrived as an ISO
// string, which is how every other timestamp in this codebase is written —
// makes `now >= dueAt - lead` false forever. The watchdog then stands down and
// reports a healthy window, which is indistinguishable from the parcel being
// fine right up until the money moves.
//
// So a deadline that cannot be computed is raised, never absorbed. The sweep
// catches per exchange, so one bad record becomes a visible `✗` instead of a
// silent no-op.
function ms(exchangeId, what, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MalformedRecordError(
      exchangeId,
      `${what} is ${JSON.stringify(value) ?? String(value)}, not a number of milliseconds`
    );
  }
  return value;
}

// The instant a lapsing resolution period pays the seller, with every field it
// is computed from guarded by `ms` above.
//
// ⭐ Exported because mediation runs inside this same window and must read the
// same instant. A second copy of this arithmetic elsewhere is two answers to
// when the money moves, and the copy without the guard is the one that reports
// a healthy window forever.
export function resolutionDueAt(record) {
  if (record?.disputeRaisedAt == null) return null;
  const id = record.exchangeId;
  return record.disputeTimeoutAt != null
    ? ms(id, "disputeTimeoutAt", record.disputeTimeoutAt)
    : ms(id, "disputeRaisedAt", record.disputeRaisedAt) +
      ms(id, "resolutionPeriodMs", record.resolutionPeriodMs);
}

export function decide({ tracking, record, now, leads }) {
  // ⚠️ Compared against null, not truthiness. These are timestamps, and a
  // timestamp of 0 is a real one — treating it as absent would silently ignore
  // a dispute in exactly the tests that pin this behaviour down.
  if (record.finalisedAt != null) {
    return { action: ACTIONS.NONE, reason: "the exchange is finalised", dueAt: null };
  }
  if (record.escalatedAt != null) {
    return { action: ACTIONS.NONE, reason: "already escalated; a person is deciding it", dueAt: null };
  }

  // One level down, the same asymmetry: a resolution period that lapses pays
  // the seller. Prefer the protocol's own timeout to anything computed here.
  if (record.disputeRaisedAt != null) {
    const dueAt = resolutionDueAt(record);
    const lead = ms(record.exchangeId, "the escalation lead", leads.escalateMs);

    // Past the deadline the protocol refuses the call, so continuing to report
    // it as required would have the sweep retrying a doomed relay every minute
    // while an operator reads "escalateDispute" and assumes it is in hand.
    if (now >= dueAt) {
      return { action: ACTIONS.NONE, reason: "the resolution window has closed", dueAt };
    }
    if (now >= dueAt - lead) {
      return { action: ACTIONS.ESCALATE, reason: "the resolution window is nearing expiry", dueAt };
    }
    return { action: ACTIONS.NONE, reason: "a dispute is open and its window is healthy", dueAt };
  }

  const dueAt =
    ms(record.exchangeId, "redeemedAt", record.redeemedAt) +
    ms(record.exchangeId, "disputePeriodMs", record.disputePeriodMs);

  // Tracking proves arrival, not condition — it cannot see a crushed box. So a
  // delivery scan only enables confirmation, and confirmation is the buyer's.
  if (tracking?.delivered) {
    return { action: ACTIONS.NONE, reason: "delivered; confirming belongs to the buyer", dueAt };
  }

  // The seller sent it, it arrived, and it was made available. Raising here
  // would accuse a seller who performed, on evidence that shows they did — and
  // would make non-collection a free option for the buyer. Sticky, so a later
  // return to sender does not revive it.
  if (tracking?.everAvailableForPickup) {
    return { action: ACTIONS.NONE, reason: "made available for collection; the seller performed", dueAt };
  }

  // No tracking at all falls through to the same branch as any other
  // non-delivery, and that is the point: a parcel that stops producing events
  // entirely is exactly what this exists for.
  const lead = ms(record.exchangeId, "the dispute-raise lead", leads.raiseMs);
  if (now >= dueAt) {
    return { action: ACTIONS.NONE, reason: "the window has closed", dueAt };
  }
  if (now >= dueAt - lead) {
    return { action: ACTIONS.RAISE, reason: "the window is nearing expiry and nothing was delivered", dueAt };
  }
  return { action: ACTIONS.NONE, reason: "the window is healthy", dueAt };
}
