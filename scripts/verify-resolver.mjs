#!/usr/bin/env node
// Prove the dispute resolver named in .env can actually carry an offer, by
// creating one against it and voiding it again:
//
//   npm run verify-resolver
//   npm run verify-resolver -- --void 118   void an offer a failed run left behind
//
// ⭐ Creation is the only reliable evidence. A resolver can be read as active,
// list the right token at zero fee and still refuse an offer — the allow list,
// the account state and the fee schedule are all checked at creation, together,
// and only then. `chain-check` reads each of them and can still be wrong about
// the one question that matters. So this signs, and then cleans up after itself.
//
// It is worth having as a command rather than as a throwaway, because it is
// needed again on every configuration this build is ever pointed at: a resolver
// id means nothing without its configuration, and moving to another one
// re-provisions everything.
//
// The offer created here is deliberately unusable — quantity 1, priced in the
// token the resolver itself names, and voided in the same run. Nothing commits
// to it and no money moves.

import { Contract, constants, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

// The fallback is a single parameter change, and is stated wherever this fails:
// any resolver on the same configuration whose fee schedule lists the exchange
// token at zero will do, and registration is permissionless.
const fallback = (configId) => {
  console.log("");
  console.log("The resolver cannot carry an offer. Name another one on the same");
  console.log(`configuration (${configId}) whose fee schedule lists the exchange token`);
  console.log("at zero, or register a replacement — registration is permissionless.");
  console.log("Set DISPUTE_RESOLVER_ID in .env and run this again.");
};

const { env, config, provider, signer: seller, coreSDK } = connect({
  role: "seller",
  required: ["DISPUTE_RESOLVER_ID"],
});
const protocol = config.contracts.protocolDiamond;
const resolverId = env.DISPUTE_RESOLVER_ID;
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const configHandler = new Contract(protocol, abis.IBosonConfigHandlerABI, provider);

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`resolver   ${resolverId} (only meaningful together with the configuration above)`);
info(`seller     ${seller.address}`);

// --- what the offer will be built from -------------------------------------
// ⚠️ The exchange token comes from the resolver's own fee schedule, not from
// .env. An offer is valid only if its token is one the resolver lists, so the
// resolver is the authority on that address and .env is a claim about it.
step("reading the resolver");
const [exists, resolver, fees, sellerAllowList] = await accountHandler.getDisputeResolver(resolverId);
if (!exists) {
  console.log(`✗ dispute resolver ${resolverId} does not exist on ${config.configId}`);
  fallback(config.configId);
  process.exit(1);
}
ok(`resolver ${resolverId} exists — ${resolver.active ? "active" : "NOT ACTIVE"}`);
info(
  sellerAllowList.length === 0
    ? "seller allow list empty — any seller may name it"
    : `⚠ seller allow list has ${sellerAllowList.length} entries`
);

// Native currency is listed but unusable — a meta-transaction cannot forward
// msg.value — so it is skipped when falling back to whatever the resolver does
// carry at zero.
const zeroFee = fees.find((fee) => fee.feeAmount.isZero() && fee.tokenAddress !== constants.AddressZero);
const usable = fees.find(
  (fee) => fee.tokenAddress.toLowerCase() === env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase() && fee.feeAmount.isZero()
);
const fee = usable ?? zeroFee;
if (!fee) {
  console.log("✗ the resolver lists no token at zero fee, so no offer this build can make is valid");
  fallback(config.configId);
  process.exit(1);
}
const exchangeToken = fee.tokenAddress;
ok(`exchange token from the fee schedule — ${fee.tokenName || exchangeToken}, fee 0`);
if (env.EXCHANGE_TOKEN_ADDRESS && exchangeToken.toLowerCase() !== env.EXCHANGE_TOKEN_ADDRESS.toLowerCase()) {
  info(`⚠ EXCHANGE_TOKEN_ADDRESS names ${env.EXCHANGE_TOKEN_ADDRESS}, which this resolver does not carry at zero`);
}

