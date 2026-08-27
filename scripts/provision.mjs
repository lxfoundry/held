#!/usr/bin/env node
// Provision the accounts a live exchange needs, on whichever configuration
// .env names. Unlike chain-check, this one signs and spends:
//
//   npm run provision              do whatever is missing
//   npm run provision -- --dry-run report only, change nothing
//
// ⭐ It is idempotent and reads its configuration from .env, so it is also the
// migration tool: pointed at another configuration it provisions that one from
// scratch, and pointed at a provisioned one it does nothing and says so.
//
// Two things get set up, and they are set up in opposite ways for the same
// reason — who is expected to hold gas:
//
//   the seller's account   created gaslessly, as a relayed meta-transaction.
//                          The seller in this product is a stranger with a
//                          parcel, not a merchant with a funded wallet, so the
//                          seller must never need native currency. This is also
//                          the first real proof that the relayer relays: a
//                          signature we produce, submitted and paid for by
//                          somebody else.
//
//   the buyer's allowance  a direct transaction, because it cannot be relayed.
//                          Relaying to a token means calling
//                          executeMetaTransaction on the token, and the USDC
//                          deployed here does not implement it. See
//                          docs/chain.md.
//
// The allowance is provisioning, not a step in the purchase: it is granted once
// to the protocol, ahead of any sale, exactly as the wallet is funded once.

import { Contract, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, signerFor, waitForState } from "../src/chain.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
if (args.has("--help") || args.has("-h")) {
  console.log("usage: npm run provision [-- --dry-run]");
  process.exit(0);
}

// The seller's three roles all map to the one wallet. Boson allows them to
// differ — admin controls the account, assistant runs the offers, treasury
// receives the money — and separating them buys this build nothing.
const SELLER_METADATA_URI = "";
const ROYALTY_PERCENTAGE = 0;
const NO_AUTH_TOKEN = 0;

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);
const outstanding = [];
const note = (line) => {
  outstanding.push(line);
  console.log(`⚠ ${line}`);
};

// ⚠️ The resolver id is required here even though it is not read until the very
// end. Everything before that point signs and spends, so a missing id must stop
// the run before the seller account is created rather than after — an unset one
// otherwise surfaces as an opaque encoding error from inside ethers, with two
// real transactions already on the chain.
const { env, config, provider, signer: seller, coreSDK } = connect({
  role: "seller",
  required: ["EXCHANGE_TOKEN_ADDRESS", "DISPUTE_RESOLVER_ID"],
});
const protocol = config.contracts.protocolDiamond;
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`protocol   ${protocol}`);
info(`relayer    ${coreSDK.metaTxConfig?.relayerUrl ?? config.metaTx.relayerUrl}`);
if (dryRun) info("dry run — nothing will be signed or sent");

// --- the wallets -----------------------------------------------------------
// Printed before anything is done, because every failure below is easier to
// read once you know which three accounts are involved. The seller holding no
// native currency is the intended state, not a problem to fix.
step("wallets");
const buyer = signerFor("buyer", env, provider);
const roles = { buyer, seller };
for (const [role, wallet] of Object.entries(roles)) {
  const balance = await provider.getBalance(wallet.address);
  info(`${role.padEnd(7)} ${wallet.address}  ${utils.formatEther(balance)} ETH`);
}

// --- the seller's account --------------------------------------------------
// Read from the protocol rather than the subgraph: the subgraph lags a block or
// two behind, and a script that has just created an account and then asks
// whether it exists must not be told no.
step("seller account");
const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);
const sellerAccount = async () => {
  const [exists, account] = await accountHandler.getSellerByAddress(seller.address);
  return exists ? account : null;
};

