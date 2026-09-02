import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../src/completion.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { PERMITTED_ACTIONS } from "../src/authorisations.mjs";

const store = () => createExchangeStore(mkdtempSync(join(tmpdir(), "held-")));

// A minimal stand-in for src/authorisations.mjs's real store: complete() only
// ever calls discard() on it, once the chain has confirmed. Real disk access
// is exercised by src/authorisations.mjs's own test file, not this one.
const fakeAuthorisations = () => ({ discard: () => {} });

const seeded = (exchanges, over = {}) => {
  exchanges.put({ exchangeId: "241", redeemedAt: 1, disputePeriodMs: 100, resolutionPeriodMs: 100,
    disputeRaisedAt: null, disputeRaisedBy: null, disputeTimeoutAt: null, escalatedAt: null,
    finalisedAt: null, outcome: null, buyerPercent: null, authorisations: [], ...over });
  return exchanges;
};

test("without execute nothing is signed and the record is untouched", async () => {
  const exchanges = seeded(store());
  const chain = { complete: () => assert.fail("must not reach the chain") };
  const result = await complete({ exchangeId: "241", exchanges, chain, execute: false });
  assert.equal(result.planned, true);
  assert.equal(exchanges.get("241").finalisedAt, null);
});

test("a finalised exchange refuses rather than paying twice", async () => {
  const exchanges = seeded(store(), { finalisedAt: 5, outcome: "paid", buyerPercent: 0 });
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, chain: {}, execute: true }),
    /already finalised/
  );
});

test("a disputed exchange refuses: completing would end a dispute in progress", async () => {
  const exchanges = seeded(store(), { disputeRaisedAt: 9, disputeRaisedBy: "buyer" });
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, chain: {}, execute: true }),
    /dispute/
  );
});

test("no local record refuses, and the chain is never reached", async () => {
  const exchanges = store(); // deliberately not seeded — exchange 241 is unknown here
  const chain = { complete: () => assert.fail("must not reach the chain") };
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, chain, execute: true }),
    /unknown exchange/
  );
});

test("a rejecting chain leaves the record exactly as it found it", async () => {
  const exchanges = seeded(store(), { authorisations: PERMITTED_ACTIONS });
  const chain = { complete: async () => { throw new Error("relay failed"); } };
  const authorisations = { discard: () => assert.fail("must not discard on a rejected chain call") };
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, authorisations, chain, execute: true }),
    /relay failed/
  );
  const record = exchanges.get("241");
  assert.equal(record.finalisedAt, null);
  assert.equal(record.outcome, null);
  assert.deepEqual(record.authorisations, PERMITTED_ACTIONS);
});

test("executing records the outcome the protocol reported", async () => {
  const exchanges = seeded(store());
  const chain = { complete: async () => ({ finalisedAt: 1234, paid: "0.2" }) };
  const result = await complete({ exchangeId: "241", exchanges, authorisations: fakeAuthorisations(), chain, execute: true });
  assert.equal(result.finalisedAt, 1234);
  const record = exchanges.get("241");
  assert.equal(record.finalisedAt, 1234);
  assert.equal(record.outcome, "paid");
  assert.equal(record.buyerPercent, 0);
  assert.deepEqual(record.authorisations, []);
});