// The seller account must already exist: an offer names a seller, and creating
// one here would leave an account behind that the run did not intend to make.
const [sellerExists, sellerAccount] = await accountHandler.getSellerByAddress(seller.address);
if (!sellerExists) {
  console.log(`✗ ${seller.address} has no seller account — run \`npm run provision\` first`);
  process.exit(1);
}
ok(`seller account ${sellerAccount.id}`);

// ⚠️ Read the floors rather than trusting a written-down value. They are
// protocol configuration and an offer below either one is rejected outright, so
// a stale constant here fails the very thing this script exists to prove.
const [minDispute, minResolution] = await Promise.all([
  configHandler.getMinDisputePeriod(),
  configHandler.getMinResolutionPeriod(),
]);
const MS = 1000;
const DAY_MS = 86_400 * MS;
info(`period floors — dispute ${Number(minDispute) / 86_400}d, resolution ${Number(minResolution) / 86_400}d`);

const relay = async (signed, nonce) => {
  const tx = await coreSDK.relayMetaTransaction({
    functionName: signed.functionName,
    functionSignature: signed.functionSignature,
    sigR: signed.r,
    sigS: signed.s,
    sigV: signed.v,
    nonce,
  });
  return tx.wait();
};

// ⚠️ `isOfferVoided` returns TWO booleans — (exists, offerVoided) — not one.
// Awaiting it yields an array, and an array is always truthy, so `if (await
// isOfferVoided(id))` reports every offer as voided including live ones. It did
// exactly that here before this existed.
const isVoided = async (id) => {
  const [exists, offerVoided] = await offerHandler.isOfferVoided(id);
  return exists && offerVoided;
};

const voidOffer = async (id) => {
  const nonce = Date.now();
  const voidReceipt = await relay(await coreSDK.signMetaTxVoidOffer({ nonce, offerId: id }), nonce);
  await waitForState(async () => (await isVoided(id)) || null, {
    what: `offer ${id} to read as voided`,
  });
  ok(`offer ${id} voided — nothing can commit to it`);
  info(`tx ${explorer(voidReceipt.transactionHash)}`);
};

// ⭐ A run that dies between creating and voiding leaves a live offer behind,
// and the first run of this script did exactly that. `--void <id>` finishes the
// job by hand rather than leaving something committable on a configuration
// about to be demonstrated.
const voidOnly = process.argv.indexOf("--void");
if (voidOnly !== -1) {
  const id = process.argv[voidOnly + 1];
  if (!id) {
    console.log("✗ --void needs an offer id");
    process.exit(1);
  }
  step(`voiding offer ${id}`);
  if (await isVoided(id)) {
    ok(`offer ${id} was already voided — nothing to do`);
  } else {
    await voidOffer(id);
  }
  process.exit(0);
}

// --- the throwaway offer ---------------------------------------------------
// Built at the floors on purpose: an offer that satisfies the minimum is the
// strongest evidence, because anything the protocol would reject on duration is
// rejected here rather than at the moment it matters.
step("creating a throwaway offer");
const now = Date.now();
const createOfferArgs = {
  price: utils.parseUnits("1", 6).toString(),
  sellerDeposit: 0,
  agentId: 0,
  buyerCancelPenalty: 0,
  quantityAvailable: 1,
  validFromDateInMS: now,
  validUntilDateInMS: now + 30 * DAY_MS,
  voucherRedeemableFromDateInMS: now,
  voucherRedeemableUntilDateInMS: now + 30 * DAY_MS,
  disputePeriodDurationInMS: Number(minDispute) * MS,
  resolutionPeriodDurationInMS: Number(minResolution) * MS,
  // ⚠️ Typed optional by the SDK, but required in practice. Its validation
  // schema resolves voucherRedeemableUntil with `when("voucherValidDurationInMS",
  // { is: isZero })`, and `isZero(undefined)` throws "invalid BigNumber value"
  // from inside yup — an error that names no field and reads like a bad offer.
  // Exactly one of the two must be non-zero; this build sets the date.
  voucherValidDurationInMS: 0,
  exchangeToken,
  disputeResolverId: resolverId,
  // ⚠️ Validated locally: it must match ipfs://, http(s):// or a CIDv0, and a
  // bare label is rejected before anything is sent. `.invalid` is the reserved
  // TLD that can never resolve (RFC 2606) — so this is a well-formed uri that is
  // honestly not a location, rather than an ipfs:// hash pointing at nothing.
  // Nothing reads it: the offer is voided in this same run.
  metadataUri: "https://held.invalid/resolver-verification",
  metadataHash: "held-resolver-verification",
  collectionIndex: 0,
};

