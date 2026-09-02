#!/usr/bin/env node
// The seller agrees to a split, and signs it.
//
//   node scripts/accept-resolution.mjs <exchangeId> --percent <n>
//   node scripts/accept-resolution.mjs <exchangeId> --percent <n> --execute
//
// ⭐ One party signs and the counterparty submits. That is the protocol's own
// requirement, not this system's, and it is what makes a settlement impossible
// on one party's say-so. This is the signing half: the seller side is scripted,
// and that is stated plainly rather than hidden. The buyer submits it by
// accepting on their own screen.
//
// ⚠️ `--percent` is the *buyer's* share, 0-100. A refund of 40 on an item priced
// at 200 is 20, not 80. Conversion to the basis points the protocol takes
// happens once, in src/proposal.mjs, and is tested for direction.
//
// ⚠️ This signs; it does not spend. No transaction is submitted here, no gas is
// paid and nothing settles: the result is a signature on disk, bound to one
// exchange and one exact percentage, that the buyer's acceptance can spend once.
// It is a bearer instrument all the same — state/ is gitignored, and it is
// discarded the moment it is spent.
//
// ⭐ It plans and stops by default, the same meaning --execute carries in
// scripts/confirm-receipt.mjs and scripts/raise-dispute.mjs.

import { join, resolve } from "node:path";
import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createCaseStore } from "../src/cases.mjs";
import { CONSENTS_DIR, createConsentStore } from "../src/consents.mjs";
import { proposedPercent } from "../src/buyer-view.mjs";
import { signConsent } from "../src/resolution.mjs";
import { toBasisPoints } from "../src/proposal.mjs";

const MS = 1000;

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);
const warn = (line) => console.log(`⚠ ${line}`);

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const requested = args.find((value) => !value.startsWith("--")) ?? null;
const percentAt = args.indexOf("--percent");
const percentRaw = percentAt === -1 ? null : args[percentAt + 1];

function usage(problem) {
  console.error(`✗ ${problem}`);
  console.error("  usage: node scripts/accept-resolution.mjs <exchangeId> --percent <n> [--execute]");
  console.error("  --percent is the buyer's share of the pot, 0-100");
  console.error("  without --execute nothing is signed: the run reports what it would sign and stops");
  process.exit(1);
}

if (!requested || !/^\d+$/.test(requested)) usage("an exchange id is required");
// ⚠️ Normalised, for the reason scripts/confirm-receipt.mjs gives: "007" passes
// the digit check, ethers reads it as 7, and the consent store writes 007.json —
// so the signature and the exchange the buyer settles would be two different
// things.
if (!Number.isSafeInteger(Number(requested))) {
  usage(`"${requested}" is too large to be read as an exchange id without losing digits`);
}
const exchangeId = String(Number(requested));
if (exchangeId !== requested) console.log(`⚠ reading "${requested}" as exchange ${exchangeId}`);

if (percentRaw == null) usage("--percent is required: a consent is agreement to one exact split");
// Rejected here rather than left to toBasisPoints, so an unparseable value is
// named as one instead of arriving as NaN.
if (!/^\d+(\.\d+)?$/.test(percentRaw)) usage(`"${percentRaw}" is not a percentage`);
const buyerPercent = Number(percentRaw);
if (buyerPercent < 0 || buyerPercent > 100) usage(`${buyerPercent}% is outside the 0-100 the protocol takes`);

// Loaded separately from the chain environment, which connect() narrows to the
// chain keys on purpose.
const settings = loadEnv({ only: ["EXCHANGES_DIR"] });

// ⭐ The seller's key, and the only script here that needs it. Signing is a
// local operation: this reads the chain to check what it is signing against,
// and never writes to it.
const { config, provider, coreSDK, signer } = connect({ role: "seller" });
const protocol = config.contracts.protocolDiamond;
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const disputeHandler = new Contract(protocol, abis.IBosonDisputeHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);

// Anchored to the repository, not to wherever this was launched from — the same
// reasoning as every other script here, and it must resolve where the exchange
// was seeded or this signs a consent against a record nothing reads.
const under = (value, fallback) => resolve(ROOT, value || fallback);
const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
// Fixed, not configurable: the buyer's view reads the same two, and a
// configurable copy that disagreed would be worse than a fixed one that cannot.
const cases = createCaseStore(join(ROOT, "state/cases"));
const consents = createConsentStore(join(ROOT, CONSENTS_DIR));

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
if (!execute) info("planning only — nothing will be signed");

