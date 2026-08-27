#!/usr/bin/env node
// Verify the chain path this build stands on. Reads only: it spends nothing,
// signs nothing and needs no wallet key, so it is safe to run at any time and
// is the first thing to run when something downstream misbehaves.
//
//   npm run chain-check
//
// Each check exists because the failure it catches is otherwise discovered at
// the worst possible moment — an offer rejected at creation, or a signature
// nobody can submit.

import { Contract, Wallet, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { META_TX_METHOD, ROLE_KEYS, connect } from "../src/chain.mjs";

const DAY = 86_400;
const HUNDRED_PERCENT = 10_000; // protocol percentages are basis points

const failures = [];
const pending = [];
const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const warn = (line) => {
  pending.push(line);
  console.log(`⚠ ${line}`);
};
const fail = (line) => {
  failures.push(line);
  console.log(`✗ ${line}`);
};

const days = (seconds) => `${(Number(seconds) / DAY).toFixed(2)} days`;
const percent = (bps) => `${(Number(bps) / HUNDRED_PERCENT) * 100}%`;

// --- 1 · configuration ------------------------------------------------------
const { env, config, provider, coreSDK } = connect();
ok(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`protocol   ${config.contracts.protocolDiamond}`);
info(`rpc        ${env.RPC_URL ? "RPC_URL from .env" : "shipped default (shared, rate-limited)"}`);

// --- 2 · the node ----------------------------------------------------------
try {
  const [network, blockNumber] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  if (network.chainId !== config.chainId) {
    fail(`the node reports chain ${network.chainId}, not ${config.chainId}`);
  } else {
    ok(`node reachable — chain ${network.chainId} at block ${blockNumber}`);
  }
} catch (err) {
  fail(`node unreachable: ${err.shortMessage ?? err.message}`);
}

// --- 3 · protocol limits ---------------------------------------------------
// Not exposed by the SDK, so read from the diamond directly. These are the
// numbers every offer is validated against: an offer below either floor is
// rejected at creation, which is why no window can be shortened for a test.
const configHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonConfigHandlerABI, provider);
let limits;
try {
  const [minDispute, minResolution, maxResolution, maxEscalationResponse, feePercentage, escalationDeposit] =
    await Promise.all([
      configHandler.getMinDisputePeriod(),
      configHandler.getMinResolutionPeriod(),
      configHandler.getMaxResolutionPeriod(),
      configHandler.getMaxEscalationResponsePeriod(),
      // ⚠️ Overloaded — () and (address,uint256). An overloaded name is not
      // bound bare on an ethers contract, so the no-argument form is named in
      // full or the call throws "is not a function".
      configHandler["getProtocolFeePercentage()"](),
      configHandler.getBuyerEscalationDepositPercentage(),
    ]);
  limits = { minDispute, minResolution };
  ok("protocol limits read");
  info(`dispute period      min ${days(minDispute)}`);
  info(`resolution period   min ${days(minResolution)}, max ${days(maxResolution)}`);
  info(`escalation response max ${days(maxEscalationResponse)}`);
  info(`protocol fee        ${percent(feePercentage)}`);
  info(`escalation deposit  ${percent(escalationDeposit)} of the dispute resolver's fee, not of the price`);
} catch (err) {
  fail(`protocol limits unreadable: ${err.shortMessage ?? err.message}`);
}

// --- 4 · the dispute resolver ----------------------------------------------
// The one offer parameter that can fail outright. A resolver that is inactive,
// that does not list the exchange token, or that charges a fee for it breaks
// offer creation — and a non-zero fee would also mean the seller must fund the
// account before committing, and that escalation costs the buyer money. Zero
// is load-bearing in both directions.
const resolverId = env.DISPUTE_RESOLVER_ID;
const token = env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase();
if (!resolverId || !token) {
  fail("DISPUTE_RESOLVER_ID and EXCHANGE_TOKEN_ADDRESS must both be set to check the resolver");
} else {
  const accountHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonAccountHandlerABI, provider);
  try {
    const [exists, resolver, fees, sellerAllowList] = await accountHandler.getDisputeResolver(resolverId);
    if (!exists) {
      fail(`dispute resolver ${resolverId} does not exist on ${config.configId}`);
    } else {
      const label = `dispute resolver ${resolverId} on ${config.configId}`;
      if (resolver.active) ok(`${label} — active`);
      else fail(`${label} exists but is not active`);
      info(`assistant  ${resolver.assistant}`);
      info(`escalation response period ${days(resolver.escalationResponsePeriod)}`);
      info(
        sellerAllowList.length === 0
          ? "seller allow list empty — any seller may use it"
          : `⚠ seller allow list has ${sellerAllowList.length} entries`
      );

      const fee = fees.find((f) => f.tokenAddress.toLowerCase() === token);
      if (!fee) {
        fail(`the resolver does not accept ${token}, so an offer priced in it is rejected at creation`);
      } else if (!fee.feeAmount.isZero()) {
        fail(`the resolver charges ${fee.feeAmount.toString()} in ${fee.tokenName} — the build assumes zero`);
      } else {
        ok(`exchange token accepted at zero fee (${fee.tokenName || token})`);
      }
    }
  } catch (err) {
    fail(`dispute resolver unreadable: ${err.shortMessage ?? err.message}`);
  }
}

// --- 5 · the relayer -------------------------------------------------------
// The protocol runs the relayer and ships its URL, but the URL alone relays
// nothing: relayMetaTransaction asserts on a relayer URL, an API key and an
// API id, and throws before sending if any is missing. isMetaTxConfigSet
// reports exactly that condition, which makes it a real check rather than a
// leftover.
//
// ⚠️ Unprovisioned, the SDK does not even reach its own clean error: the id
// lookup indexes apiIds before testing whether it exists, so a relay attempt
// dies on a TypeError from inside the SDK. Better to say so here.
const relayerUrl = coreSDK.metaTxConfig?.relayerUrl ?? config.metaTx.relayerUrl;
info(`relayer    ${relayerUrl}${env.META_TX_RELAYER_URL ? " (overridden in .env)" : " (shipped in the config)"}`);

