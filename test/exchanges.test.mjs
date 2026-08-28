// test/exchanges.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExchangeStore, SecretLeakError } from "../src/exchanges.mjs";
import { MalformedRecordError } from "../src/adapter.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "held-exchanges-"));

const record = (over = {}) => ({
  exchangeId: "42",
  offerId: "120",
  configId: "testing-84532-0",
  trackerId: "8645991e-538a-40a2-8618-6f9d3777a6ae",
  trackingNumber: "MZ544750899GB",
  redeemedAt: 1_756_300_000_000,
  disputePeriodMs: 604_800_000,
  resolutionPeriodMs: 604_800_000,
  disputeRaisedAt: null,
  disputeRaisedBy: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  outcome: null,
  authorisations: ["raiseDispute", "escalateDispute"],
  ...over,
});

test("a record round-trips", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  assert.equal(store.get("42").trackingNumber, "MZ544750899GB");
});

test("update merges and leaves everything else alone", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  const updated = store.update("42", { disputeRaisedAt: 5, disputeRaisedBy: "watchdog" });
  assert.equal(updated.disputeRaisedAt, 5);
  assert.equal(updated.offerId, "120");
  assert.equal(store.get("42").disputeRaisedBy, "watchdog");
});

test("update on an unknown id throws rather than creating a half record", () => {
  const store = createExchangeStore(freshDir());
  assert.throws(() => store.update("99", { finalisedAt: 1 }), /unknown/);
});

test("get on an unknown id is null, not an error", () => {
  assert.equal(createExchangeStore(freshDir()).get("99"), null);
});

test("all returns every record", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  store.put(record({ exchangeId: "43" }));
  assert.deepEqual(store.all().map((r) => r.exchangeId).sort(), ["42", "43"]);
});

test("byTracker finds the exchange a parcel belongs to", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  assert.equal(store.byTracker("8645991e-538a-40a2-8618-6f9d3777a6ae").exchangeId, "42");
  assert.equal(store.byTracker("nothing"), null);
});

test("a record carrying signature material is refused", () => {
  // These files are ordinary state and anything may read them. A bearer
  // instrument must not be able to arrive here by accident.
  const store = createExchangeStore(freshDir());
  for (const leak of [
    { signature: "0xdead" },
    { functionSignature: "0xdead" },
    { r: "0x1" },
    { sigV: 27 },
    { privateKey: "0x1" },
    { nested: { mnemonic: "one two three" } },
  ]) {
    assert.throws(() => store.put(record(leak)), SecretLeakError);
  }
});

test("the refusal happens before anything is written", () => {
  const store = createExchangeStore(freshDir());
  assert.throws(() => store.put(record({ signature: "0xdead" })), SecretLeakError);
  assert.equal(store.get("42"), null);
});

test("authorisations are recorded by name only", () => {
  const dir = freshDir();
  const store = createExchangeStore(dir);
  store.put(record());
  const raw = readFileSync(join(dir, "42.json"), "utf8");
  assert.match(raw, /raiseDispute/);
  assert.equal(/0x[0-9a-f]{64}/i.test(raw), false);
});

// ── The record contract ───────────────────────────────────────────────────────

test("a timestamp that is not a number is refused at the point of writing", () => {
  // ⚠️ Caught here because past this point it reaches arithmetic, and a wrong
  // type there produces NaN, which stands the watchdog down without a word.
  // Every other timestamp in this codebase is written as an ISO string, so this
  // is the mistake the next producer will actually make.
  const store = createExchangeStore(freshDir());
  for (const bad of [
    { redeemedAt: "2026-08-20T00:00:00Z" },
    { disputePeriodMs: "7d" },
    { resolutionPeriodMs: "604800000" },
    { finalisedAt: Number.NaN },
  ]) {
    assert.throws(() => store.put(record(bad)), MalformedRecordError, JSON.stringify(bad));
  }
});

test("null stays legal, because absent is a real state", () => {
  const store = createExchangeStore(freshDir());
  store.put(record({ disputeRaisedAt: null, finalisedAt: null }));
  assert.equal(store.get("42").disputeRaisedAt, null);
});

test("a signature is refused by its shape, not only by its field name", () => {
  // A field name nobody predicted is exactly how one gets in.
  const store = createExchangeStore(freshDir());
  assert.throws(
    () => store.put(record({ receipt: `0x${"a".repeat(130)}` })),
    SecretLeakError
  );
  // A transaction hash is 32 bytes and is a reasonable thing to record, so the
  // rule deliberately stops short of forbidding it.
  store.put(record({ relayTxHash: `0x${"a".repeat(64)}` }));
});

test("one unreadable file does not take the readable ones with it", () => {
  const store = createExchangeStore(freshDir());
  store.put(record({ exchangeId: "42" }));
  store.put(record({ exchangeId: "43" }));
  writeFileSync(join(store.dir, "99.json"), "{ truncated");

  assert.deepEqual(store.all().map((r) => r.exchangeId).sort(), ["42", "43"]);
  assert.deepEqual(store.unreadable(), ["99"]);
});

test("a zero period is refused, because it silently disarms the watchdog", () => {
  // ⚠️ The way in, observed: a read-back that lands on an RPC node one block
  // behind. getOffer returns a truthy result with exists:false and every
  // duration zeroed, so a caller checking truthiness records 0 as fact.
  //
  // Zero is finite, so the number check passes it — and downstream it is
  // silent and expensive: dueAt collapses onto redeemedAt, every sweep reads
  // "the window has closed", no dispute is ever raised, and the buyer pays in
  // full when the real window lapses.
  const store = createExchangeStore(freshDir());
  for (const bad of [
    { disputePeriodMs: 0 },
    { resolutionPeriodMs: 0 },
    { disputePeriodMs: -1 },
  ]) {
    assert.throws(() => store.put(record(bad)), MalformedRecordError, JSON.stringify(bad));
  }
});
