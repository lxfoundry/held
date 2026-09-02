// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchdog } from "../src/watchdog.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { ACTIONS } from "../src/adapter.mjs";
import { BUYER_STRINGS, parcelLine } from "../src/buyer-state.mjs";
import { CorruptSnapshotError } from "../src/store.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 7 * DAY;
const leads = { raiseMs: 48 * HOUR, escalateMs: 24 * HOUR };

const BUYER = "0x1111111111111111111111111111111111111111";

const signedFor = (action) => ({
  functionName: `${action}(uint256)`,
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
});

function harness({
  recordOver = {},
  chainOver = {},
  withAuthorisations = true,
  relayImpl,
  confirmImpl,
  trackersImpl,
  wrapExchanges,
} = {}) {
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
    authorisations.save("42", "raiseDispute", signedFor("raiseDispute"), { nonce: 1, userAddress: BUYER });
    authorisations.save("42", "escalateDispute", signedFor("escalateDispute"), { nonce: 2, userAddress: BUYER });
  }

  const relayed = [];
  const trackers = trackersImpl ?? { read: () => ({ state: { current: "in_transit", delivered: false, everAvailableForPickup: false } }) };
  const watchdog = createWatchdog({
    // Wrapped only where a test needs the store to move under the sweep — the
    // real one otherwise, and the real one is always what a test reads back.
    exchanges: wrapExchanges ? wrapExchanges(exchanges) : exchanges,
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
    confirm: confirmImpl ?? (async () => true),
    leadsFor: () => leads,
    now: () => PERIOD - HOUR,
  });
  // `chainOver` is spread when readChainState is called, not when the harness is
  // built, so a test can mutate it between sweeps to represent the protocol
  // learning something — which is the only way to exercise a relay that landed
  // after this process had already given up on confirming it.
  return { watchdog, exchanges, authorisations, relayed, chain: chainOver };
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
  // Gone too, and not because escalating touched it: this exchange's dispute
  // was raised by the buyer, and a dispute that exists cannot be raised again.
  // Before F2 this asserted `true` — the raise signature outlived every
  // possible use for it.
  assert.equal(authorisations.has("42", "raiseDispute"), false);
  assert.ok(exchanges.get("42").escalatedAt);
});

// ── The relay landing, as opposed to being accepted ───────────────────────────

test("a relay that did not land keeps the authorisation and records nothing", async () => {
  // ⚠️ The bug this pins down: relaying resolves when the relayer accepted the
  // transaction, not when the protocol recorded it. A meta-transaction that
  // reverts comes back through the same path as one that succeeded — so
  // without the read-back the watchdog deleted the buyer's only signature,
  // wrote down that the dispute was raised, and never tried again.
  const { watchdog, exchanges, authorisations, relayed } = harness({
    confirmImpl: async () => { throw new Error("raiseDispute was not recorded for exchange 42"); },
  });

  const [result] = await watchdog.sweep();

  assert.equal(relayed.length, 1, "it did relay");
  assert.equal(result.relayed, false, "but it is not reported as relayed");
  assert.match(result.error, /not recorded/);

  // The two things that must survive a failed relay.
  assert.equal(authorisations.has("42", "raiseDispute"), true, "the authorisation is kept");
  assert.equal(exchanges.get("42").disputeRaisedAt, null, "no raise is recorded");
});

test("a watchdog without a way to confirm is refused outright", () => {
  // Defaulting this to a no-op would restore the silent-success bug, so it is
  // required rather than optional.
  assert.throws(
    () => createWatchdog({ exchanges: {}, trackers: {}, authorisations: {}, readChainState: async () => ({}), relay: async () => {}, leadsFor: () => leads }),
    /needs a confirm\(\)/
  );
});

test("the authorisation is discarded only once the action is confirmed", async () => {
  const order = [];
  const { watchdog, authorisations } = harness({
    relayImpl: async () => { order.push("relay"); },
    confirmImpl: async () => {
      order.push("confirm");
      assert.equal(authorisations.has("42", "raiseDispute"), true, "still held while confirming");
    },
  });
  await watchdog.sweep();
  assert.deepEqual(order, ["relay", "confirm"]);
  assert.equal(authorisations.has("42", "raiseDispute"), false);
});

// ── One bad file must not disarm the whole sweep ──────────────────────────────

test("a corrupt record is reported and the others are still swept", async () => {
  // ⚠️ This used to throw out of exchanges.all(), which is outside the
  // per-exchange catch — so one truncated file killed every subsequent sweep
  // and nothing was protected from that moment on.
  const { watchdog, exchanges } = harness();
  writeFileSync(join(exchanges.dir, "99.json"), "{ truncated");

  const results = await watchdog.sweep();

  const corrupt = results.find((r) => r.exchangeId === "99");
  assert.ok(corrupt?.unreadable, "the unreadable record is reported, not skipped in silence");
  assert.ok(results.some((r) => r.exchangeId === "42" && r.action === ACTIONS.RAISE),
    "and the exchange whose window is closing is still acted on");
});

