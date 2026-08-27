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

import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect } from "../src/chain.mjs";
import { loadEnv } from "../src/env.mjs";
import { createStore } from "../src/store.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { ESCALATE_LEAD, RAISE_LEAD, assertLeadSane, leadMs } from "../src/adapter.mjs";

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

const { config, provider, coreSDK } = connect({ role: "buyer" });
const protocol = config.contracts.protocolDiamond;
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const disputeHandler = new Contract(protocol, abis.IBosonDisputeHandlerABI, provider);

const exchanges = createExchangeStore(settings.EXCHANGES_DIR ?? "state/exchanges");
const authorisations = createAuthorisationStore(settings.AUTHORISATIONS_DIR ?? "state/authorisations");
const trackers = createStore(settings.EVENTS_DIR ?? "fixtures/events", {
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

  if (!dispute.exists) {
    return { finalisedAt, disputeRaisedAt: null, disputeTimeoutAt: null, escalatedAt: null };
  }
  const { disputed, escalated, timeout } = dispute.disputeDates;
  return {
    finalisedAt,
    disputeRaisedAt: disputed.isZero() ? null : Number(disputed) * MS,
    disputeTimeoutAt: timeout.isZero() ? null : Number(timeout) * MS,
    escalatedAt: escalated.isZero() ? null : Number(escalated) * MS,
  };
}

const relay = async (stored) => {
  const tx = await coreSDK.relayMetaTransaction({
    functionName: stored.functionName,
    functionSignature: stored.functionSignature,
    sigR: stored.r,
    sigS: stored.s,
    sigV: stored.v,
    nonce: stored.nonce,
  });
  return tx.wait();
};

const watchdog = createWatchdog({
  exchanges,
  trackers,
  authorisations,
  readChainState,
  relay,
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
}

await run();
if (!once) {
  console.log(`\nsweeping every ${intervalMs / 1000}s — the clock drives this, not events`);
  setInterval(() => { run().catch((err) => console.log(`✗ sweep failed: ${err.message}`)); }, intervalMs);
}
