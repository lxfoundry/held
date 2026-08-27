// test/exchanges.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExchangeStore, SecretLeakError } from "../src/exchanges.mjs";

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
