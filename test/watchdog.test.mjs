// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchdog } from "../src/watchdog.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { ACTIONS } from "../src/adapter.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 7 * DAY;
const leads = { raiseMs: 48 * HOUR, escalateMs: 24 * HOUR };

const signed = {
  functionName: "raiseDispute(uint256)",
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
};

function harness({ recordOver = {}, chainOver = {}, withAuthorisations = true, relayImpl } = {}) {
  const exchanges = createExchangeStore(mkdtempSync(join(tmpdir(), "held-wd-x-")));
  const authorisations = createAuthorisationStore(mkdtempSync(join(tmpdir(), "held-wd-a-")));
  exchanges.put({
    exchangeId: "42",
    offerId: "120",
    configId: "testing-84532-0",
    trackerId: "tracker-1",
    trackingNumber: "MZ544750899GB",
    redeemedAt: 0,
    disputePeriodMs: PERIOD,
    resolutionPeriodMs: PERIOD,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeTimeoutAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: [],
    ...recordOver,
  });
  if (withAuthorisations) {
    authorisations.save("42", "raiseDispute", signed, 1);
    authorisations.save("42", "escalateDispute", signed, 2);
  }

  const relayed = [];
  const trackers = { read: () => ({ state: { current: "in_transit", delivered: false, everAvailableForPickup: false } }) };
  const watchdog = createWatchdog({
    exchanges,
    trackers,
    authorisations,
    readChainState: async () => ({
      finalisedAt: null,
      outcome: null,
      disputeRaisedAt: null,
      disputeRaisedBy: null,
      disputeTimeoutAt: null,
      escalatedAt: null,
      ...chainOver,
    }),
    relay: relayImpl ?? (async (stored) => { relayed.push(stored); return { transactionHash: "0xabc" }; }),
    leadsFor: () => leads,
    now: () => PERIOD - HOUR,
  });
  return { watchdog, exchanges, authorisations, relayed };
}

test("a healthy window relays nothing", async () => {
  const { watchdog, relayed } = harness({ recordOver: { disputePeriodMs: 90 * DAY } });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.NONE);
  assert.equal(relayed.length, 0);
});

test("a window nearing expiry relays the raise authorisation exactly once", async () => {
  const { watchdog, exchanges, authorisations, relayed } = harness();
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.RAISE);
  assert.equal(results[0].relayed, true);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].functionName, "raiseDispute(uint256)");
  // Spent, so discarded — and the record now says who raised it.
  assert.equal(authorisations.has("42", "raiseDispute"), false);
  assert.equal(exchanges.get("42").disputeRaisedBy, "watchdog");
});

test("a second sweep does not raise again", async () => {
  const { watchdog, relayed } = harness();
  await watchdog.sweep();
  await watchdog.sweep();
  assert.equal(relayed.length, 1);
});

test("an exchange with no authorisation is reported unprotected, not acted on", async () => {
  const { watchdog, relayed } = harness({ withAuthorisations: false });
  const results = await watchdog.sweep();
  assert.equal(results[0].unprotected, true);
  assert.equal(results[0].relayed, false);
  assert.equal(relayed.length, 0);
});

test("a failed relay keeps the authorisation for the next sweep", async () => {
  const { watchdog, exchanges, authorisations } = harness({
    relayImpl: async () => { throw new Error("relayer unavailable"); },
  });
  const results = await watchdog.sweep();
  assert.match(results[0].error, /relayer unavailable/);
  assert.equal(authorisations.has("42", "raiseDispute"), true);
  assert.equal(exchanges.get("42").disputeRaisedAt, null);
});

test("one exchange failing does not stop the sweep", async () => {
  const { watchdog, exchanges } = harness({
    relayImpl: async () => { throw new Error("relayer unavailable"); },
  });
  exchanges.put({ ...exchanges.get("42"), exchangeId: "43" });
  const results = await watchdog.sweep();
  assert.equal(results.length, 2);
});

test("the protocol is the authority: a dispute the buyer raised is not raised again", async () => {
  const { watchdog, exchanges, relayed } = harness({
    chainOver: { disputeRaisedAt: 1, disputeRaisedBy: "buyer", disputeTimeoutAt: 90 * DAY },
  });
  await watchdog.sweep();
  assert.equal(relayed.length, 0);
  assert.equal(exchanges.get("42").disputeRaisedBy, "buyer");
});

test("a finalised exchange is skipped", async () => {
  const { watchdog, relayed } = harness({ chainOver: { finalisedAt: 1, outcome: "paid" } });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.NONE);
  assert.equal(relayed.length, 0);
});

test("nothing but the two permitted actions is ever relayed", async () => {
  // The invariant, asserted at the only place a relay can happen.
  const { watchdog, relayed } = harness({
    chainOver: { disputeRaisedAt: 0, disputeRaisedBy: "buyer" },
  });
  await watchdog.sweep();
  for (const stored of relayed) {
    assert.ok(["raiseDispute", "escalateDispute"].includes(stored.action));
  }
});

test("a resolution window nearing expiry escalates and discards that authorisation", async () => {
  const { watchdog, exchanges, authorisations, relayed } = harness({
    chainOver: { disputeRaisedAt: 0, disputeRaisedBy: "buyer" },
  });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.ESCALATE);
  assert.equal(relayed.length, 1);
  assert.equal(authorisations.has("42", "escalateDispute"), false);
  assert.equal(authorisations.has("42", "raiseDispute"), true); // untouched
  assert.ok(exchanges.get("42").escalatedAt);
});
