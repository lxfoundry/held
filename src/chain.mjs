// Chain access: the single place that turns .env plus the protocol's own
// shipped configuration into a Core SDK instance.
//
// ⚠️ This module has dependencies and the receiver does not. Nothing in
// src/receiver.mjs may import it, directly or transitively — the one process
// exposed to the internet keeps its zero-dependency supply chain.
//
// ⭐ Almost none of this is our configuration. The protocol ships its own,
// keyed by config id: contract addresses, subgraph, a default RPC, and the
// relayer that pays the gas for every buyer action. We read that config and
// check it agrees with .env rather than restating it, because a restated
// address is one that can silently disagree with the chain it names.
//
// ⚠️ A config id is only meaningful with its environment: the same numeric
// dispute resolver id names unrelated resolvers on different configurations,
// including on the same chain. Both are read together, always.

import { CoreSDK, getConfigFromConfigId } from "@bosonprotocol/core-sdk";
import { EthersAdapter } from "@bosonprotocol/ethers-sdk";
import { providers, Wallet } from "ethers";
import { loadEnv } from "./env.mjs";

// The keys chain code is entitled to read. The tracking key and the model
// provider key are deliberately absent: code that can move funds has no
// business holding either, and passing `only` makes that structural rather
// than a claim in a document.
export const CHAIN_ENV_KEYS = [
  "CHAIN_ID",
  "RPC_URL",
  "BOSON_ENV",
  "BOSON_CONFIG_ID",
  "EXCHANGE_TOKEN_ADDRESS",
  "DISPUTE_RESOLVER_ID",
  "META_TX_RELAYER_URL",
  "META_TX_RELAYER_API_KEY",
  "META_TX_RELAYER_API_ID_PROTOCOL",
  "META_TX_RELAYER_API_ID_EXCHANGE_TOKEN",
  "BUYER_PRIVATE_KEY",
  "SELLER_PRIVATE_KEY",
  "DISPUTE_RESOLVER_PRIVATE_KEY",
];

// Which key each participant signs with. The three are separate accounts on
// purpose: the buyer holds the exchange token and no native currency, the
// seller pays no gas at all, and the resolver only ever decides.
export const ROLE_KEYS = {
  buyer: "BUYER_PRIVATE_KEY",
  seller: "SELLER_PRIVATE_KEY",
  disputeResolver: "DISPUTE_RESOLVER_PRIVATE_KEY",
};

// ⭐ What a component that only *relays* is entitled to read: everything except
// the two wallets that can move the parties' funds.
//
// Relaying a pre-signed meta-transaction needs no local signer at all. The
// instruction is already signed — function name, signature, r/s/v and nonce all
// come out of the stored authorisation — and the relayer submits it, so the only
// address involved arrives as data. The reads alongside it go through the
// provider. A process that holds a key it never uses is holding a liability, and
// this list is what stops it happening by accident.
export const RELAY_ONLY_ENV_KEYS = CHAIN_ENV_KEYS.filter(
  (key) => key !== ROLE_KEYS.buyer && key !== ROLE_KEYS.seller
);

const REQUIRED_ALWAYS = ["CHAIN_ID", "BOSON_ENV", "BOSON_CONFIG_ID"];

export function loadChainEnv({ required = [], only = CHAIN_ENV_KEYS } = {}) {
  const missing = required.filter((key) => !only.includes(key));
  if (missing.length) {
    // Otherwise the narrowing silently wins and the caller gets "missing
    // required environment" for a key that is sitting in .env.
    throw new Error(
      `${missing.join(", ")} is required but not among the keys this component may read`
    );
  }
  return loadEnv({
    only,
    required: [...new Set([...REQUIRED_ALWAYS, ...required])],
  });
}

// Resolves the protocol's shipped configuration and refuses to proceed if it
// disagrees with .env. Every check here is one that would otherwise surface as
// a failed transaction against the wrong deployment.
export function resolveProtocolConfig(env) {
  const configId = env.BOSON_CONFIG_ID;
  let config;
  try {
    config = getConfigFromConfigId(configId);
  } catch {
    config = undefined;
  }
  if (!config) {
    throw new Error(`BOSON_CONFIG_ID "${configId}" is not a configuration this SDK ships`);
  }

  const declaredChainId = Number(env.CHAIN_ID);
  if (!Number.isInteger(declaredChainId)) {
    throw new Error(`CHAIN_ID "${env.CHAIN_ID}" is not an integer`);
  }
  if (config.chainId !== declaredChainId) {
    throw new Error(
      `CHAIN_ID ${declaredChainId} disagrees with ${configId}, which is chain ${config.chainId}`
    );
  }
  if (config.envName !== env.BOSON_ENV) {
    throw new Error(
      `BOSON_ENV "${env.BOSON_ENV}" disagrees with ${configId}, which is "${config.envName}"`
    );
  }

  // Without a relayer there is no gasless path, and every buyer action in this
  // system is a meta-transaction. Failing here beats failing at the point of
  // sale with a signature nobody can submit.
  if (!config.metaTx?.relayerUrl) {
    throw new Error(`${configId} ships no metaTx.relayerUrl, so no action can be relayed`);
  }

  return config;
}

// The protocol's own RPC is the default. RPC_URL overrides it — the shipped
// one is shared and rate-limited, which is fine for reads and not for a demo.
export function rpcUrlFor(config, env) {
  return env.RPC_URL || config.jsonRpcUrl;
}

