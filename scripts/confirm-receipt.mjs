#!/usr/bin/env node
// The buyer confirms, and the seller is paid.
//
//   node scripts/confirm-receipt.mjs <exchangeId>
//   node scripts/confirm-receipt.mjs <exchangeId> --execute
//
// ⚠️ This is the one action that pays the seller. It cannot be undone, and it is
// deliberately manual. No tracking event, of any kind, may reach it: tracking
// proves arrival, not condition, and only the buyer can say the second thing.
//
// ⭐ It plans and stops by default. Without --execute it performs every read and
// every guard, prints what completing would pay and to whom, and signs nothing —
// the same meaning --execute carries in scripts/seed-exchange.mjs.

import { resolve } from "node:path";
import { Contract, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore, PERMITTED_ACTIONS } from "../src/authorisations.mjs";

const MS = 1000;

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const requested = args.find((value) => !value.startsWith("--")) ?? null;
if (!requested || !/^\d+$/.test(requested)) {
  console.error("✗ usage: node scripts/confirm-receipt.mjs <exchangeId> [--execute]");
  console.error("  without --execute nothing is signed: the run reports what it would do and stops");
  process.exit(1);
}

// ⚠️ Normalised, because two spellings of one id do not reach the same places.
// "007" passes the digit check, ethers reads it as 7 and pays the seller for
// exchange 7 — while the record store writes 007.json and leaves 7.json saying
// the money is still held, which is the line the buyer is shown.
if (!Number.isSafeInteger(Number(requested))) {
  console.error(`✗ "${requested}" is too large to be read as an exchange id without losing digits`);
  process.exit(1);
}
const exchangeId = String(Number(requested));
if (exchangeId !== requested) console.log(`⚠ reading "${requested}" as exchange ${exchangeId}`);

// Loaded separately from the chain environment, which `connect()` narrows to
// the chain keys on purpose.
const settings = loadEnv({ only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR"] });

const { config, provider, coreSDK } = connect({ role: "buyer" });
const protocol = config.contracts.protocolDiamond;
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const disputeHandler = new Contract(protocol, abis.IBosonDisputeHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

// Anchored to the repository, not to wherever this was launched from — the
// same reasoning as scripts/seed-exchange.mjs and scripts/watchdog.mjs, and it
// must resolve to the same place a record was written under: a store built
// elsewhere reads as empty here, and this command would silently finalise the
// exchange on chain while leaving the record it should update untouched.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
if (!execute) info("planning only — nothing will be signed or submitted");

// --- refuse before anything is signed ---------------------------------------
// Paying twice is impossible — the protocol itself would refuse a second
// completeExchange — but the error it gives is opaque. Saying plainly why
// beats a person reading a revert reason for a mistake this cheap to catch.
step("reading the exchange");
const [before, dispute] = await Promise.all([
  exchangeHandler.getExchange(exchangeId),
  disputeHandler.getDispute(exchangeId),
]);
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

// ⭐ The headline path of this system ends here: the watchdog raises a dispute
// before the window lapses, the parcel then turns up, and the buyer runs this
// command. A disputed exchange cannot be completed — completeExchange reverts —
// so the revert is worth naming rather than leaving to be decoded.
if (dispute.exists) {
  const raisedAt = new Date(Number(dispute.disputeDates.disputed) * MS).toISOString();
  console.error(`✗ exchange ${exchangeId} has a dispute raised on ${raisedAt}, so confirming receipt would revert`);
  console.error("  an open dispute ends through the dispute path — retraction or resolution — not by completing it");
  process.exit(1);
}
ok(`exchange ${exchangeId} is redeemed, undisputed and not finalised`);

// --- what completing it pays -------------------------------------------------
// The price comes from the offer rather than from a local record, so it is the
// number the protocol will actually move even if nothing local knows about this
// exchange at all.
const offerId = before.exchange.offerId.toString();
const { offer } = await offerHandler.getOffer(offerId);
const erc20 = new Contract(offer.exchangeToken, abis.ERC20ABI, provider);
const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);

step(execute ? "what this run does" : "what this run would do");
info(`exchange         ${exchangeId}, from offer ${offerId}`);
info(`redeemed         ${new Date(Number(before.voucher.redeemedDate) * MS).toISOString()}`);
info(`pays the seller  ${utils.formatUnits(offer.price, decimals)} ${symbol}, immediately and irreversibly`);
info(`then discards    the pre-signed ${PERMITTED_ACTIONS.join(" and ")} authorisations`);
if (!exchanges.get(exchangeId)) {
  console.log(`⚠ no local record — nothing under ${exchanges.dir} names exchange ${exchangeId}`);
}

if (!execute) {
  console.log("");
  console.log("nothing was signed and nothing was submitted.");
  console.log("Pay the seller — which cannot be undone — with:");
  console.log(`  npm run confirm -- ${exchangeId} --execute`);
  process.exit(0);
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

  const finalisedAt = Number(finalised.exchange.finalizedDate) * MS;

  // ⭐ The exchange is over, so the two pre-signed authorisations are spent:
  // they are deleted here rather than left lying around. A signature nobody
  // needs is a liability with no remaining upside. (The watchdog also discards
  // a finalised exchange's authorisations on its next sweep — this is the
  // immediate version rather than waiting for one.)
  //
  // Deliberately before the record update: a throw in `update` must not leave
  // spent bearer instruments on disk, and the list is taken from the store's
  // own closed set rather than restated here.
  for (const action of PERMITTED_ACTIONS) {
    authorisations.discard(exchangeId, action);
  }

  if (exchanges.get(exchangeId)) {
    exchanges.update(exchangeId, { finalisedAt, outcome: "paid", authorisations: [] });
  } else {
    // ⚠️ Loudly, not silently. The record is what the watchdog sweeps and what
    // the buyer's money line is computed from, so an exchange that finalised
    // with no record is one the rest of the system will never learn about.
    console.log(`⚠ no record for exchange ${exchangeId} under ${exchanges.dir} — nothing local was updated`);
    console.log("⚠ the seller has been paid; check EXCHANGES_DIR points where this exchange was seeded");
  }

  ok(`exchange ${exchangeId} finalised at ${new Date(finalisedAt).toISOString()}`);
  info(`tx ${explorer(receipt.transactionHash)}`);
  info("authorisations discarded");
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
