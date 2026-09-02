#!/usr/bin/env node
// Run the watchdog.
//
//   node scripts/watchdog.mjs --once
//   node scripts/watchdog.mjs
//
// ⭐ Calibrate by lead, not by window. Both protocol periods have a 7-day floor
// and cannot be shortened, so exercising the deadline logic is a matter of
// setting the lead close to the period — the watchdog then fires shortly after
// purchase without the window being touched at all.
//
// ⚠️ A lead approaching its period is a demonstration configuration and must
// never ship: in production it would raise disputes before a parcel could
// plausibly arrive. It warns loudly, every sweep, for exactly that reason.

import { resolve } from "node:path";
import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState, RELAY_ONLY_ENV_KEYS } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createStore } from "../src/store.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { confirmedAt } from "../src/disputes.mjs";
import { ESCALATE_LEAD, RAISE_LEAD, assertLeadSane, leadMs, outcomeFor } from "../src/adapter.mjs";

const MS = 1000;
const once = process.argv.includes("--once");

// ⚠️ Two loads, deliberately. `connect()` narrows the environment to the chain
// keys, which is what keeps the tracking key out of a process that can move
// funds; these are this script's own settings and are loaded beside it rather
// than by widening that list.
const settings = loadEnv({
  only: [
    "EXCHANGES_DIR",
    "AUTHORISATIONS_DIR",
    "EVENTS_DIR",
    "RETAIN_LOCATIONS",
    "DISPUTE_RAISE_LEAD_MS",
    "ESCALATION_LEAD_MS",
    "WATCHDOG_INTERVAL_MS",
  ],
});

// ⭐ No role, and a narrowed key list: this process must not be able to sign as
// the buyer or the seller even by accident. It relays instructions they already
// signed and reads the protocol back — neither needs a key, so it holds none,
// and RELAY_ONLY_ENV_KEYS means it cannot read one if the file has it.
const { config, provider, coreSDK } = connect({ envKeys: RELAY_ONLY_ENV_KEYS });
const protocol = config.contracts.protocolDiamond;
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const disputeHandler = new Contract(protocol, abis.IBosonDisputeHandlerABI, provider);

// Anchored to the repository, not to wherever this was launched from — and that
// applies to a configured relative path just as much as to the default, since
// `state/exchanges` is what .env.example ships. Resolving against the cwd
// silently creates an empty store and then sweeps nothing, which for this
// component looks identical to everything being fine. An absolute path is left
// exactly as given.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));
const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"), {
  retainPlaces: settings.RETAIN_LOCATIONS === "true",
});

const override = (name) => (settings[name] ? Number(settings[name]) : null);

function leadsFor(record) {
  const raiseMs = override("DISPUTE_RAISE_LEAD_MS") ?? leadMs(record.disputePeriodMs, RAISE_LEAD);
  const escalateMs = override("ESCALATION_LEAD_MS") ?? leadMs(record.resolutionPeriodMs, ESCALATE_LEAD);
  for (const warning of [
    ...assertLeadSane(record.disputePeriodMs, raiseMs, "DISPUTE_RAISE_LEAD"),
    ...assertLeadSane(record.resolutionPeriodMs, escalateMs, "ESCALATION_LEAD"),
  ]) {
    console.log(`⚠ ${warning}`);
  }
  return { raiseMs, escalateMs };
}