export function createProvider(config, env) {
  // Static: the chain id is known from the config, so the provider must not
  // discover it, and must not quietly follow a node that changed its mind.
  return new providers.StaticJsonRpcProvider(rpcUrlFor(config, env), config.chainId);
}

export function signerFor(role, env, provider) {
  const key = ROLE_KEYS[role];
  if (!key) throw new Error(`unknown role "${role}"`);
  if (!env[key]) throw new Error(`${key} is not set, so the ${role} cannot sign`);
  return new Wallet(env[key], provider);
}

// The relayer credentials, in the shape the SDK asserts on.
//
// The protocol runs the relayer and ships its URL, but the SDK still requires a
// relayer URL, an API key AND an API id before it will relay anything: the relay
// call goes through assertAndGetMetaTxConfig, which throws without all three.
//
// The id is looked up as apiIds[contract][method], so an id registered for one
// contract is not an id for the other. The purchase goes to the protocol, so
// META_TX_RELAYER_API_ID_PROTOCOL is the one that must be present.
//
// ⚠️ An id for the exchange token is supported and optional, because on this
// chain the approval is not relayable at all: relaying to a token means calling
// executeMetaTransaction on it, and neither USDC deployed on Base Sepolia
// implements that method. The buyer's allowance is therefore set once, directly,
// as provisioning — see docs/chain.md and scripts/provision.mjs. The plumbing
// stays because a chain whose token does implement it needs nothing else.
//
// The override is merged over the shipped configuration, so the URL and the
// forwarder ABI survive when only the credentials are given.
export const META_TX_METHOD = "executeMetaTransaction";

export function metaTxOverrideFrom(config, env) {
  const relayerUrl = env.META_TX_RELAYER_URL;
  const apiKey = env.META_TX_RELAYER_API_KEY;
  const protocolApiId = env.META_TX_RELAYER_API_ID_PROTOCOL;
  const tokenApiId = env.META_TX_RELAYER_API_ID_EXCHANGE_TOKEN;

  // Nothing provisioned: reads work, relaying does not. Say nothing and let the
  // shipped configuration stand.
  const given = [apiKey, protocolApiId].filter(Boolean).length;
  if (given === 0 && !tokenApiId) return relayerUrl ? { relayerUrl } : undefined;

  // A partial set is the failure worth catching here. Left to the SDK it
  // surfaces deep inside a relay attempt, against a signature already produced.
  if (given < 2) {
    throw new Error(
      "META_TX_RELAYER_API_KEY and META_TX_RELAYER_API_ID_PROTOCOL must be set together, or neither"
    );
  }
  if (tokenApiId && !env.EXCHANGE_TOKEN_ADDRESS) {
    throw new Error("EXCHANGE_TOKEN_ADDRESS is required to key the exchange token's relayer api id");
  }

  return {
    ...(relayerUrl ? { relayerUrl } : {}),
    apiKey,
    apiIds: {
      [config.contracts.protocolDiamond.toLowerCase()]: { [META_TX_METHOD]: protocolApiId },
      ...(tokenApiId
        ? { [env.EXCHANGE_TOKEN_ADDRESS.toLowerCase()]: { [META_TX_METHOD]: tokenApiId } }
        : {}),
    },
  };
}

// ⭐ Read state back after a relayed transaction with this, never directly.
//
// The relayer's own wait resolves as soon as the transaction is mined, but the
// RPC endpoint the protocol ships is a pool of nodes rather than one node, and
// they do not all have that block at the same instant. A state read taken
// immediately afterwards can therefore be answered by a node one block behind
// and report, quite truthfully, that nothing happened — which reads exactly
// like a failed transaction and is not one.
//
// There is nothing to subscribe to here, so polling is the mechanism. `read`
// returns null or undefined for "not yet" and anything else — including 0 and
// the empty string — as the answer. A read that throws is retried too: a
// transient RPC error is precisely the condition this rides out, and the last
// one is reported if the wait times out, so a genuine fault is still legible.
export async function waitForState(read, { what, timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const result = await read();
      if (result !== null && result !== undefined) return result;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const seconds = (timeoutMs / 1000).toFixed(0);
      throw new Error(
        `timed out after ${seconds}s waiting for ${what}` +
          (lastError ? `; the last read failed with: ${lastError.message}` : "")
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function createCoreSDK({ config, provider, signer, env = {} }) {
  return CoreSDK.fromDefaultConfig({
    web3Lib: new EthersAdapter(provider, signer),
    envName: config.envName,
    configId: config.configId,
    metaTx: metaTxOverrideFrom(config, env),
  });
}

// One call for the common case. `role` is optional: reads need no key at all,
// which is what keeps the verification script runnable before any wallet has
// been provisioned.
//
// `envKeys` narrows what is read at all — pass RELAY_ONLY_ENV_KEYS from a
// component that must not be able to sign as the buyer or the seller even by
// mistake. Narrowing and a role that needs an excluded key contradict each
// other, and loadChainEnv refuses rather than picking one.
export function connect({ role = null, required = [], envKeys = CHAIN_ENV_KEYS } = {}) {
  const env = loadChainEnv({
    only: envKeys,
    required: role ? [...required, ROLE_KEYS[role]] : required,
  });
  const config = resolveProtocolConfig(env);
  const provider = createProvider(config, env);
  const signer = role ? signerFor(role, env, provider) : undefined;
  return { env, config, provider, signer, coreSDK: createCoreSDK({ config, provider, signer, env }) };
}
