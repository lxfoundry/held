// test/buyer-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { moneyLine, parcelLine, BUYER_STRINGS, fill } from "../src/buyer-state.mjs";

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

// I-6: the third branch was a fall-through, so a finalised record with no
// outcome — or one this module has never heard of — asserted "Seller has been
// paid" on a record that says nothing of the sort. src/exchanges.mjs skips null
// fields on write and get() does not validate, so the absence is reachable.
test("an outcome this module does not recognise states no ending at all", () => {
  for (const outcome of [undefined, null, "", "refunded", 0]) {
    const line = moneyLine(record({ finalisedAt: 1, outcome }), { priceText: "200", currency: "£" });
    assert.equal(line.key, "held", `outcome ${JSON.stringify(outcome)} must not read as paid`);
    assert.equal(line.meta, null);
  }
});

// I-7: the same fall-through I-6 fixes on the money line, unfixed on this one.
// Every row of the parcel table is a positive claim and the last of them is
// unconditional, so a record whose tracker resolves to no snapshot at all
// asserted "On its way" about a parcel nothing has scanned — and on a finalised
// record it said so directly beneath "Seller has been paid".
test("no tracking at all states no parcel state", () => {
  assert.equal(parcelLine({ tracking: null, record: record() }).key, "no_tracking");
  assert.equal(
    parcelLine({ tracking: null, record: record({ finalisedAt: 1, outcome: "paid" }) }).key,
    "no_tracking",
    "a finalised purchase must not claim the parcel is moving"
  );
});

// ⚠️ A tracker that exists and has not been scanned yet, which is a different
// thing from no tracker at all — the assertion about that moved to the test
// above when the two stopped sharing an answer.
test("a registered parcel with no events yet is on its way", () => {
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

test("a split ending states the amount that came back, not that the money was returned", () => {
  const settled = record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 });
  const line = moneyLine(settled, { priceText: "200", currency: "£" });
  assert.equal(line.key, "split");
  assert.equal(line.text, "£40 has come back to you.");
});

test("0 and 100 percent remain the two clean endings", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "paid", buyerPercent: 0 })).key, "paid");
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "returned", buyerPercent: 100 })).key, "returned");
});

test("held survives, and is what an unfinalised exchange reads whatever else is set", () => {
  assert.equal(moneyLine(record({ outcome: null })).key, "held");
  assert.equal(moneyLine(record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" })).key, "held");
});

test("a split with no price says the fraction rather than inventing an amount", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }));
  assert.equal(line.text, "20% has come back to you.");
});

test("a split naming no percentage states nothing about the money", () => {
  // The shape of every record finalised before buyerPercent was written, and
  // the one src/exchanges.mjs neither refuses to write nor validates on read.
  // `price * null / 100` is 0, so this used to read "£0 has come back to you."
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split" }), {
    priceText: "200",
    currency: "£",
  });
  assert.equal(line.key, "held");
  assert.equal(line.meta, null);
});

test("a split whose price is not a number says the fraction, not £NaN", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }), {
    priceText: "1,200",
    currency: "£",
  });
  assert.equal(line.text, "20% has come back to you.");
});

test("a split with a non-integer refund formats to two decimal places", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split", buyerPercent: 33 }), { priceText: "150", currency: "£" });
  assert.equal(line.text, "£49.50 has come back to you.");
});

test("held carries no second line", () => {
  assert.equal(moneyLine(record()).meta, null);
});

test("paid states the price and the date it settled", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "paid", buyerPercent: 0 }), {
    priceText: "200",
    currency: "£",
    finalisedDate: "19 September",
  });
  assert.equal(line.meta, "£200 · 19 September");
});

test("returned states the price, back to the buyer", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "returned", buyerPercent: 100 }), {
    priceText: "200",
    currency: "£",
  });
  assert.equal(line.meta, "£200 · back to you");
});

test("split states that the seller has been paid the rest", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }), {
    priceText: "200",
    currency: "£",
  });
  assert.equal(line.meta, "The seller has been paid the rest.");
});

test("a settlement's parcel line states the fact, never an open process that is over", () => {
  const delivered = tracking({ current: "delivered", delivered: true });

  const split = parcelLine({
    tracking: delivered,
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", finalisedAt: 2, outcome: "split", buyerPercent: 20 }),
  });
  assert.equal(split.key, "arrived");

  const escalatedThenFinalised = parcelLine({
    tracking: delivered,
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", escalatedAt: 2, finalisedAt: 3, outcome: "paid", buyerPercent: 0 }),
  });
  assert.equal(escalatedThenFinalised.key, "arrived");
});

test("a watchdog-raised dispute still reads as raised for you once it finalises", () => {
  const line = parcelLine({
    tracking: tracking(),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "watchdog", finalisedAt: 2, outcome: "returned", buyerPercent: 100 }),
  });
  assert.equal(line.key, "raised_for_you");
  assert.match(line.text, /raised this for you/);
});

test("fill replaces every placeholder and leaves nothing unresolved", () => {
  assert.equal(fill("paid on {date}", { date: "19 September" }), "paid on 19 September");
  assert.throws(() => fill("paid on {date}", {}), /date/);
});

// The atomic flow exists precisely so none of these words ever need to appear.
const FORBIDDEN =
  /\b(voucher|rNFT|redeem\w*|escrow\w*|commit\w*|exchange\w*|dispute\w*|offer\w*|wallet|on-chain|onchain|blockchain|smart contract|token|gas|transaction|protocol)\b/i;

test("no user-visible string contains protocol vocabulary", () => {
  const found = JSON.stringify(BUYER_STRINGS).match(FORBIDDEN);
  assert.equal(found, null, `forbidden vocabulary: ${found}`);
});

// ⭐ The other half of the rule, and until now the unguarded half. The
// constraint is that every user-visible string lives in BUYER_STRINGS, which is
// enforced structurally by walking this module — and a sentence typed straight
// into the markup is invisible to that walk. public/ is exactly where a hurried
// edit puts one, so it is read here.
//
// ⚠️ String literals only, for held.js. Its identifiers and its operator
// diagnostics are not drawn — `m.exchangeId` names a field, and console.error
// is read by whoever runs this and never by a buyer — so scanning the raw
// source would fail on text that reaches no screen, and a test that cannot pass
// gets deleted rather than fixed. A template's interpolations are dropped for
// the same reason: `${m.exchangeId}` is a value, `?purchase=` is the authored
// text around it, and only the authored text is the rule's business.
test("⭐ no authored string in public/ contains protocol vocabulary either", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ROOT } = await import("../src/env.mjs");

  const dir = join(ROOT, "public");
  const files = readdirSync(dir);
  // A rename that emptied this directory would leave the test green while
  // guarding nothing, so what it read is asserted before what it found.
  assert.ok(files.includes("held.js") && files.includes("index.html"), `public/ holds ${files}`);

  const LITERAL = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8");
    const authored = name.endsWith(".js")
      ? [...source.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n").matchAll(LITERAL)]
          .map((m) => m[1] ?? m[2] ?? m[3])
          .flatMap((literal) => literal.split(/\$\{[^}]*\}/))
      : [source];
    for (const text of authored) {
      const found = text.match(FORBIDDEN);
      assert.equal(found, null, `${name} says "${found}" in ${JSON.stringify(text)}`);
    }
  }
});

test("every string is present and none is empty", () => {
  for (const [key, text] of Object.entries(BUYER_STRINGS)) {
    assert.ok(typeof text === "string" && text.length > 0, `${key} is empty`);
  }
});