// The gateway's own readiness check, for this key and this contract — the same
// GET the SDK makes, called directly. The SDK's own wrapper is a protected
// method, and reaching past that couples this script to a non-public API that
// can be renamed in any release.
const relayerReady = async (contractAddress) => {
  const query = new URLSearchParams({
    apiKey: coreSDK.metaTxConfig.apiKey,
    apiId: coreSDK.metaTxConfig.apiIds[contractAddress.toLowerCase()][META_TX_METHOD],
    contract: contractAddress,
  });
  const response = await fetch(`${relayerUrl}/ready?${query}`, { signal: AbortSignal.timeout(15_000) });
  return response.ok && Boolean((await response.json())?.ready);
};

// ⭐ Only the protocol relay is required. The purchase is the one buyer action
// this system relays, and it is signed against the protocol.
const protocol = config.contracts.protocolDiamond;
if (!env.META_TX_RELAYER_API_KEY || !env.META_TX_RELAYER_API_ID_PROTOCOL) {
  warn("relayer credentials not set — reads work, every relay throws");
  info("set META_TX_RELAYER_API_KEY and META_TX_RELAYER_API_ID_PROTOCOL in .env");
} else if (!coreSDK.checkMetaTxConfigSet({ contractAddress: protocol })) {
  fail(`no relayer api id registered for ${META_TX_METHOD} on the protocol (${protocol})`);
} else {
  try {
    if (await relayerReady(protocol)) ok("relayer ready to relay to the protocol");
    else fail(`relayer does not report ready for the protocol (${protocol})`);
  } catch (err) {
    fail(`relayer readiness check failed for the protocol: ${err.message}`);
  }
}

// ⚠️ The approval is NOT relayed on this configuration, and its api id is
// optional for that reason. Relaying to a token means calling
// executeMetaTransaction on the token, and neither USDC deployed on Base
// Sepolia implements it — so the buyer's allowance is set once, directly, by
// `npm run provision`. An id that is present but not ready is reported rather
// than failed, because nothing in this build depends on it.
if (env.META_TX_RELAYER_API_ID_EXCHANGE_TOKEN) {
  try {
    if (await relayerReady(env.EXCHANGE_TOKEN_ADDRESS)) {
      ok(`relayer ready to relay to the exchange token (${env.EXCHANGE_TOKEN_ADDRESS})`);
      info("unused: the approval is a direct transaction — see docs/chain.md");
    } else {
      warn("an exchange token api id is set but the relayer does not accept it for this token");
      info("nothing depends on it — the approval is set directly by `npm run provision`");
    }
  } catch (err) {
    warn(`the exchange token relay check could not be made: ${err.message}`);
  }
} else {
  info("the approval is not relayed on this chain — set once by `npm run provision`");
}

// Probe the endpoint the SDK itself calls rather than the root: a gateway that
// is up but not routing this API would pass a root check and fail every relay.
try {
  const url = `${relayerUrl}/api/v2/meta-tx/systemInfo?networkId=${config.chainId}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.ok) ok(`relayer answers its own API — HTTP ${response.status}`);
  else fail(`relayer answered HTTP ${response.status} on its own API`);
  info("this proves the gateway is up and routing; it does not prove a relay,");
  info("which needs a real signature and is proven by `npm run provision`");
} catch (err) {
  fail(`relayer unreachable: ${err.message}`);
}

// --- 6 · the exchange token ------------------------------------------------
// The buyer's side of the purchase, in the two numbers that stop it: the money
// and the allowance the protocol needs to take it. Both are read from an
// address derived from the key, which signs nothing — and both are skipped when
// no key is present, so this script still runs with none.
try {
  const erc20 = new Contract(env.EXCHANGE_TOKEN_ADDRESS, abis.ERC20ABI, provider);
  const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  ok(`exchange token responds — ${symbol}, ${decimals} decimals`);

  if (env[ROLE_KEYS.buyer]) {
    const buyer = new Wallet(env[ROLE_KEYS.buyer]).address;
    const [balance, allowance] = await Promise.all([
      erc20.balanceOf(buyer),
      erc20.allowance(buyer, config.contracts.protocolDiamond),
    ]);
    const amount = (value) => `${utils.formatUnits(value, decimals)} ${symbol}`;
    info(`buyer      ${buyer}`);
    if (balance.isZero()) warn("the buyer holds none of the exchange token — no offer can be committed to");
    else info(`balance    ${amount(balance)}`);
    if (allowance.isZero()) {
      warn("the buyer has approved nothing — the purchase reverts when the protocol takes the money");
      info("run `npm run provision` to set it");
    } else {
      info(`allowance  ${amount(allowance)} to the protocol`);
    }
  }
} catch (err) {
  fail(`exchange token unreadable: ${err.shortMessage ?? err.message}`);
}

// --- verdict ---------------------------------------------------------------
console.log("");
if (failures.length) {
  console.log(`${failures.length} check(s) failed:`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exit(1);
}
console.log(pending.length ? "all checks passed, with provisioning still outstanding:" : "all checks passed");
for (const line of pending) console.log(`  ⚠ ${line}`);
if (limits) {
  console.log(
    `offers must set both periods ≥ ${days(limits.minDispute)} / ${days(limits.minResolution)} — ` +
      "calibrate the watchdog by its lead, never by shortening a window"
  );
}