// The id the protocol will assign, read before the fact. There are no log
// helpers on the SDK for this, and predicting it beats parsing receipts.
const offerId = (await offerHandler.getNextOfferId()).toString();
info(`offer id will be ${offerId}`);

// ⭐ Signing and relaying are caught separately, and only one of them says
// anything about the resolver. A failure while signing is ours — the SDK
// validates the offer locally first, and those errors name no field and read
// exactly like a rejection. Blaming the resolver for them sends the next person
// to change a parameter that was never wrong.
const nonce = Date.now();
let signed;
try {
  signed = await coreSDK.signMetaTxCreateOffer({ nonce, createOfferArgs });
} catch (err) {
  console.log(`✗ the offer was rejected before it was sent: ${err.shortMessage ?? err.message}`);
  console.log("  That is a fault in the offer this script builds, not in the resolver.");
  process.exit(1);
}

let receipt;
try {
  receipt = await relay(signed, nonce);
} catch (err) {
  console.log(`✗ the protocol refused the offer: ${err.shortMessage ?? err.message}`);
  fallback(config.configId);
  process.exit(1);
}

// ⚠️ Not read directly — the relay resolves on mining and the shipped RPC is a
// pool, so a read here can be answered by a node that does not have the block.
const created = await waitForState(
  async () => {
    const result = await offerHandler.getOffer(offerId);
    return result.exists ? result : null;
  },
  { what: `offer ${offerId} from ${receipt.transactionHash}` }
);
ok(`offer ${offerId} created, gaslessly — the resolver carries it`);
info(`tx ${explorer(receipt.transactionHash)}`);

// ⭐ From here the offer exists, so every remaining failure is recorded and
// reported *after* the void rather than instead of it. An assertion that exits
// early leaves a live offer on the configuration — which is exactly what this
// script must not do, and what a first run of it did.
let problem = null;
try {
  const { offer, offerDurations: durations, disputeResolutionTerms: terms } = created;
  info(`seller ${offer.sellerId} · resolver ${terms.disputeResolverId} · ${offer.exchangeToken}`);

  // ⚠️ The resolver id is in disputeResolutionTerms, not in the offer struct.
  if (terms.disputeResolverId.toString() !== resolverId.toString()) {
    throw new Error(`the offer names resolver ${terms.disputeResolverId}, not ${resolverId}`);
  }
  if (durations.disputePeriod.toString() !== minDispute.toString()) {
    throw new Error(`dispute period ${durations.disputePeriod} was accepted, not the floor ${minDispute}`);
  }

  // ⭐ The zero fee doing its second job, read back from the protocol rather
  // than asserted: the buyer's escalation deposit derives from this fee, not
  // from the item price, so a zero fee is what makes escalation free.
  ok(`resolver fee ${terms.feeAmount} — buyer escalation deposit ${terms.buyerEscalationDeposit}`);
  if (!terms.buyerEscalationDeposit.isZero()) {
    throw new Error("escalation would cost the buyer, which the escalation ladder assumes it does not");
  }
} catch (err) {
  problem = err;
}

// --- discard it ------------------------------------------------------------
// Voiding is not tidiness. A live offer on a configuration that is about to be
// demonstrated is an offer somebody can commit to, and this one was built to
// prove a point rather than to sell anything.
step("voiding it");
await voidOffer(offerId);

if (problem) {
  console.log(`✗ ${problem.message}`);
  process.exit(1);
}

console.log("");
console.log(`dispute resolver ${resolverId} on ${config.configId} is proven: it accepted an offer`);
console.log("at the protocol's period floors, priced in the token its own fee schedule names.");
