// test/disputes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raiseFor } from "../src/disputes.mjs";
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