test("a finalised exchange has its authorisations discarded, not left on disk", async () => {
  // The spec is "discard on use, or once the exchange completes". Only the
  // first half existed, so a settled exchange kept live bearer instruments
  // indefinitely — signatures nobody needs and anybody holding could relay.
  const { watchdog, authorisations } = harness({ chainOver: { finalisedAt: 1_000 } });
  assert.deepEqual(authorisations.list("42").sort(), ["escalateDispute", "raiseDispute"]);

  await watchdog.sweep();

  assert.deepEqual(authorisations.list("42"), []);
});

test("an unreadable tracker snapshot raises anyway, rather than disarming the exchange", async () => {
  // ⚠️ A corrupt snapshot used to throw out of trackers.read(), through step()
  // and into the per-exchange catch: the exchange was reported as an error and
  // never acted on, so the window could lapse in the seller's favour on the
  // strength of a file nobody could parse. An unreadable snapshot is an absence
  // of delivery evidence, so it takes the same branch as no tracking at all.
  const { watchdog, relayed } = harness({
    trackersImpl: {
      read: () => { throw new CorruptSnapshotError("/snapshots/tracker-1.json", "Unexpected end of JSON input"); },
    },
  });

  const [result] = await watchdog.sweep();

  assert.equal(result.trackingUnreadable, true, "the unreadable snapshot is reported, not swallowed");
  assert.equal(result.action, ACTIONS.RAISE, "and the nearing deadline is still acted on");
  assert.equal(result.relayed, true);
  assert.equal(relayed.length, 1);
});

// ── The three end-to-end findings, 28 August ──────────────────────────────────
//
// All three came out of one real event: Infura timed out on
// eth_getTransactionReceipt mid-relay for exchange 236, so tx.wait() threw on a
// transaction that had actually landed. The read-back did its job and refused
// to record an unconfirmed raise — but the dispute existed on chain from that
// moment, and the next sweep had no way to know this watchdog was the one that
// raised it.

test("F1 · a raise that landed but could not be confirmed is still attributed to the watchdog", async () => {
  // ⚠️ Buyer-facing, and the headline promise: disputeRaisedBy was written only
  // on the confirmed path, so this dispute read as buyer-raised and the buyer
  // was told "Let's sort this out" instead of "It hasn't arrived. We've raised
  // this for you." — in the exact failure case the watchdog exists for.
  const { watchdog, exchanges, chain } = harness({
    confirmImpl: async () => { throw new Error("query timeout exceeded"); },
  });

  const [first] = await watchdog.sweep();
  assert.equal(first.relayed, false, "unconfirmed, so not reported as relayed");
  assert.equal(exchanges.get("42").disputeRaisedAt, null, "and no raise is recorded yet");

  // The relay had in fact landed. The protocol says so on the next sweep.
  chain.disputeRaisedAt = 1;
  chain.disputeTimeoutAt = 90 * DAY;
  await watchdog.sweep();

  const record = exchanges.get("42");
  assert.equal(record.disputeRaisedAt, 1, "the dispute is taken from chain");
  assert.equal(record.disputeRaisedBy, "watchdog", "and attributed to the watchdog that attempted it");

  // The half that actually matters. Attribution is a record field; this is the
  // sentence the buyer reads because of it.
  assert.equal(
    parcelLine({ tracking: null, record }).text,
    BUYER_STRINGS.raised_for_you,
    "so the buyer is told the watchdog raised it for them"
  );
});

test("F1 · a dispute nobody here attempted is not claimed by the watchdog", async () => {
  // The other half: the attempt is what attributes it. Without one, a dispute
  // appearing on chain is the buyer's own, and saying otherwise would tell them
  // we did something we did not do.
  const { watchdog, exchanges } = harness({
    recordOver: { disputePeriodMs: 90 * DAY },
    chainOver: { disputeRaisedAt: 1, disputeTimeoutAt: 90 * DAY },
  });

  await watchdog.sweep();

  const record = exchanges.get("42");
  assert.equal(record.disputeRaisedAt, 1);
  assert.equal(record.disputeRaisedBy, null, "unattributed, which the buyer's line reads as their own");
  assert.equal(parcelLine({ tracking: null, record }).text, BUYER_STRINGS.sorting_out);
});