async function readChainState(exchangeId) {
  const [exchange, dispute] = await Promise.all([
    exchangeHandler.getExchange(exchangeId),
    disputeHandler.getDispute(exchangeId),
  ]);

  const finalisedAt = exchange.exists && !exchange.exchange.finalizedDate.isZero()
    ? Number(exchange.exchange.finalizedDate) * MS
    : null;

  // ⭐ An outcome is what happened to the money, so there is not one until the
  // protocol says the exchange is over. Until then the money is escrowed and
  // nobody has been paid — writing "paid" onto a live exchange every sweep is
  // both false and load-bearing, because it is what the buyer's money line
  // reads. Null means "not yet" here, and the sweep merges only facts, so it
  // leaves whatever the record already holds.

  if (!dispute.exists) {
    // No dispute: once finalised, the exchange either completed or its window
    // lapsed, and both pay the seller.
    //
    // ⚠️ Bounded: a revoked or cancelled exchange also finalises without a
    // dispute and does return the buyer's money. Nothing in this system
    // produces either — they are seller and buyer actions outside the watchdog's
    // path — and the on-chain state enum is not exposed by the SDK, so it is
    // reported as paid rather than guessed at from an unverified enum ordering.
    return {
      finalisedAt,
      ...(finalisedAt == null
        ? { outcome: null, buyerPercent: null }
        : outcomeFor(0)),
      disputeRaisedAt: null, disputeTimeoutAt: null, escalatedAt: null,
    };
  }
  const { disputed, escalated, timeout } = dispute.disputeDates;
  return {
    finalisedAt,
    // Whether any of the pot came back, which is the only thing the money line
    // claims. Exact for every path this system takes: the watchdog raises, and
    // a raised dispute settles through a percentage. An open dispute has
    // settled nothing yet, so it too reports no outcome until it finalises.
    ...(finalisedAt == null
      ? { outcome: null, buyerPercent: null }
      : outcomeFor(dispute.dispute.buyerPercent.toNumber())),
    disputeRaisedAt: disputed.isZero() ? null : Number(disputed) * MS,
    disputeTimeoutAt: timeout.isZero() ? null : Number(timeout) * MS,
    escalatedAt: escalated.isZero() ? null : Number(escalated) * MS,
  };
}

const relay = async (stored) => {
  const tx = await coreSDK.relayMetaTransaction(
    {
      functionName: stored.functionName,
      functionSignature: stored.functionSignature,
      sigR: stored.r,
      sigS: stored.s,
      sigV: stored.v,
      nonce: stored.nonce,
    },
    // Who signed, as data. This is what lets the process relay without holding
    // the buyer's key: without it the SDK asks its own signer who it is.
    { userAddress: stored.userAddress }
  );
  return tx.wait();
};

// ⚠️ The relayer resolving is not the protocol having acted. `wait()` returns a
// receipt with no status field, and a meta-transaction that reverted on chain
// comes back through exactly the same path as one that succeeded — so the only
// honest answer comes from asking the protocol what it recorded.
//
// ⭐ And what it recorded includes when. This used to answer `true` and discard
// the date it had just polled for, which left the sweep stamping its own clock
// on the record; it now hands the date back and the sweep writes that.
const confirm = (stored) =>
  waitForState(
    async () => confirmedAt(await disputeHandler.getDispute(stored.exchangeId), stored.action),
    { what: `${stored.action} to be recorded for exchange ${stored.exchangeId}` }
  );

const watchdog = createWatchdog({
  exchanges,
  trackers,
  authorisations,
  readChainState,
  relay,
  confirm,
  leadsFor,
  log: (line) => console.log(line),
});

const intervalMs = Number(settings.WATCHDOG_INTERVAL_MS ?? 60_000);

async function run() {
  const results = await watchdog.sweep();
  for (const r of results) {
    const suffix = r.relayed ? " → relayed" : r.unprotected ? " → UNPROTECTED" : "";
    console.log(`  exchange ${r.exchangeId}: ${r.action}${suffix} — ${r.reason ?? r.error ?? ""}`);
  }
  // ⚠️ Said out loud even when it is zero. This component's failure mode is
  // silence, so a sweep that printed nothing must not be indistinguishable from
  // a sweep that never ran.
  console.log(`swept ${results.length} exchange${results.length === 1 ? "" : "s"}`);
}

// ⚠️ One sweep at a time. A relay submits and then waits for the protocol to
// record it, which can outlast the interval — and an overlapping sweep would
// find the authorisation still in place, relay it a second time, and race the
// first one's discard.
let sweeping = false;
async function runOnce() {
  if (sweeping) return console.log("· previous sweep still running, skipping this tick");
  sweeping = true;
  try {
    await run();
  } finally {
    sweeping = false;
  }
}

await runOnce();
if (!once) {
  console.log(`\nsweeping every ${intervalMs / 1000}s — the clock drives this, not events`);
  setInterval(() => { runOnce().catch((err) => console.log(`✗ sweep failed: ${err.message}`)); }, intervalMs);
}
