#!/usr/bin/env node
// Create one exchange, end to end, and capture what the deadline logic needs.
//
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn>
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn> --execute
//
// ⭐ And the recovery half of the same job:
//
//   node scripts/seed-exchange.mjs --adopt <exchangeId> --tracker <t> --tracking-number <tn> --execute
//
// --adopt sends no transaction. It exists because the window this script keeps
// short is not zero: an exchange can end up live on chain with no record and no
// authorisations — the relay landed, something after it did not. That exchange
// is holding the buyer's money with nothing standing guard, and the two failure
// messages at the bottom of this file say "check it before re-running" without
// saying what else to do. This is the what else. It reads the exchange back,
// signs the two authorisations against it and writes the record, so the
// watchdog can see an exchange it previously could not.
//
// ⚠️ THIS COMMAND SPENDS THE BUYER'S MONEY, AND NOTHING IT DOES CAN BE UNDONE.
// The single relayed transaction below creates the offer, commits to it and
// redeems it, and the commit moves the price out of the buyer's wallet into the
// protocol's escrow. There is no buyer-side cancel after the redeem: the money
// leaves escrow when the buyer confirms receipt, when a raised dispute is
// resolved, or when the window lapses — and a lapsed window pays the seller.
//
// ⭐ Which is why it plans and stops by default. Without --execute it performs
// every read and every guard, prints the offer it would create, and signs
// nothing. --execute is the only thing that makes it real, here and in
// scripts/confirm-receipt.mjs, where it means the same thing.
//
// The seller signs the offer off-chain and never sends a transaction. The buyer
// submits one relayed meta-transaction that creates the offer, commits to it and
// redeems it — so the offer does not exist on-chain until the moment of purchase,
// and the buyer never holds native currency.
//
// ⭐ The two authorisations are signed immediately afterwards, in this same run,
// and they cannot be signed earlier: the protocol requires raiseDispute and
// escalateDispute to come from the buyer, and the exchangeId they are scoped to
// does not exist until the purchase is mined. An exchange without them is
// unprotected and must be shown as such.

import { resolve } from "node:path";
import { Contract, constants, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";

// ⚠️ `connect()` returns an environment narrowed to the chain keys — that
// `only` list is what keeps wallet keys and the tracking key out of each
// other's processes, so the settings this script needs beyond the chain are
// loaded separately rather than by widening it.
const settings = loadEnv({
  only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR", "ITEM_PRICE", "DELIVERY_TIMELINE_DAYS", "OFFER_METADATA_URI"],
});

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

// ⚠️ The next token is a value only if it does not itself look like a flag.
// `--tracker --tracking-number XYZ` otherwise yields a trackerId of
// "--tracking-number", which passes every check here and then quietly names a
// parcel that does not exist. The tracker id is the handle the whole system
// resolves an exchange by, so a wrong one means this exchange never sees its
// own delivery events and the watchdog raises against a seller who performed.
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};

const MS = 1000;
const DAY_MS = 86_400 * MS;

// The offer's clock is backdated by this much against the chain's own, so that
// "redeemable from" is in the past by a margin rather than by a hair.
const CLOCK_MARGIN_MS = 60 * MS;

const trackerId = arg("tracker");
const trackingNumber = arg("tracking-number");
const adopt = arg("adopt");
const execute = process.argv.includes("--execute");
const force = process.argv.includes("--force");
if (!trackerId || !trackingNumber) {
  console.error(
    "✗ usage: node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <trackingNumber> [--execute] [--force]"
  );
  console.error(
    "     or: node scripts/seed-exchange.mjs --adopt <exchangeId> --tracker <trackerId> --tracking-number <trackingNumber> [--execute]"
  );
  console.error("  the tracker and tracking number are required either way, and neither may be another flag");
  console.error("  without --execute nothing is signed: the run reports what it would do and stops");
  console.error("  --adopt protects an exchange that already exists on chain, and sends no transaction");
  process.exit(1);
}

