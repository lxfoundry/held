// test/buyer-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { moneyLine, parcelLine, BUYER_STRINGS } from "../src/buyer-state.mjs";

const record = (over = {}) => ({
  exchangeId: "1",
  redeemedAt: 0,
  disputePeriodMs: 7 * 86_400_000,
  resolutionPeriodMs: 7 * 86_400_000,
  disputeRaisedAt: null,
  disputeRaisedBy: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  outcome: null,
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

test("money is held until the exchange finalises", () => {
  assert.equal(moneyLine(record()).key, "held");
});

test("a completed exchange says the seller has been paid", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "paid" })).key, "paid");
});

test("a refunded exchange says the money has been returned", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "returned" })).key, "returned");
});

test("a parcel with no events yet is on its way", () => {
  assert.equal(parcelLine({ tracking: null, record: record() }).key, "on_its_way");
  assert.equal(parcelLine({ tracking: tracking({ current: "pending" }), record: record() }).key, "on_its_way");
});

test("a parcel waiting at a collection point asks the buyer to act", () => {
  const line = parcelLine({
    tracking: tracking({ current: "available_for_pickup", everAvailableForPickup: true }),
    record: record(),
  });
  assert.equal(line.key, "waiting_for_collection");
});

test("a failed attempt asks the buyer to act too", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "failed_attempt" }), record: record() }).key,
    "needs_you"
  );
});

test("an exception says we are looking into it, and promises nothing", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "exception" }), record: record() }).key,
    "looking_into_it"
  );
});

test("a delivered parcel says it arrived", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "delivered", delivered: true }), record: record() }).key,
    "arrived"
  );
});

test("a dispute raised for the buyer says so plainly", () => {
  const line = parcelLine({
    tracking: tracking(),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "watchdog" }),
  });
  assert.equal(line.key, "raised_for_you");
  assert.match(line.text, /raised this for you/);
});

test("a dispute the buyer raised themselves reads differently", () => {
  const line = parcelLine({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
  });
  assert.equal(line.key, "sorting_out");
});

test("an escalated dispute says a person is looking at it", () => {
  const line = parcelLine({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", escalatedAt: 2 }),
  });
  assert.equal(line.key, "with_a_person");
});

test("no user-visible string contains protocol vocabulary", () => {
  // The atomic flow exists precisely so none of these words ever need to appear.
  const forbidden =
    /\b(voucher|rNFT|redeem\w*|escrow\w*|commit\w*|exchange\w*|dispute\w*|offer\w*|wallet|on-chain|onchain|blockchain|smart contract|token|gas|transaction|protocol)\b/i;
  const found = JSON.stringify(BUYER_STRINGS).match(forbidden);
  assert.equal(found, null, `forbidden vocabulary: ${found}`);
});

test("every string is present and none is empty", () => {
  for (const [key, text] of Object.entries(BUYER_STRINGS)) {
    assert.ok(typeof text === "string" && text.length > 0, `${key} is empty`);
  }
});