let account = await sellerAccount();
if (account) {
  ok(`seller ${account.id} already exists — nothing to do`);
  info(`assistant ${account.assistant}`);
} else if (dryRun) {
  note(`${seller.address} has no seller account — it would be created`);
} else {
  info("creating it as a relayed meta-transaction — the seller signs, the relayer pays");
  // Nonces here are arbitrary and simply marked used, not sequential, so a
  // timestamp is a safe choice and cannot collide with a pre-signed
  // authorisation captured elsewhere.
  const nonce = Date.now();
  const signed = await coreSDK.signMetaTxCreateSeller({
    nonce,
    createSellerArgs: {
      assistant: seller.address,
      admin: seller.address,
      treasury: seller.address,
      contractUri: SELLER_METADATA_URI,
      metadataUri: SELLER_METADATA_URI,
      royaltyPercentage: ROYALTY_PERCENTAGE,
      authTokenId: 0,
      authTokenType: NO_AUTH_TOKEN,
    },
  });
  const tx = await coreSDK.relayMetaTransaction({
    functionName: signed.functionName,
    functionSignature: signed.functionSignature,
    sigR: signed.r,
    sigS: signed.s,
    sigV: signed.v,
    nonce,
  });
  const receipt = await tx.wait();
  // Not read directly: the relay resolves on mining and the shipped RPC is a
  // pool, so the node that answers may not have the block yet. See chain.mjs.
  account = await waitForState(sellerAccount, { what: `the seller account from ${receipt.transactionHash}` });
  ok(`seller ${account.id} created, gaslessly`);
  info(`tx ${explorer(receipt.transactionHash)}`);
  info("the relayer is proven: that signature was submitted and paid for by someone else");
}

// --- the buyer's allowance -------------------------------------------------
// The one thing standing between a signed purchase and a reverted one. The
// protocol takes the money with transferFrom, so without an allowance the
// purchase fails at the last step, having looked correct all the way in.
step("buyer allowance");
const erc20 = new Contract(env.EXCHANGE_TOKEN_ADDRESS, abis.ERC20ABI, provider);
const [symbol, decimals, balance, allowance] = await Promise.all([
  erc20.symbol(),
  erc20.decimals(),
  erc20.balanceOf(buyer.address),
  erc20.allowance(buyer.address, protocol),
]);
const amount = (value) => `${utils.formatUnits(value, decimals)} ${symbol}`;
info(`token      ${env.EXCHANGE_TOKEN_ADDRESS} — ${symbol}`);
info(`balance    ${amount(balance)}`);
info(`allowance  ${amount(allowance)}`);

// ⭐ The target is the balance, not infinity. An unlimited approval is the
// habit that makes a drained wallet a one-signature mistake, and this one is
// re-granted by re-running the script. It is also self-idempotent: spending
// reduces balance and allowance together, so a provisioned buyer stays
// provisioned without another transaction.
if (balance.isZero()) {
  note(`the buyer holds no ${symbol} — fund ${buyer.address} before the first exchange`);
} else if (allowance.gte(balance)) {
  ok("the buyer has approved at least the balance — nothing to do");
} else if (dryRun) {
  note(`the allowance would be raised to ${amount(balance)}`);
} else {
  info("approving directly — the buyer pays this gas once, and never again");
  const tx = await erc20.connect(buyer).approve(protocol, balance);
  const receipt = await tx.wait();
  ok(`approved ${amount(balance)} to the protocol`);
  info(`tx ${explorer(receipt.transactionHash)}`);
}

// --- the dispute resolver --------------------------------------------------
// Registered separately and deliberately not created here: a resolver is an
// identity with a fee schedule, not a per-deployment fixture, and creating one
// by accident on a re-run would leave two of them answering to the same wallet.
step("dispute resolver");
const [exists, resolver, fees] = await accountHandler.getDisputeResolver(env.DISPUTE_RESOLVER_ID);
if (!exists) {
  note(`dispute resolver ${env.DISPUTE_RESOLVER_ID} does not exist on ${config.configId} — register it first`);
} else if (!resolver.active) {
  note(`dispute resolver ${env.DISPUTE_RESOLVER_ID} exists but is not active`);
} else {
  const fee = fees.find((f) => f.tokenAddress.toLowerCase() === env.EXCHANGE_TOKEN_ADDRESS.toLowerCase());
  if (!fee) note(`resolver ${env.DISPUTE_RESOLVER_ID} does not accept ${symbol} — offers priced in it are rejected`);
  else if (!fee.feeAmount.isZero()) note(`resolver ${env.DISPUTE_RESOLVER_ID} charges a fee in ${symbol}`);
  else ok(`dispute resolver ${env.DISPUTE_RESOLVER_ID} active, accepts ${symbol} at zero fee`);
}

// --- verdict ---------------------------------------------------------------
console.log("");
if (outstanding.length) {
  console.log(dryRun ? "would be done:" : "provisioning incomplete:");
  for (const line of outstanding) console.log(`  ⚠ ${line}`);
  process.exit(dryRun ? 0 : 1);
}
console.log("provisioned — the chain path is ready for a live exchange");
console.log(`sanity check with: npm run chain-check`);