const seller = connect({ role: "seller", required: ["DISPUTE_RESOLVER_ID"] });
const buyer = connect({ role: "buyer" });
const { env, config, provider } = seller;
const protocol = config.contracts.protocolDiamond;
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const configHandler = new Contract(protocol, abis.IBosonConfigHandlerABI, provider);

// Anchored to the repository, not to wherever this was launched from — the
// same reasoning as scripts/watchdog.mjs, and it must resolve to the same
// place: a store built elsewhere makes a live exchange read as unprotected to
// the watchdog that is supposed to guard it. AUTHORISATIONS_DIR is checked by
// the store itself: inside the repository, only a path under state/ is
// accepted.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`seller ${seller.signer.address}`);
info(`buyer  ${buyer.signer.address}`);
if (!execute) info("planning only — nothing will be signed or submitted");

// ⭐ The record first, then the signatures, then the record again. Both paths
// into this function reach it with an exchange already live on chain and
// unguarded, so the ordering is the point: the record exists — and the
// watchdog can therefore see the exchange — before anything that can fail
// again is attempted. `authorisations` is the only field that changes.
async function protect({ exchangeId, offerId, redeemedAt, disputePeriodMs, resolutionPeriodMs }) {
  exchanges.put({
    exchangeId: String(exchangeId),
    offerId,
    configId: config.configId,
    trackerId,
    trackingNumber,
    redeemedAt,
    disputePeriodMs,
    resolutionPeriodMs,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeTimeoutAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: [],
  });

  step("capturing the authorisations the deadline logic will need");
  const toAuthorise = [
    ["raiseDispute", (args) => buyer.coreSDK.signMetaTxRaiseDispute(args)],
    ["escalateDispute", (args) => buyer.coreSDK.signMetaTxEscalateDispute(args)],
  ];
  for (const [index, [action, sign]] of toAuthorise.entries()) {
    // ⚠️ Distinct nonces, so neither depends on the other having executed. The
    // handler marks nonces used rather than requiring them in sequence, so the
    // two are order-independent — but they must not collide, and two calls to
    // Date.now() in the same millisecond would.
    const actionNonce = Date.now() + index;
    const signedAction = await sign({ nonce: actionNonce, exchangeId });
    authorisations.save(exchangeId, action, signedAction, {
      nonce: actionNonce,
      userAddress: buyer.signer.address,
    });
    ok(`${action} authorised for exchange ${exchangeId} only`);
  }

  exchanges.update(exchangeId, { authorisations: authorisations.list(exchangeId) });
  return authorisations.list(exchangeId);
}

// ⭐ Reads what the offer actually says, and refuses a period that did not
// arrive. getOffer does not revert on an offer the node cannot see yet: it
// returns a perfectly truthy result with `exists: false` and every duration
// zeroed, and a zero period recorded as fact stands the watchdog down for the
// life of the exchange.
async function periodsFor(offerId, fallback = null) {
  let offer = null;
  try {
    offer = await offerHandler.getOffer(offerId);
  } catch (err) {
    if (!fallback) throw err;
    info(`could not read offer ${offerId} back (${err.message}) — recording the requested periods`);
  }
  const durations = offer?.exists ? offer.offerDurations : null;
  if (!durations) {
    if (!fallback) throw new Error(`offer ${offerId} does not read back from the protocol`);
    return fallback;
  }
  return {
    disputePeriodMs: Number(durations.disputePeriod) * MS,
    resolutionPeriodMs: Number(durations.resolutionPeriod) * MS,
  };
}

