#!/usr/bin/env node
// The buyer says something is wrong.
//
//   node scripts/raise-dispute.mjs <exchangeId>
//   node scripts/raise-dispute.mjs <exchangeId> --execute
//
// ⭐ Not automatic — this is the buyer acting — but it spends exactly the
// instrument the watchdog holds for the same exchange. One pre-signed
// authorisation, two possible spenders: whichever goes first, the other stands
// down, because the decision function moves to the escalation branch the moment
// disputeRaisedAt is set.
//
// ⭐ Without this the arrived-but-wrong case is unreachable. The watchdog never
// raises on a delivered parcel — src/adapter.mjs stands it down with "delivered;
// confirming belongs to the buyer" — and condition is the one thing tracking
// cannot speak to.
//
// ⚠️ No user-visible copy lives here. The buyer never encounters the word
// dispute; their interface says something is wrong, and this is what runs.
//
// ⭐ It plans and stops by default, the same meaning --execute carries in
// scripts/seed-exchange.mjs and scripts/confirm-receipt.mjs.

import { resolve } from "node:path";
import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState, RELAY_ONLY_ENV_KEYS } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { confirmedAt, raiseFor } from "../src/disputes.mjs";

const MS = 1000;

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const requested = args.find((value) => !value.startsWith("--")) ?? null;
if (!requested || !/^\d+$/.test(requested)) {
  console.error("✗ usage: node scripts/raise-dispute.mjs <exchangeId> [--execute]");
  console.error("  without --execute nothing is relayed: the run reports what it would do and stops");
  process.exit(1);
}

// ⚠️ Normalised, for the reason scripts/confirm-receipt.mjs gives: "007" passes
// the digit check, ethers reads it as 7, and the record store writes 007.json —
// so the dispute and the record the buyer's line is computed from would end up
// on two different exchanges.
if (!Number.isSafeInteger(Number(requested))) {
  console.error(`✗ "${requested}" is too large to be read as an exchange id without losing digits`);
  process.exit(1);
}
const exchangeId = String(Number(requested));
if (exchangeId !== requested) console.log(`⚠ reading "${requested}" as exchange ${exchangeId}`);

// ⚠️ Two loads, deliberately — connect() narrows the environment to the chain
// keys, so this script's own settings are loaded beside it rather than by
// widening that list.
const settings = loadEnv({ only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR"] });

// ⭐ No role, and a narrowed key list. This process must not be able to sign as
// the buyer or the seller even by accident: it relays an instruction the buyer
// already signed, which needs no key, so RELAY_ONLY_ENV_KEYS means it cannot
// read one even if the file has it.
const { config, provider, coreSDK } = connect({ envKeys: RELAY_ONLY_ENV_KEYS });
const disputeHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonDisputeHandlerABI, provider);
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

// Anchored to the repository, not to wherever this was launched from — and it
// must resolve where the exchange was seeded, or this relays a real dispute on
// chain and updates nothing the buyer reads.
const under = (value, fallback) => resolve(ROOT, value || fallback);
const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
if (!execute) info("planning only — nothing will be relayed");

// --- refuse before anything is relayed ---------------------------------------
step("reading the exchange");
const record = exchanges.get(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId} under ${exchanges.dir}`);
  console.error("  check EXCHANGES_DIR points where this exchange was seeded");
  process.exit(1);
}
if (record.finalisedAt != null) {
  console.error(`✗ exchange ${exchangeId} is already finalised — there is nothing left to dispute`);
  process.exit(1);
}

// The protocol is the authority, not the record: the watchdog may have raised
// since this record was last written, and a second raise reverts on chain.
const dispute = await disputeHandler.getDispute(exchangeId);
if (dispute.exists && !dispute.disputeDates.disputed.isZero()) {
  const raisedAt = new Date(Number(dispute.disputeDates.disputed) * MS).toISOString();
  console.error(`✗ exchange ${exchangeId} already has an open case, raised ${raisedAt}`);
  console.error(`  attributed locally to ${record.disputeRaisedBy ?? "nobody"}`);
  process.exit(1);
}
if (!authorisations.has(exchangeId, "raiseDispute")) {
  console.error(`✗ no raiseDispute authorisation is held for exchange ${exchangeId}`);
  console.error("  nothing here can act for the buyer without the signature they gave at purchase");
  process.exit(1);
}
ok(`exchange ${exchangeId} is live, undisputed, and its raiseDispute authorisation is held`);

step(execute ? "what this run does" : "what this run would do");
info(`raises           a dispute on exchange ${exchangeId}, attributed to the buyer`);
info("then discards    the pre-signed raiseDispute authorisation, once the protocol confirms it");
info("leaves           the escalateDispute authorisation in place — the watchdog guards the resolution window");

if (!execute) {
  console.log("");
  console.log("nothing was relayed. Raise it with:");
  console.log(`  npm run raise -- ${exchangeId} --execute`);
  process.exit(0);
}

// --- relay -------------------------------------------------------------------
// Wired exactly as in scripts/watchdog.mjs: the same relay and the same
// read-back, because the same failure applies to both — a meta-transaction that
// reverted on chain comes back through the path a successful one returns
// through, so only the protocol can say what happened.
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
    // the buyer's key.
    { userAddress: stored.userAddress }
  );
  const receipt = await tx.wait();
  info(`tx ${explorer(receipt.transactionHash ?? tx.hash)}`);
  return receipt;
};

// ⭐ It answers with the date the protocol recorded, not just that it did —
// what raiseFor writes onto the record, so that the buyer's case is dated by the
// chain rather than by whenever this script's read-back came back.
const confirm = (stored) =>
  waitForState(
    async () => confirmedAt(await disputeHandler.getDispute(stored.exchangeId), "raiseDispute"),
    { what: `raiseDispute to be recorded for exchange ${stored.exchangeId}` }
  );

step("raising");
try {
  await raiseFor({ exchangeId, by: "buyer", exchanges, authorisations, relay, confirm });
  const after = exchanges.get(exchangeId);
  ok(`raised for exchange ${exchangeId} at ${new Date(after.disputeRaisedAt).toISOString()}, attributed to the buyer`);
  info("the watchdog stands down on the raise and guards the resolution window from here");
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  console.error("  the authorisation is still held and the window is still open — check the transaction before re-running");
  process.exitCode = 1;
}
