// test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, decide, leadMs, assertLeadSane, RAISE_LEAD, ESCALATE_LEAD, MalformedRecordError, outcomeFor,
} from "../src/adapter.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 7 * DAY;
const leads = { raiseMs: 48 * HOUR, escalateMs: 24 * HOUR };

// Purchase at 0, so `now` reads as time since purchase.
const record = (over = {}) => ({
  exchangeId: "1",
  redeemedAt: 0,
  disputePeriodMs: PERIOD,
  resolutionPeriodMs: PERIOD,
  disputeRaisedAt: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  ...over,
});

const tracking = (over = {}) => ({
  current: "in_transit",
  delivered: false,
  everAvailableForPickup: false,
  observed: ["in_transit"],
  eventCount: 1,
  lastEventAt: null,
  ...over,
});

const HEALTHY = 3 * DAY;        // well inside a 7-day window
const NEARING = PERIOD - HOUR;  // inside the 48h lead

test("a parcel in transit inside its window needs nothing", () => {
  const { action } = decide({ tracking: tracking(), record: record(), now: HEALTHY, leads });
  assert.equal(action, ACTIONS.NONE);
});

test("a window nearing expiry with no delivery raises a dispute", () => {
  const { action } = decide({ tracking: tracking(), record: record(), now: NEARING, leads });
  assert.equal(action, ACTIONS.RAISE);
});

test("idle is not healthy: a tracker that has produced nothing still raises", () => {
  // The case the watchdog exists for — a deadline cannot be driven by the
  // arrival of a message that never comes.
  const { action } = decide({ tracking: null, record: record(), now: NEARING, leads });
  assert.equal(action, ACTIONS.RAISE);
});