// --- adopt: protect an exchange that already exists -------------------------
if (adopt) {
  if (!/^\d+$/.test(adopt) || !Number.isSafeInteger(Number(adopt))) {
    console.error(`✗ --adopt expects a whole exchange id, not ${JSON.stringify(adopt)}`);
    process.exit(1);
  }
  // The protocol reads "007" as 7, and so must the store — otherwise this
  // writes 007.json for an exchange the watchdog looks up as 7.
  const exchangeId = String(Number(adopt));
  if (exchangeId !== adopt) console.log(`⚠ reading "${adopt}" as exchange ${exchangeId}`);

  step(`reading exchange ${exchangeId} back from the protocol`);
  const onChain = await exchangeHandler.getExchange(exchangeId);
  if (!onChain.exists) {
    console.error(`✗ exchange ${exchangeId} does not exist on ${config.configId}`);
    console.error("  an exchange id from another configuration names a different exchange, or none");
    process.exit(1);
  }
  if (onChain.voucher.redeemedDate.isZero()) {
    console.error(`✗ exchange ${exchangeId} has not been redeemed, so no window is open yet`);
    console.error("  there is nothing for the watchdog to guard until it is");
    process.exit(1);
  }
  if (!onChain.exchange.finalizedDate.isZero()) {
    console.error(`✗ exchange ${exchangeId} is already finalised — the money has moved`);
    console.error("  adopting it would write authorisations that can never be used");
    process.exit(1);
  }

  const held = authorisations.list(exchangeId);
  if (held.length && !force) {
    console.error(`✗ exchange ${exchangeId} already holds ${held.join(" and ")}`);
    console.error("  re-signing would replace instruments that are still valid");
    console.error("  pass --force only if the held ones are known to be lost or wrong");
    process.exit(1);
  }
  if (held.length) console.log(`⚠ --force: replacing the held ${held.join(" and ")}`);

  const redeemedAt = Number(onChain.voucher.redeemedDate) * MS;
  const offerId = onChain.exchange.offerId.toString();
  const { disputePeriodMs, resolutionPeriodMs } = await periodsFor(offerId);

  ok(`exchange ${exchangeId} is redeemed and unfinalised — its window is open`);
  info(`offer ${offerId} — dispute period ${disputePeriodMs / DAY_MS}d, resolution period ${resolutionPeriodMs / DAY_MS}d`);
  info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);
  info(`tracker          ${trackerId}`);
  info(`tracking number  ${trackingNumber}`);
  info("raiseDispute and escalateDispute would be signed for this exchange and kept for the watchdog");

  if (!execute) {
    console.log("");
    console.log("nothing was signed. No transaction is sent either way — adopting only signs and records.");
    console.log("Protect it with:");
    console.log(`  npm run seed -- --adopt ${exchangeId} --tracker ${trackerId} --tracking-number ${trackingNumber} --execute`);
    process.exit(0);
  }

  const captured = await protect({ exchangeId, offerId, redeemedAt, disputePeriodMs, resolutionPeriodMs });
  console.log("");
  console.log(`exchange ${exchangeId} is now protected by ${captured.join(" and ")}.`);
  console.log(`Confirm receipt with: npm run confirm -- ${exchangeId} --execute`);
  process.exit(0);
}

// --- has this parcel already been bought? ----------------------------------
// ⚠️ The guard with no recovery behind it. Both failure messages at the bottom
// of this file end in "check it before re-running", and a re-run against the
// same parcel escrows a second lot of the buyer's money for one delivery —
// silently, because nothing else in the system objects to two exchanges naming
// one tracker.
step("checking this parcel is not already bought");
const existing = exchanges.byTracker(trackerId);
if (existing && existing.finalisedAt == null) {
  if (!force) {
    console.error(`✗ tracker ${trackerId} already belongs to exchange ${existing.exchangeId}, which is not finalised`);
    console.error("  seeding again would escrow the buyer's money a second time against the same parcel");
    console.error(`  confirm that one with: npm run confirm -- ${existing.exchangeId} --execute`);
    console.error("  or pass --force if a second exchange for this parcel is genuinely what you want");
    process.exit(1);
  }
  console.log(`⚠ --force: tracker ${trackerId} is already held by unfinalised exchange ${existing.exchangeId}`);
  console.log("⚠ this run escrows the buyer's money a second time for the same parcel");
} else if (existing) {
  ok(`tracker ${trackerId} was last used by exchange ${existing.exchangeId}, which is finalised`);
} else {
  ok(`tracker ${trackerId} is not held by any recorded exchange`);
}

