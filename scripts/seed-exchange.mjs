#!/usr/bin/env node
// Create one exchange, end to end, and capture what the deadline logic needs.
//
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn>
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

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const MS = 1000;
const DAY_MS = 86_400 * MS;

const trackerId = arg("tracker");
const trackingNumber = arg("tracking-number");
if (!trackerId || !trackingNumber) {
  console.error("✗ usage: node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <trackingNumber>");
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
const fee =
  fees.find(
    (f) => f.tokenAddress.toLowerCase() === env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase() && f.feeAmount.isZero()
  ) ?? fees.find((f) => f.feeAmount.isZero() && f.tokenAddress !== constants.AddressZero);
if (!fee) {
  console.error("✗ the resolver lists no usable token at zero fee");
  process.exit(1);
}
const exchangeToken = fee.tokenAddress;
ok(`exchange token ${fee.tokenName || exchangeToken}, resolver fee 0`);

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

// --- build the offer -------------------------------------------------------
step("building the offer");
const now = Date.now();
const deliveryDays = Number(settings.DELIVERY_TIMELINE_DAYS ?? 3);

// The window opens at purchase, not at delivery, so it has to cover shipping
// and inspection — and can never go below the protocol floor.
const disputePeriodMs = Math.max((deliveryDays + 14) * DAY_MS, Number(minDispute) * MS);
const resolutionPeriodMs = Number(minResolution) * MS;
info(`dispute period ${disputePeriodMs / DAY_MS}d · resolution period ${resolutionPeriodMs / DAY_MS}d`);

const price = utils.parseUnits(settings.ITEM_PRICE ?? "20", 6).toString();

const fullOfferArgsUnsigned = {
  price,
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
  disputePeriodDurationInMS: disputePeriodMs,
  resolutionPeriodDurationInMS: resolutionPeriodMs,
  exchangeToken,
  disputeResolverId: resolverId,
  // ⚠️ Validated locally against ipfs://, http(s):// or a CIDv0 — a bare label
  // is rejected before anything is sent.
  metadataUri: settings.OFFER_METADATA_URI ?? "https://held.invalid/offer",
  metadataHash: "held-offer",
  collectionIndex: 0,
  // ⚠️ Typed optional, but signFullOffer reads `feeLimit.toString()` unguarded
  // and throws on undefined.
  feeLimit: price,
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

// --- the seller signs, gaslessly -------------------------------------------
step("the seller signs the offer");
const offerSignature = await seller.coreSDK.signFullOffer({ fullOfferArgsUnsigned });
ok("signed — the seller sends no transaction and pays no gas");

// --- the buyer submits one relayed meta-transaction ------------------------
step("the buyer creates, commits and redeems in one transaction");
const offerId = (await offerHandler.getNextOfferId()).toString();
info(`offer id will be ${offerId}`);

const nonce = Date.now();
const signedTx = await buyer.coreSDK.signMetaTxCreateOfferCommitAndRedeem({
  nonce,
  createOfferAndCommitArgs: { ...fullOfferArgsUnsigned, signature: offerSignature.signature },
});

const tx = await buyer.coreSDK.relayMetaTransaction({
  functionName: signedTx.functionName,
  functionSignature: signedTx.functionSignature,
  sigR: signedTx.r,
  sigS: signedTx.s,
  sigV: signedTx.v,
  nonce,
});
const receipt = await tx.wait();
ok(`relayed — tx ${explorer(receipt.transactionHash)}`);

// ⚠️ The transaction above is already mined: the offer was created, committed
// and redeemed, and the buyer's money is escrowed. Nothing from here on can be
// "undone" by a script failure — it can only fail to finish recording what
// already happened on-chain. So the exchange id is captured first, a record
// with an empty authorisations list is written before either signature is
// requested, and everything in between is wrapped: a failure anywhere in this
// span must say, loudly, that a live exchange exists and is not protected —
// never die into a bare stack trace that leaves it invisible to the store and
// the watchdog both.
let exchangeId;
try {
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
  ok(`exchange ${exchangeId} is redeemed — the window is open and the seller must fulfil`);
  info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);

  // --- write the record, unprotected, before anything is signed ------------
  // ⭐ Every field the finished record carries, so this already satisfies the
  // store's shape check and needs no special-casing later — only
  // `authorisations` changes, from empty to whatever actually got captured.
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

  // --- capture the two authorisations ---------------------------------------
  // ⭐ The second signing step, and the reason it is here rather than earlier.
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

  console.log("");
  console.log(`exchange ${exchangeId} is live and protected by ${authorisations.list(exchangeId).join(" and ")}.`);
  console.log(`Confirm receipt with: npm run confirm -- ${exchangeId}`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  console.error(`  tx ${explorer(receipt.transactionHash)}`);
  if (exchangeId) console.error(`  exchange ${exchangeId}`);
  console.error("  this exchange is live and is not yet protected");
  process.exitCode = 1;
}