test("F1 · a buyer's own raise landing mid-sweep is not reattributed to the watchdog", async () => {
  // The third way into the same field, and the one the buyer-initiated raise
  // opens. scripts/raise-dispute.mjs is a separate process, so the in-process
  // sweeping guard says nothing about it — and sweep() reads every record once
  // at the top of a pass, where an earlier exchange can sit in confirm() for
  // minutes. By the time step() reaches this record its snapshot can predate a
  // raise the buyer made themselves, and claiming that one tells them the
  // system acted when in fact they did.
  const { watchdog, exchanges } = harness({
    recordOver: { disputeRaiseAttemptedAt: 1 },
    chainOver: { disputeRaisedAt: 1, disputeTimeoutAt: 90 * DAY },
    wrapExchanges: (store) => ({
      ...store,
      all() {
        const snapshot = store.all();
        // The buyer's separate process, landing after the snapshot was taken.
        store.update("42", { disputeRaisedBy: "buyer", disputeRaisedAt: 1 });
        return snapshot;
      },
    }),
  });

  await watchdog.sweep();

  const record = exchanges.get("42");
  assert.equal(record.disputeRaisedBy, "buyer", "the buyer's own raise was claimed by the watchdog");
  assert.equal(parcelLine({ tracking: null, record }).text, BUYER_STRINGS.sorting_out);
});

test("F2 · a raise authorisation is discarded once a dispute exists on chain", async () => {
  // "Discarded once spent" was implemented as "discarded once this process
  // relayed it". A raise that landed without being confirmed left the signature
  // on disk: replaying it reverts on the used nonce, so it was never dangerous,
  // but a bearer instrument that can never be used again has no reason to exist.
  const { watchdog, authorisations, chain } = harness({
    confirmImpl: async () => { throw new Error("query timeout exceeded"); },
  });

  await watchdog.sweep();
  assert.equal(authorisations.has("42", "raiseDispute"), true, "kept while it might still be needed");

  chain.disputeRaisedAt = 1;
  chain.disputeTimeoutAt = 90 * DAY;
  await watchdog.sweep();

  assert.equal(authorisations.has("42", "raiseDispute"), false, "spent the moment the dispute is on chain");
});

test("F2 · the buyer's own raise spends the authorisation too", async () => {
  // It is the protocol's state that spends it, not who acted. A dispute cannot
  // be raised twice, so this signature is dead whoever raised it.
  const { watchdog, authorisations } = harness({
    recordOver: { disputePeriodMs: 90 * DAY },
    chainOver: { disputeRaisedAt: 1, disputeTimeoutAt: 90 * DAY },
  });

  await watchdog.sweep();

  assert.equal(authorisations.has("42", "raiseDispute"), false);
  assert.equal(authorisations.has("42", "escalateDispute"), true, "which is still live and still needed");
});

test("F3 · the record's authorisations array tracks the store", async () => {
  // Harmless in itself — the watchdog reads the filesystem, never this array —
  // but a record that misreports what protects an exchange is the wrong thing
  // to hand an operator asking exactly that.
  const { watchdog, exchanges, authorisations } = harness();
  assert.deepEqual(exchanges.get("42").authorisations, []);

  await watchdog.sweep();

  assert.equal(authorisations.has("42", "raiseDispute"), false, "relayed and confirmed, so gone from disk");
  assert.deepEqual(
    exchanges.get("42").authorisations,
    ["escalateDispute"],
    "and gone from the record that claims to list it"
  );
});

test("F3 · a finalised exchange reports no authorisations", async () => {
  const { watchdog, exchanges } = harness({
    recordOver: { authorisations: ["raiseDispute", "escalateDispute"] },
    chainOver: { finalisedAt: 1_000 },
  });

  await watchdog.sweep();

  assert.deepEqual(exchanges.get("42").authorisations, []);
});

test("a buyer raise landing during the relay is not claimed by the watchdog", async () => {
  // ⚠️ The sibling of the snapshot test above, and the half it did not close.
  // Reading the record fresh fixed the *guard*; the write after confirm() was
  // still unconditional. confirm() asks whether a dispute exists, not whose it
  // is, so the buyer's dispute answers the watchdog's question too — and the
  // watchdog then signed its own name to a raise the buyer made themselves.
  let store = null;
  const h = harness({
    relayImpl: async (stored) => {
      // The buyer's separate process, landing while this relay is in flight —
      // after this step read the record, decided, and committed to relaying.
      store.update("42", { disputeRaisedAt: 1, disputeRaisedBy: "buyer" });
      return { transactionHash: "0xabc", stored };
    },
  });
  store = h.exchanges;
  await h.watchdog.sweep();
  const record = h.exchanges.get("42");
  assert.equal(record.disputeRaisedBy, "buyer", "the buyer's own raise was claimed by the watchdog");
  assert.equal(record.disputeRaisedAt, 1, "and its time was overwritten with the watchdog's");
});