// --- read everything the offer is built from -------------------------------
step("reading the resolver and the protocol floors");

// ⚠️ The exchange token comes from the resolver's own fee schedule, not from
// .env: an offer is valid only if its token is one the resolver lists.
const resolverId = env.DISPUTE_RESOLVER_ID;
const [resolverExists, , fees] = await accountHandler.getDisputeResolver(resolverId);
if (!resolverExists) {
  console.error(`✗ dispute resolver ${resolverId} does not exist on ${config.configId}`);
  process.exit(1);
}

// ⚠️ Named in .env means required, not preferred. Falling back to another token
// the resolver happens to list would price the offer — and take the buyer's
// money — in something nobody configured, so a mismatch is refused rather than
// quietly resolved.
const usable = fees.filter((f) => f.feeAmount.isZero() && f.tokenAddress !== constants.AddressZero);
const wanted = env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase() ?? null;
const fee = wanted ? usable.find((f) => f.tokenAddress.toLowerCase() === wanted) : usable[0];
if (!fee) {
  if (wanted) {
    console.error(`✗ resolver ${resolverId} does not list ${env.EXCHANGE_TOKEN_ADDRESS} at zero fee on ${config.configId}`);
    for (const f of fees) info(`it lists ${f.tokenAddress} (${f.tokenName || "unnamed"}) at fee ${f.feeAmount.toString()}`);
    console.error("  the offer would be rejected at creation — point EXCHANGE_TOKEN_ADDRESS at a token this resolver takes");
  } else {
    console.error("✗ the resolver lists no usable token at zero fee");
  }
  process.exit(1);
}
const exchangeToken = fee.tokenAddress;
if (!wanted) info("EXCHANGE_TOKEN_ADDRESS is unset — taking the resolver's first zero-fee token");

// ⚠️ Read from the token, never assumed. Six decimals is a property of the USDC
// deployed on one chain, not of "the exchange token": the resolver's schedule
// decides what this offer is priced in, so that token's own decimals decide
// what ITEM_PRICE means. A hard-coded 6 against an 18-decimal token underprices
// the item by a factor of a trillion.
const erc20 = new Contract(exchangeToken, abis.ERC20ABI, provider);
const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
ok(`exchange token ${symbol} at ${exchangeToken}, ${decimals} decimals, resolver fee 0`);

const [sellerExists, sellerAccount] = await accountHandler.getSellerByAddress(seller.signer.address);
if (!sellerExists) {
  console.error(`✗ ${seller.signer.address} has no seller account — run \`npm run provision\` first`);
  process.exit(1);
}
ok(`seller account ${sellerAccount.id}`);

// ⚠️ Read the floors rather than trusting a written-down value: an offer below
// either is rejected outright, and they are protocol configuration.
const [minDispute, minResolution] = await Promise.all([
  configHandler.getMinDisputePeriod(),
  configHandler.getMinResolutionPeriod(),
]);
info(`period floors — dispute ${Number(minDispute) / 86_400}d, resolution ${Number(minResolution) / 86_400}d`);

