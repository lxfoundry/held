// test/disputes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmedAt, raiseFor } from "../src/disputes.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { BUYER_STRINGS, parcelLine } from "../src/buyer-state.mjs";

const DAY = 86_400_000;
const PERIOD = 7 * DAY;
const BUYER = "0x1111111111111111111111111111111111111111";

const signedFor = (action) => ({
  functionName: `${action}(uint256)`,
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
});

// Real stores on a temporary directory, the same shape test/watchdog.test.mjs
// uses. The two stores enforce rules this module has to respect — a record may
// not carry a signature, an authorisation may not be filed under the wrong
// action — and faking them would test around exactly those rules.
function harness({ withAuthorisation = true, recordOver = {} } = {}) {
  const exchanges = createExchangeStore(mkdtempSync(join(tmpdir(), "held-dr-x-")));
  const authorisations = createAuthorisationStore(mkdtempSync(join(tmpdir(), "held-dr-a-")));
  exchanges.put({
    exchangeId: "241",
    offerId: "127",
    trackerId: "tracker-1",
    redeemedAt: 0,
    disputePeriodMs: PERIOD,
    resolutionPeriodMs: PERIOD,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeRaiseAttemptedAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: withAuthorisation ? ["raiseDispute", "escalateDispute"] : [],
    ...recordOver,
  });
  if (withAuthorisation) {
    authorisations.save("241", "raiseDispute", signedFor("raiseDispute"), { nonce: 1, userAddress: BUYER });
    authorisations.save("241", "escalateDispute", signedFor("escalateDispute"), { nonce: 2, userAddress: BUYER });
  }
  const relayed = [];
  return {
    exchanges,
    authorisations,
    relayed,
    relay: async (stored) => { relayed.push(stored); return { transactionHash: "0xabc" }; },
    confirm: async () => true,
    record: () => exchanges.get("241"),
  };
}

test("the buyer's raise is attributed before the relay, so a lost confirmation keeps it", async () => {
  const h = harness();
  await assert.rejects(
    raiseFor({
      exchangeId: "241",
      by: "buyer",
      exchanges: h.exchanges,
      authorisations: h.authorisations,
      relay: async () => { throw new Error("relay timed out"); },
      confirm: h.confirm,
    }),
    /relay timed out/
  );
  const record = h.record();
  assert.equal(record.disputeRaisedBy, "buyer", "attribution was not on disk before the relay was attempted");
  assert.equal(typeof record.disputeRaiseAttemptedAt, "number");
  assert.equal(record.disputeRaisedAt, null, "a dispute the protocol never confirmed was recorded as raised");
});

test("a confirmed raise is recorded, and the buyer reads their own words back", async () => {
  const h = harness();
  await raiseFor({
    exchangeId: "241",
    by: "buyer",
    exchanges: h.exchanges,
    authorisations: h.authorisations,
    relay: h.relay,
    confirm: h.confirm,
  });
  const record = h.record();
  assert.equal(record.disputeRaisedBy, "buyer");
  assert.equal(record.disputeRaisedAt > 0, true);
  assert.equal(h.relayed.length, 1);
  assert.equal(h.relayed[0].action, "raiseDispute");
  assert.equal(
    parcelLine({ tracking: { current: "delivered", delivered: true }, record }).text,
    BUYER_STRINGS.sorting_out,
    "a buyer who said something was wrong was told the system had raised it for them"
  );
});

test("the authorisation is discarded only after the protocol confirms", async () => {
  const h = harness();
  await assert.rejects(
    raiseFor({
      exchangeId: "241",
      by: "buyer",
      exchanges: h.exchanges,
      authorisations: h.authorisations,
      relay: h.relay,
      confirm: async () => { throw new Error("reverted"); },
    }),
    /reverted/
  );
  assert.equal(
    h.authorisations.has("241", "raiseDispute"),
    true,
    "the buyer's only signature was thrown away on a transaction that did not land"
  );
});

test("a spent authorisation leaves neither the file nor the record claiming it", async () => {
  const h = harness();
  await raiseFor({
    exchangeId: "241",
    by: "buyer",
    exchanges: h.exchanges,
    authorisations: h.authorisations,
    relay: h.relay,
    confirm: h.confirm,
  });
  assert.equal(h.authorisations.has("241", "raiseDispute"), false);
  assert.deepEqual(
    h.record().authorisations,
    ["escalateDispute"],
    "the record still tells an operator this exchange is protected by a signature that is gone"
  );
});

test("an exchange with no stored authorisation refuses rather than pretending", async () => {
  const h = harness({ withAuthorisation: false });
  await assert.rejects(
    raiseFor({
      exchangeId: "241",
      by: "buyer",
      exchanges: h.exchanges,
      authorisations: h.authorisations,
      relay: h.relay,
      confirm: h.confirm,
    }),
    /no raiseDispute authorisation/
  );
  assert.equal(h.relayed.length, 0);
  assert.equal(h.record().disputeRaisedBy, null, "a raise that never happened was attributed to somebody");
});