// --- refuse before anything is signed ----------------------------------------
step("reading the exchange");
const record = exchanges.get(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId} under ${exchanges.dir}`);
  console.error("  check EXCHANGES_DIR points where this exchange was seeded");
  process.exit(1);
}

// The protocol is the authority, not the record: a dispute may have been raised,
// escalated or resolved since this record was last written.
const [exchange, dispute] = await Promise.all([
  exchangeHandler.getExchange(exchangeId),
  disputeHandler.getDispute(exchangeId),
]);
if (!exchange.exists) {
  console.error(`✗ exchange ${exchangeId} does not exist`);
  process.exit(1);
}
if (!exchange.exchange.finalizedDate.isZero()) {
  console.error(`✗ exchange ${exchangeId} is already finalised — there is nothing left to settle`);
  process.exit(1);
}
if (!dispute.exists || dispute.disputeDates.disputed.isZero()) {
  console.error(`✗ exchange ${exchangeId} has no dispute open, so there is nothing to resolve`);
  process.exit(1);
}
if (!dispute.disputeDates.escalated.isZero()) {
  const at = new Date(Number(dispute.disputeDates.escalated) * MS).toISOString();
  console.error(`✗ exchange ${exchangeId} was escalated on ${at}, and a person is deciding it`);
  console.error("  the protocol refuses a mutual resolution once a case has gone to its resolver");
  process.exit(1);
}

// ⚠️ Past the resolution deadline the protocol refuses the call, so a consent
// signed now could never be spent.
const timeout = Number(dispute.disputeDates.timeout) * MS;
if (Date.now() >= timeout) {
  console.error(`✗ the resolution window for exchange ${exchangeId} closed on ${new Date(timeout).toISOString()}`);
  process.exit(1);
}
ok(`exchange ${exchangeId} is disputed, unescalated and not finalised`);

// ⭐ Whose signature the protocol will actually accept. The buyer submits, so
// the counterparty is this offer's seller — and a consent signed by any other
// key is a signature that can only ever revert. Caught here, before it is
// written, rather than at the moment the buyer presses accept.
const offerId = exchange.exchange.offerId.toString();
const [{ offer }, [sellerExists, sellerAccount]] = await Promise.all([
  offerHandler.getOffer(offerId),
  accountHandler.getSellerByAddress(signer.address),
]);
if (!sellerExists || !sellerAccount.id.eq(offer.sellerId)) {
  console.error(`✗ ${signer.address} is not the seller of offer ${offerId}`);
  console.error(`  the protocol accepts this exchange's resolution signed by seller ${offer.sellerId} and nobody else`);
  console.error("  check SELLER_PRIVATE_KEY is the account that created the offer");
  process.exit(1);
}
ok(`signing as seller ${offer.sellerId} — ${signer.address}`);

// ⭐ The number the buyer is looking at. settle() refuses a consent that does
// not match it, so signing a different one produces a signature nothing can
// ever spend — worth saying here rather than discovering on the press.
const onScreen = proposedPercent(cases.read(exchangeId));
if (onScreen == null) {
  warn(`no proposal stands on exchange ${exchangeId}, so nothing on the buyer's screen offers this yet`);
  info("the consent will keep until one does, and it is refused if that proposal names another split");
} else if (onScreen !== buyerPercent) {
  console.error(`✗ the proposal on exchange ${exchangeId} is ${onScreen}%, not ${buyerPercent}%`);
  console.error("  a consent settles the split it was signed over and no other, so this one could never be spent");
  process.exit(1);
}

// --- what signing it agrees to -----------------------------------------------
const basisPoints = toBasisPoints(buyerPercent);
step(execute ? "what this run does" : "what this run would do");
info(`exchange         ${exchangeId}, from offer ${offerId}`);
info(`agrees the buyer takes  ${buyerPercent}% of the pot — ${basisPoints} basis points`);
info(`leaving the seller      ${100 - buyerPercent}%`);
info(`window closes    ${new Date(timeout).toISOString()}`);
info(`writes           one signature to ${consents.dir}, spendable once, by this exchange only`);
if (record.disputeRaisedBy) info(`dispute raised by ${record.disputeRaisedBy}`);

if (!execute) {
  console.log("");
  console.log("nothing was signed. Sign it with:");
  console.log(`  npm run accept -- ${exchangeId} --percent ${percentRaw} --execute`);
  process.exit(0);
}

// --- sign --------------------------------------------------------------------
step("signing");
try {
  const consent = await signConsent({ coreSDK, exchangeId, buyerPercent });

  // ⚠️ Checked against the key that was meant to sign, not assumed from it.
  // signConsent recovers the address from the signature itself, so this
  // compares what the protocol will recover against what this run set out to
  // agree — the one place a wrong signer is still catchable for free.
  if (consent.signedBy !== signer.address) {
    console.error(`✗ the signature recovers to ${consent.signedBy}, not ${signer.address}`);
    console.error("  nothing was written");
    process.exit(1);
  }

  consents.save(exchangeId, consent);
  ok(`consent stored for exchange ${exchangeId} at ${buyerPercent}% to the buyer`);
  info("nothing has settled: it settles when the buyer accepts, and not before");
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  console.error("  nothing was signed and nothing was written");
  process.exitCode = 1;
}