// --- can the buyer actually pay? -------------------------------------------
// The protocol takes the price with transferFrom at commit, so a short balance
// or a short allowance reverts the whole atomic purchase — after both
// signatures have been produced and the relayer has been asked to submit them.
// Two reads on a provider already in hand answer it first instead.
//
// ⚠️ A second-run failure rather than a first-run one: `npm run provision`
// approves exactly the balance, so allowance and balance fall together with
// every purchase and both come up short at the same moment.
step("checking the buyer can pay");
const price = utils.parseUnits(settings.ITEM_PRICE ?? "20", decimals);
const amount = (value) => `${utils.formatUnits(value, decimals)} ${symbol}`;
const [balance, allowance] = await Promise.all([
  erc20.balanceOf(buyer.signer.address),
  erc20.allowance(buyer.signer.address, protocol),
]);
info(`price      ${amount(price)}`);
info(`balance    ${amount(balance)}`);
info(`allowance  ${amount(allowance)} to the protocol`);
if (balance.lt(price)) {
  console.error(`✗ the buyer holds ${amount(balance)} and this offer is priced at ${amount(price)}`);
  console.error(`  fund ${buyer.signer.address} before seeding an exchange`);
  process.exit(1);
}
if (allowance.lt(price)) {
  console.error(`✗ the buyer has approved ${amount(allowance)} and this offer is priced at ${amount(price)}`);
  console.error("  run `npm run provision` to re-grant the allowance");
  process.exit(1);
}
ok("the buyer can pay");

// --- build the offer -------------------------------------------------------
step("building the offer");

// ⚠️ The chain's clock, not this machine's. Every date here is compared against
// block.timestamp, and a local clock running ahead of the node makes the atomic
// redeem revert with nothing on screen to explain it — the offer would simply
// not be redeemable yet. Backdated by a margin on top, so "redeemable from" is
// comfortably in the past rather than equal to a bound that has to hold.
const latestBlock = await provider.getBlock("latest");
const now = latestBlock.timestamp * MS - CLOCK_MARGIN_MS;
info(`chain time ${new Date(latestBlock.timestamp * MS).toISOString()} at block ${latestBlock.number}`);

const deliveryDays = Number(settings.DELIVERY_TIMELINE_DAYS ?? 3);

// The window opens at purchase, not at delivery, so it has to cover shipping
// and inspection — and can never go below the protocol floor.
const requestedDisputePeriodMs = Math.max((deliveryDays + 14) * DAY_MS, Number(minDispute) * MS);
const requestedResolutionPeriodMs = Number(minResolution) * MS;
const metadataUri = settings.OFFER_METADATA_URI ?? "https://held.invalid/offer";

const fullOfferArgsUnsigned = {
  price: price.toString(),
  // ⭐ Zero, and it must stay zero: any deposit obliges the seller to fund
  // escrow before the buyer can commit, which reintroduces a gas-paying step.
  sellerDeposit: 0,
  agentId: 0,
  buyerCancelPenalty: 0,
  quantityAvailable: 1,
  validFromDateInMS: now,
  validUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Must be at or before now, or the atomic redeem in the same transaction
  // reverts.
  voucherRedeemableFromDateInMS: now,
  voucherRedeemableUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Typed optional by the SDK, required in practice: its validation resolves
  // the redeemable-until date with `when("voucherValidDurationInMS", …)` and
  // throws "invalid BigNumber value" naming no field when it is absent. Exactly
  // one of the two must be non-zero; this sets the date.
  voucherValidDurationInMS: 0,
  disputePeriodDurationInMS: requestedDisputePeriodMs,
  resolutionPeriodDurationInMS: requestedResolutionPeriodMs,
  exchangeToken,
  disputeResolverId: resolverId,
  // ⚠️ Validated locally against ipfs://, http(s):// or a CIDv0 — a bare label
  // is rejected before anything is sent.
  metadataUri,
  metadataHash: "held-offer",
  collectionIndex: 0,
  // ⚠️ Typed optional, but signFullOffer reads `feeLimit.toString()` unguarded
  // and throws on undefined.
  feeLimit: price.toString(),
  royaltyInfo: { recipients: [], bps: [] },
  creator: 0, // OfferCreator.Seller — the seller signs, the buyer submits
  offerCreator: seller.signer.address,
  committer: buyer.signer.address,
  sellerId: sellerAccount.id.toString(),
  buyerId: 0,
  // Unconditional: nothing gates who may commit.
  condition: {
    method: 0,
    tokenType: 0,
    tokenAddress: constants.AddressZero,
    gatingType: 0,
    minTokenId: 0,
    maxTokenId: 0,
    threshold: 0,
    maxCommits: 0,
  },
  useDepositedFunds: false,
  sellerOfferParams: {
    collectionIndex: 0,
    royaltyInfo: { recipients: [], bps: [] },
    mutualizerAddress: constants.AddressZero,
  },
  mutualizerAddress: constants.AddressZero,
};