test("a raise already recorded by the watchdog is not relabelled as the buyer's", async () => {
  // The mirror of the watchdog's own guard, and the same defect in the other
  // direction: confirm() cannot tell whose dispute it is looking at, so a
  // watchdog raise that landed first answers the buyer's confirm too. Whoever
  // recorded a completed raise owns the attribution; this one arrived second.
  const h = harness();
  await raiseFor({
    exchangeId: "241",
    by: "buyer",
    exchanges: h.exchanges,
    authorisations: h.authorisations,
    relay: async (stored) => {
      h.exchanges.update("241", { disputeRaisedAt: 1, disputeRaisedBy: "watchdog" });
      return { transactionHash: "0xabc", stored };
    },
    confirm: h.confirm,
  });
  const record = h.record();
  assert.equal(record.disputeRaisedBy, "watchdog", "the watchdog's raise was relabelled as the buyer's");
  assert.equal(record.disputeRaisedAt, 1, "and its time was overwritten");
  assert.equal(
    record.authorisations.includes("raiseDispute"),
    false,
    "the spent signature is still listed as protecting the exchange"
  );
});

test("a raise the watchdog completed before this one started keeps its attribution", async () => {
  // The third write that claims attribution, and the one the guard above did not
  // reach. The pre-relay write is unconditional, and its comment argues it is
  // safe because the buyer's line is gated on disputeRaisedAt — but that gate is
  // exactly what has already opened here. The watchdog completed a raise, so the
  // date is set, and relabelling it turns "We've raised this for you" into "Let's
  // sort this out" for a raise the buyer never made.
  //
  // ⚠️ Nothing repairs it afterwards: the relay reverts on the spent nonce, so
  // the post-confirm guard never runs, and the watchdog's own guard requires
  // disputeRaisedBy to be null.
  const h = harness({ recordOver: { disputeRaisedAt: 1, disputeRaisedBy: "watchdog" } });
  await assert.rejects(
    raiseFor({
      exchangeId: "241",
      by: "buyer",
      exchanges: h.exchanges,
      authorisations: h.authorisations,
      relay: async () => { throw new Error("nonce already used"); },
      confirm: h.confirm,
      now: () => 5 * DAY,
    }),
    /nonce already used/
  );
  const record = h.record();
  assert.equal(record.disputeRaisedBy, "watchdog", "the watchdog's raise was relabelled as the buyer's");
  assert.equal(
    parcelLine({ tracking: null, record }).key,
    "raised_for_you",
    "the buyer is being told to sort out a raise the watchdog made for them"
  );
  // ⭐ The attempt is still recorded. It is what stops the next sweep finding a
  // dispute this system has no attempt on record for and leaving it unattributed.
  assert.equal(record.disputeRaiseAttemptedAt, 5 * DAY);
});

// ── The recorded time is the protocol's, not this process's ───────────────────

test("the buyer's raise is recorded at the time the protocol gives, not this process's clock", async () => {
  // ⚠️ The two differ by more than latency once a record has been rewritten by
  // `seed --adopt`: the chain can have held the dispute for a day while this
  // record reads as undisputed, and now() would date it to now.
  const h = harness();
  await raiseFor({
    exchangeId: "241",
    by: "buyer",
    exchanges: h.exchanges,
    authorisations: h.authorisations,
    relay: h.relay,
    confirm: async () => 3 * DAY,
    now: () => 5 * DAY,
  });
  const record = h.record();
  assert.equal(record.disputeRaisedAt, 3 * DAY, "the raise was recorded on this process's clock instead");
  // ⭐ And the attempt keeps this process's clock. It records when this system
  // submitted, as against when the protocol recorded it — that gap is the whole
  // of its use, so taking the chain's answer for both would erase it.
  assert.equal(record.disputeRaiseAttemptedAt, 5 * DAY);
});

test("a confirm that reports no time still records one", async () => {
  // Green before this change as well as after — see the twin in
  // test/watchdog.test.mjs for what it stops.
  const h = harness();
  await raiseFor({
    exchangeId: "241",
    by: "buyer",
    exchanges: h.exchanges,
    authorisations: h.authorisations,
    relay: h.relay,
    confirm: h.confirm,
    now: () => 5 * DAY,
  });
  assert.equal(h.record().disputeRaisedAt, 5 * DAY);
});

// ── Reading a confirmation back off the protocol ──────────────────────────────

// Enough of a BigNumber for what confirmedAt does with one. The production
// values arrive from ethers, and `Number(bn)` is how every chain read in this
// codebase converts them.
const seconds = (value) => ({ isZero: () => value === 0, toString: () => String(value) });
const onChain = ({ exists = true, disputed = 0, escalated = 0 } = {}) => ({
  exists,
  disputeDates: { disputed: seconds(disputed), escalated: seconds(escalated) },
});

test("confirmedAt reads back the raise date the protocol recorded, in milliseconds", () => {
  assert.equal(confirmedAt(onChain({ disputed: 1_756_000_000 }), "raiseDispute"), 1_756_000_000_000);
});

test("confirmedAt reads back the escalation date for an escalation", () => {
  const dispute = onChain({ disputed: 1_756_000_000, escalated: 1_756_000_060 });
  assert.equal(confirmedAt(dispute, "escalateDispute"), 1_756_000_060_000);
});

test("confirmedAt reports nothing for an action the protocol has not recorded", () => {
  // ⚠️ Null, not zero and not false. It is what waitForState polls on, so "not
  // yet" reading as a time would have the caller record a raise that has not
  // happened — and a raise dated to the epoch.
  assert.equal(confirmedAt(onChain({ disputed: 1_756_000_000 }), "escalateDispute"), null);
  assert.equal(confirmedAt(onChain(), "raiseDispute"), null);
  assert.equal(confirmedAt(onChain({ exists: false, disputed: 1_756_000_000 }), "raiseDispute"), null);
});