test("an exception inside the window does not raise early", () => {
  // Raising forfeits the remaining window, and exceptions are frequently transient.
  const { action } = decide({
    tracking: tracking({ current: "exception", observed: ["in_transit", "exception"] }),
    record: record(),
    now: HEALTHY,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("an exception at the deadline raises, like any other non-delivery", () => {
  const { action } = decide({
    tracking: tracking({ current: "exception", observed: ["in_transit", "exception"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.RAISE);
});

test("a failed attempt still raises: nothing was made available to anyone", () => {
  const { action } = decide({
    tracking: tracking({ current: "failed_attempt", observed: ["in_transit", "failed_attempt"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.RAISE);
});

test("delivered takes no action, whatever the clock says", () => {
  // Tracking proves arrival, not condition. Confirming belongs to the buyer.
  const { action } = decide({
    tracking: tracking({ current: "delivered", delivered: true, observed: ["in_transit", "delivered"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a parcel made available for collection stands the watchdog down", () => {
  const { action, reason } = decide({
    tracking: tracking({
      current: "available_for_pickup",
      everAvailableForPickup: true,
      observed: ["in_transit", "available_for_pickup"],
    }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
  assert.match(reason, /performed/);
});

test("the stand-down is sticky: a later return to sender does not revive it", () => {
  // A naive reading of the current milestone would raise at exactly the moment
  // the buyer's own non-collection caused the return.
  const { action } = decide({
    tracking: tracking({
      current: "exception",
      everAvailableForPickup: true,
      observed: ["available_for_pickup", "exception"],
    }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("an open dispute inside its resolution window needs nothing", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0 }),
    now: HEALTHY,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a resolution window nearing expiry escalates", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0 }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.ESCALATE);
});

test("the protocol's own timeout wins over the computed one", () => {
  const { action, dueAt } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0, disputeTimeoutAt: 30 * DAY }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
  assert.equal(dueAt, 30 * DAY);
});

test("an escalated dispute is left to the person deciding it", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0, escalatedAt: DAY }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a finalised exchange is never acted on", () => {
  const { action } = decide({ tracking: null, record: record({ finalisedAt: DAY }), now: NEARING, leads });
  assert.equal(action, ACTIONS.NONE);
});

test("statusCode is not read: a hostile one changes nothing", () => {
  for (const statusCode of ["delivered", "transit_handover", "", null]) {
    const { action } = decide({
      tracking: tracking({ statusCode }),
      record: record(),
      now: NEARING,
      leads,
    });
    assert.equal(action, ACTIONS.RAISE);
  }
});

test("no milestone can produce an action outside the permitted three", () => {
  const milestones = [
    "pending", "info_received", "in_transit", "out_for_delivery", "failed_attempt",
    "available_for_pickup", "delivered", "exception", "something_new",
  ];
  const permitted = new Set(Object.values(ACTIONS));
  for (const current of milestones) {
    for (const now of [0, HEALTHY, NEARING, PERIOD * 2]) {
      const { action } = decide({ tracking: tracking({ current }), record: record(), now, leads });
      assert.ok(permitted.has(action), `${current} at ${now} produced ${action}`);
    }
  }
});

test("the lead is a fraction of the period with a floor under it", () => {
  assert.equal(leadMs(PERIOD, RAISE_LEAD), 48 * HOUR);
  assert.equal(leadMs(21 * DAY, RAISE_LEAD), 6 * DAY);
  assert.equal(leadMs(PERIOD, ESCALATE_LEAD), 24 * HOUR);
});

test("a lead at or beyond its period is impossible and throws", () => {
  assert.throws(() => assertLeadSane(PERIOD, PERIOD, "DISPUTE_RAISE_LEAD"), /must be shorter/);
});

test("a lead over half its period is allowed but warns", () => {
  const warnings = assertLeadSane(PERIOD, PERIOD - 60_000, "DISPUTE_RAISE_LEAD");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /demonstration/i);
  assert.equal(assertLeadSane(PERIOD, 48 * HOUR, "DISPUTE_RAISE_LEAD").length, 0);
});

// ── The threshold itself ──────────────────────────────────────────────────────
// The existing cases sit 47 hours past the trip point, so `>` instead of `>=`,
// or a lead applied to the wrong period, would pass every one of them. These
// pin the boundary to the millisecond.

test("the raise threshold trips exactly at dueAt minus the lead", () => {
  const at = (now) => decide({ tracking: tracking(), record: record(), now, leads }).action;
  const trip = PERIOD - leads.raiseMs;
  assert.equal(at(trip - 1), ACTIONS.NONE);
  assert.equal(at(trip), ACTIONS.RAISE);
  assert.equal(at(trip + 1), ACTIONS.RAISE);
});

test("the escalate threshold trips exactly at dueAt minus the lead", () => {
  const disputed = record({ disputeRaisedAt: 0, disputeTimeoutAt: null });
  const at = (now) => decide({ tracking: tracking(), record: disputed, now, leads }).action;
  const trip = PERIOD - leads.escalateMs;
  assert.equal(at(trip - 1), ACTIONS.NONE);
  assert.equal(at(trip), ACTIONS.ESCALATE);
  assert.equal(at(trip + 1), ACTIONS.ESCALATE);
});

test("a window already closed stands down instead of relaying forever", () => {
  // The protocol refuses the call once the period has elapsed, so continuing to
  // report it as required has the sweep retrying a doomed relay every minute
  // while an operator reads "raiseDispute" and assumes it is in hand.
  const closed = decide({ tracking: tracking(), record: record(), now: PERIOD + 10 * DAY, leads });
  assert.equal(closed.action, ACTIONS.NONE);
  assert.match(closed.reason, /closed/);

  const disputed = record({ disputeRaisedAt: 0, disputeTimeoutAt: null });
  const late = decide({ tracking: tracking(), record: disputed, now: PERIOD + 10 * DAY, leads });
  assert.equal(late.action, ACTIONS.NONE);
  assert.match(late.reason, /closed/);
});

// ── Malformed records ─────────────────────────────────────────────────────────

test("a deadline that cannot be computed is raised, never reported as healthy", () => {
  // ⚠️ Every one of these used to return "the window is healthy" and stand the
  // watchdog down for good, because NaN compares false against everything. The
  // failure was invisible and in the direction that pays the other party.
  const cases = [
    ["redeemedAt missing", record({ redeemedAt: undefined })],
    ["disputePeriodMs missing", record({ disputePeriodMs: undefined })],
    ["redeemedAt as an ISO string", record({ redeemedAt: "2026-08-20T00:00:00Z" })],
    ["resolutionPeriodMs missing while disputed", record({ disputeRaisedAt: 0, disputeTimeoutAt: null, resolutionPeriodMs: null })],
  ];
  for (const [what, bad] of cases) {
    assert.throws(
      () => decide({ tracking: tracking(), record: bad, now: NEARING, leads }),
      MalformedRecordError,
      what
    );
  }
});

test("a lead that is not a number is raised rather than silently standing down", () => {
  // DISPUTE_RAISE_LEAD_MS=48h reaches here as NaN.
  assert.throws(
    () => decide({ tracking: tracking(), record: record(), now: NEARING, leads: { raiseMs: NaN, escalateMs: NaN } }),
    MalformedRecordError
  );
});

test("basis points become the three endings, and a percentage the view can render", () => {
  assert.deepEqual(outcomeFor(0), { outcome: "paid", buyerPercent: 0 });
  assert.deepEqual(outcomeFor(10000), { outcome: "returned", buyerPercent: 100 });
  assert.deepEqual(outcomeFor(2000), { outcome: "split", buyerPercent: 20 });
  assert.deepEqual(outcomeFor(9999), { outcome: "split", buyerPercent: 99.99 });
});