// --- what this run would do ------------------------------------------------
// ⭐ Printed whether or not --execute was passed, so the plan an operator reads
// is the plan that runs: the same reads, the same guards and the same
// construction happen either way, and the only difference below is whether
// anything is signed.
step(execute ? "what this run does" : "what this run would do");
info(`price            ${amount(price)} — ${price.toString()} base units at ${decimals} decimals`);
info(`exchange token   ${symbol} ${exchangeToken}`);
info(`seller           ${seller.signer.address} — account ${sellerAccount.id}`);
info(`buyer            ${buyer.signer.address}`);
info(`dispute resolver ${resolverId}`);
info(`valid            ${new Date(now).toISOString()} → ${new Date(now + 30 * DAY_MS).toISOString()}`);
info(`dispute period   ${requestedDisputePeriodMs / DAY_MS}d, from the redeem`);
info(`resolution       ${requestedResolutionPeriodMs / DAY_MS}d, from a raised dispute`);
info(`metadata         ${metadataUri}`);
info(`tracker          ${trackerId}`);
info(`tracking number  ${trackingNumber}`);
info("then raiseDispute and escalateDispute are signed for that exchange and kept for the watchdog");

if (!execute) {
  console.log("");
  console.log("nothing was signed and nothing was submitted.");
  console.log("Escrow the buyer's money — which cannot be undone — with:");
  console.log(`  npm run seed -- --tracker ${trackerId} --tracking-number ${trackingNumber} --execute`);
  process.exit(0);
}

// --- the seller signs, gaslessly -------------------------------------------
step("the seller signs the offer");
const offerSignature = await seller.coreSDK.signFullOffer({ fullOfferArgsUnsigned });
ok("signed — the seller sends no transaction and pays no gas");

// --- the buyer submits one relayed meta-transaction ------------------------
step("the buyer creates, commits and redeems in one transaction");
const nonce = Date.now();
const signedTx = await buyer.coreSDK.signMetaTxCreateOfferCommitAndRedeem({
  nonce,
  createOfferAndCommitArgs: { ...fullOfferArgsUnsigned, signature: offerSignature.signature },
});

// ⚠️ Its own guard, and the narrowest one in the file. The SDK POSTs the
// transaction to the relayer and only then builds what it returns, so a throw
// here can mean the submission failed — or that it succeeded and the answer was
// lost on the way back. No hash exists locally either way, which is exactly the
// shape that leaves an exchange nobody knows about: there is nothing to print,
// so the message is the whole value.
let tx;
try {
  tx = await buyer.coreSDK.relayMetaTransaction({
    functionName: signedTx.functionName,
    functionSignature: signedTx.functionSignature,
    sigR: signedTx.r,
    sigS: signedTx.s,
    sigV: signedTx.v,
    nonce,
  });
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  console.error("  the relay call failed, but a transaction may already have been submitted:");
  console.error("  the relayer is POSTed before this call returns, and no hash came back to print.");
  console.error(`  check ${buyer.signer.address} on the explorer before re-running — a re-run escrows the price again`);
  process.exit(1);
}

