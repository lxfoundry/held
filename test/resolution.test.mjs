import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settle } from "../src/resolution.mjs";
import { createConsentStore } from "../src/consents.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "held-"));

const seeded = (over = {}) => {
  const exchanges = createExchangeStore(temp());
  exchanges.put({ exchangeId: "241", redeemedAt: 1, disputePeriodMs: 100, resolutionPeriodMs: 100,
    disputeRaisedAt: 9, disputeRaisedBy: "buyer", disputeTimeoutAt: null, escalatedAt: null,
    finalisedAt: null, outcome: null, buyerPercent: null, authorisations: ["escalateDispute"], ...over });
  return exchanges;
};

const consented = (over = {}) => {
  const consents = createConsentStore(temp());
  consents.save("241", {
    buyerPercent: 25,
    buyerPercentBasisPoints: 2500,
    signedBy: "0x541af8Fd1a80F3Cc5D87Eae6b21b25E9A395035d",
    r: "0xcd6fb3a5f860d335db10271be408f40569c07950a0286b16547dc23fb0080829",
    s: "0x4c5c5885247c19014e728bd775794d615d1e4b60810631cdc8c0e3024f4368d3",
    v: 27,
    ...over,
  });
  return consents;
};

const never = { resolve: () => assert.fail("must not reach the chain") };
// settle() only ever calls discard() and list() on the authorisation store, and
// only once the chain has confirmed. Real disk access is exercised by that
// store's own test file, not this one.
const fakeAuthorisations = () => ({ discard: () => {}, list: () => [] });
const settledAt = (basisPoints) =>
  ({ resolve: async () => ({ finalisedAt: 1234, buyerPercentBasisPoints: basisPoints }) });

const run = (over = {}) => settle({
  exchangeId: "241", buyerPercent: 25,
  exchanges: seeded(), consents: consented(), authorisations: fakeAuthorisations(),
  chain: never, execute: false, ...over,
});

// --- refuse before the chain, not after --------------------------------------

test("without execute nothing is signed, submitted or written", async () => {
  const exchanges = seeded();
  const result = await run({ exchanges });
  assert.equal(result.planned, true);
  assert.equal(result.buyerPercent, 25);
  assert.equal(exchanges.get("241").finalisedAt, null);
});

test("no local record refuses, and the chain is never reached", async () => {
  await assert.rejects(
    () => run({ exchanges: createExchangeStore(temp()), execute: true }),
    /unknown exchange/
  );
});

test("a finalised exchange refuses rather than settling twice", async () => {
  await assert.rejects(
    () => run({ exchanges: seeded({ finalisedAt: 5, outcome: "paid", buyerPercent: 0 }), execute: true }),
    /already finalised/
  );
});

// resolveDispute reverts on an exchange with no dispute open. Saying so plainly
// beats a person reading a revert reason for a mistake this cheap to catch.
test("an undisputed exchange refuses: there is no dispute to resolve", async () => {
  await assert.rejects(
    () => run({ exchanges: seeded({ disputeRaisedAt: null, disputeRaisedBy: null }), execute: true }),
    /no dispute/
  );
});

// Once a case is with a person, the split they decide is theirs to decide. The
// protocol refuses a mutual resolution on an escalated dispute, and one that
// slipped past would take the decision back off them.
test("an escalated exchange refuses: a person is deciding it", async () => {
  await assert.rejects(
    () => run({ exchanges: seeded({ escalatedAt: 11 }), execute: true }),
    /escalated/
  );
});

test("an exchange nobody has consented to refuses before the chain", async () => {
  await assert.rejects(
    () => run({ consents: createConsentStore(temp()), execute: true }),
    /no consent/i
  );
});

// The property that makes this safe to route from a browser: the buyer can only
// settle at the number they were shown. A consent at any other split is not
// consent to this proposal.
test("a consent at a different split cannot settle the proposal on screen", async () => {
  await assert.rejects(
    () => run({
      buyerPercent: 25,
      consents: consented({ buyerPercent: 30, buyerPercentBasisPoints: 3000 }),
      execute: true,
    }),
    /30/
  );
});

test("settling without naming a split refuses rather than taking whatever is on disk", async () => {
  await assert.rejects(() => run({ buyerPercent: null, execute: true }), /which split/i);
});

// The consent store is reached *after* the money has moved, so an omitted
// argument would surface as a TypeError with the pot already split and the
// record never written — the same reasoning src/completion.mjs gives for
// checking its authorisation store among the preconditions.
test("executing without a consent store to discard refuses before the chain", async () => {
  const readOnly = { read: () => consented().read("241") };
  await assert.rejects(() => run({ consents: readOnly, execute: true }), /discard/);
});

// --- write the record only after the protocol confirms -----------------------

test("a rejecting chain leaves the record and the consent exactly as it found them", async () => {
  const exchanges = seeded();
  const consents = consented();
  const chain = { resolve: async () => { throw new Error("relay failed"); } };
  await assert.rejects(
    () => settle({ exchangeId: "241", buyerPercent: 25, exchanges, consents,
      authorisations: fakeAuthorisations(), chain, execute: true }),
    /relay failed/
  );
  const record = exchanges.get("241");
  assert.equal(record.finalisedAt, null);
  assert.equal(record.outcome, null);
  // Still spendable. A transaction whose confirmation timed out may yet have
  // landed, and the record is reconciled from chain truth on the next sweep —
  // discarding here would destroy the consent for a settlement that never
  // happened, and it cannot be produced again without the counterparty.
  assert.equal(consents.read("241").buyerPercent, 25);
});

test("a confirmed settlement records the split the protocol produced", async () => {
  const exchanges = seeded();
  const result = await settle({ exchangeId: "241", buyerPercent: 25, exchanges, consents: consented(),
    authorisations: fakeAuthorisations(), chain: settledAt(2500), execute: true });

  assert.equal(result.planned, false);
  assert.equal(result.outcome, "split");
  assert.equal(result.buyerPercent, 25);

  const record = exchanges.get("241");
  assert.equal(record.finalisedAt, 1234);
  assert.equal(record.outcome, "split");
  assert.equal(record.buyerPercent, 25);
});

// The protocol's number, not the one that was asked for. They agree on every
// path that works; where they do not, the record must state what happened.
test("the recorded outcome comes from the protocol, not from the request", async () => {
  const exchanges = seeded();
  const result = await settle({ exchangeId: "241", buyerPercent: 25, exchanges, consents: consented(),
    authorisations: fakeAuthorisations(), chain: settledAt(10000), execute: true });
  assert.equal(result.outcome, "returned");
  assert.equal(exchanges.get("241").outcome, "returned");
  assert.equal(exchanges.get("241").buyerPercent, 100);
});

test("a settled consent cannot be replayed", async () => {
  const consents = consented();
  await settle({ exchangeId: "241", buyerPercent: 25, exchanges: seeded(), consents,
    authorisations: fakeAuthorisations(), chain: settledAt(2500), execute: true });
  assert.equal(consents.read("241"), null);
});

// The exchange is over, so a held escalateDispute signature authorises an action
// that can no longer happen — a liability with no upside.
test("a settled exchange keeps none of its standing authorisations", async () => {
  const exchanges = seeded();
  const discarded = [];
  const authorisations = { discard: (_id, action) => discarded.push(action), list: () => [] };
  await settle({ exchangeId: "241", buyerPercent: 25, exchanges, consents: consented(),
    authorisations, chain: settledAt(2500), execute: true });
  assert.deepEqual(discarded.sort(), ["escalateDispute", "raiseDispute"]);
  assert.deepEqual(exchanges.get("241").authorisations, []);
});
