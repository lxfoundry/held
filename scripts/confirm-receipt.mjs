#!/usr/bin/env node
// The buyer confirms, and the seller is paid.
//
//   node scripts/confirm-receipt.mjs <exchangeId>
//
// ⚠️ This is the one irreversible action in the system, and it is deliberately
// manual. No tracking event, of any kind, may reach it: tracking proves
// arrival, not condition, and only the buyer can say the second thing.

import { resolve } from "node:path";
import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";

const exchangeId = process.argv[2];
if (!exchangeId || !/^\d+$/.test(exchangeId)) {
  console.error("usage: node scripts/confirm-receipt.mjs <exchangeId>");
  process.exit(1);
}

// Loaded separately from the chain environment, which `connect()` narrows to
// the chain keys on purpose.
const settings = loadEnv({ only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR"] });

const { config, provider, coreSDK } = connect({ role: "buyer" });
const exchangeHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonExchangeHandlerABI, provider);
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

// Anchored to the repository, not to wherever this was launched from — the
// same reasoning as scripts/seed-exchange.mjs and scripts/watchdog.mjs, and it
// must resolve to the same place a record was written under: a store built
// elsewhere reads as empty here, and this command would silently finalise the
// exchange on chain while leaving the record it should update untouched.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));

// --- refuse before anything is signed ---------------------------------------
// Paying twice is impossible — the protocol itself would refuse a second
// completeExchange — but the error it gives is opaque. Saying plainly why
// beats a person reading a revert reason for a mistake this cheap to catch.
const before = await exchangeHandler.getExchange(exchangeId);
if (!before.exists) {
  console.error(`✗ exchange ${exchangeId} does not exist`);
  process.exit(1);
}
if (!before.exchange.finalizedDate.isZero()) {
  console.error(`✗ exchange ${exchangeId} is already finalised`);
  process.exit(1);
}
if (before.voucher.redeemedDate.isZero()) {
  console.error(`✗ exchange ${exchangeId} has not been redeemed yet — there is nothing to confirm`);
  process.exit(1);
}

// --- sign and relay ----------------------------------------------------------
const nonce = Date.now();
const signed = await coreSDK.signMetaTxCompleteExchange({ nonce, exchangeId });
const tx = await coreSDK.relayMetaTransaction({
  functionName: signed.functionName,
  functionSignature: signed.functionSignature,
  sigR: signed.r,
  sigS: signed.s,
  sigV: signed.v,
  nonce,
});

// ⚠️ The transaction is already submitted the moment relayMetaTransaction
// returns — tx.hash exists before wait() is even called, because the relayer
// has already accepted it. wait() resolving is not proof the protocol acted:
// its receipt carries no status field, so a completeExchange that reverted on
// chain comes back through exactly the same path as one that mined
// successfully (scripts/watchdog.mjs states this too). The transaction was
// submitted and may have landed; only the read-back below proves it.
// Everything from here on, including wait() itself, runs inside one protected
// span: a throw anywhere in it reports what is already known rather than
// dying into a bare stack trace with nothing to look the transaction up by.
let receipt;
let confirmed = false;
try {
  receipt = await tx.wait();

  // ⚠️ Read back through waitForState: the relayer resolves on mining and the
  // RPC is a pool. A finalised date is the protocol's own statement that this
  // is over, and needs no enum to interpret. It is also the only signal here
  // that actually proves completeExchange succeeded — wait() alone cannot
  // distinguish a mined success from a mined revert.
  const finalised = await waitForState(
    async () => {
      const result = await exchangeHandler.getExchange(exchangeId);
      return result.exists && !result.exchange.finalizedDate.isZero() ? result : null;
    },
    { what: `exchange ${exchangeId} to read as finalised` }
  );
  confirmed = true;

  const finalisedAt = Number(finalised.exchange.finalizedDate) * 1000;
  if (exchanges.get(exchangeId)) {
    exchanges.update(exchangeId, { finalisedAt, outcome: "paid", authorisations: [] });
  }

  // ⭐ The exchange is over, so the two pre-signed authorisations are spent:
  // they are deleted here rather than left lying around. A signature nobody
  // needs is a liability with no remaining upside. (The watchdog also discards
  // a finalised exchange's authorisations on its next sweep — this is the
  // immediate version rather than waiting for one.)
  for (const action of ["raiseDispute", "escalateDispute"]) {
    authorisations.discard(exchangeId, action);
  }

  console.log(`✓ exchange ${exchangeId} finalised at ${new Date(finalisedAt).toISOString()}`);
  console.log(`  tx ${explorer(receipt.transactionHash)}`);
  console.log("  authorisations discarded");
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (confirmed) {
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error(`  exchange ${exchangeId} is finalised and the seller has been paid, but this record was not updated`);
  } else if (receipt) {
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error("  the transaction mined, but the protocol has not confirmed it finalised — check the transaction before re-running");
  } else {
    console.error(`  tx ${explorer(tx.hash)}`);
    console.error("  the transaction was submitted but its outcome is unconfirmed — check it before re-running");
  }
  process.exitCode = 1;
}