// ⚠️ The transaction is already submitted the moment relayMetaTransaction
// returns — tx.hash exists before wait() is even called, because the relayer
// has already accepted it. wait() can still fail or time out independently of
// what the chain does, and its receipt carries no status field, so a
// meta-transaction that reverted on chain comes back through exactly the same
// path as one that succeeded (scripts/watchdog.mjs states this too). Everything
// from here on, including wait() itself, runs inside one protected span: a
// throw anywhere in it reports what is already known — the hash, then the
// receipt, then the exchange id — rather than dying into a bare stack trace
// with nothing to look the transaction up by. Once a receipt exists the
// exchange id is captured, a record with an empty authorisations list is
// written before either signature is requested, and the two signing calls are
// the last things that can fail.
let receipt;
let exchangeId;
try {
  receipt = await tx.wait();
  ok(`relayed — tx ${explorer(receipt.transactionHash)}`);

  exchangeId = buyer.coreSDK.getCommittedExchangeIdFromLogs(receipt.logs);
  if (!exchangeId) {
    throw new Error("the transaction mined but no exchange id appears in its logs");
  }

  // ⚠️ Not read directly. The relayer resolves on mining and the shipped RPC is
  // a pool, so a read here can be answered by a node that does not have the
  // block — which reads exactly like a failed transaction and is not one.
  const onChain = await waitForState(
    async () => {
      const result = await exchangeHandler.getExchange(exchangeId);
      return result.exists && !result.voucher.redeemedDate.isZero() ? result : null;
    },
    { what: `exchange ${exchangeId} to read as redeemed` }
  );
  const redeemedAt = Number(onChain.voucher.redeemedDate) * MS;

  // The offer the protocol actually created, rather than one predicted before
  // it existed: the id arrives free with the exchange, and the periods the
  // offer was created with are what every deadline in this system counts from.
  const offerId = onChain.exchange.offerId.toString();

  // ⚠️ Tolerated rather than required, unlike the adopt path. This read sits in
  // the window between a live exchange and a written record — the window
  // everything below is arranged to keep short — so a read that fails here must
  // not cost the record. It falls back to what was asked for and says so.
  const { disputePeriodMs, resolutionPeriodMs } = await periodsFor(offerId, {
    disputePeriodMs: requestedDisputePeriodMs,
    resolutionPeriodMs: requestedResolutionPeriodMs,
  });

  ok(`exchange ${exchangeId} is redeemed — the window is open and the seller must fulfil`);
  info(`offer ${offerId} — dispute period ${disputePeriodMs / DAY_MS}d, resolution period ${resolutionPeriodMs / DAY_MS}d`);
  info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);

  // ⭐ The same capture the adopt path uses, deliberately. Recovering an
  // exchange and creating one differ only in how the exchange came to exist;
  // what protecting it means must not drift between the two.
  const captured = await protect({ exchangeId, offerId, redeemedAt, disputePeriodMs, resolutionPeriodMs });

  console.log("");
  console.log(`exchange ${exchangeId} is live and protected by ${captured.join(" and ")}.`);
  console.log(`Confirm receipt with: npm run confirm -- ${exchangeId} --execute`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (receipt && exchangeId) {
    // The commit is in the logs, so the exchange exists whatever failed after
    // it, and it is holding the buyer's money with nothing standing guard.
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error(`  exchange ${exchangeId}`);
    console.error("  this exchange is live and is not yet protected");
    console.error("  protect it — no transaction, only signing and recording — with:");
    console.error(
      `    npm run seed -- --adopt ${exchangeId} --tracker ${trackerId} --tracking-number ${trackingNumber} --execute`
    );
    console.error("  do NOT simply re-run: that escrows the buyer's money a second time");
  } else if (receipt) {
    // ⚠️ A receipt is not a commit. The relayer's receipt carries no status
    // field, so a reverted meta-transaction mines and resolves through exactly
    // the same path as a successful one — and with no BuyerCommitted log there
    // is nothing here to say an exchange was created at all. Calling one live
    // is how an operator ends up hunting for an exchange that never existed.
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error("  the transaction mined but the protocol recorded no commit — the exchange may not exist;");
    console.error("  check it before re-running");
  } else {
    console.error(`  tx ${explorer(tx.hash)}`);
    console.error("  the transaction was submitted but its outcome is unconfirmed — check it before re-running");
  }
  process.exitCode = 1;
}
