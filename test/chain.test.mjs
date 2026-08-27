import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_ENV_KEYS,
  META_TX_METHOD,
  ROLE_KEYS,
  metaTxOverrideFrom,
  resolveProtocolConfig,
  rpcUrlFor,
  signerFor,
  waitForState,
} from "../src/chain.mjs";

// Nothing here touches the network. These are the checks that decide whether a
// transaction is aimed at the deployment we think it is, and they must hold
// before anything is signed.

const env = () => ({
  CHAIN_ID: "84532",
  BOSON_ENV: "testing",
  BOSON_CONFIG_ID: "testing-84532-0",
});

test("resolves the shipped configuration for a known config id", () => {
  const config = resolveProtocolConfig(env());
  assert.equal(config.configId, "testing-84532-0");
  assert.equal(config.chainId, 84532);
  assert.equal(config.envName, "testing");
  assert.match(config.contracts.protocolDiamond, /^0x[0-9a-fA-F]{40}$/);
});

// The protocol ships the relayer URL; we configure nothing. If an SDK upgrade
// ever drops it, every buyer action loses its gasless path — so this fails
// here rather than at the point of sale.
test("the shipped configuration carries a relayer URL", () => {
  const config = resolveProtocolConfig(env());
  assert.ok(config.metaTx?.relayerUrl, "no relayer URL in the shipped config");
  assert.match(config.metaTx.relayerUrl, /^https:\/\//);
});

test("rejects a config id the SDK does not ship", () => {
  assert.throws(
    () => resolveProtocolConfig({ ...env(), BOSON_CONFIG_ID: "testing-84532-99" }),
    /is not a configuration this SDK ships/
  );
});

// A resolver id, an exchange token and a set of addresses are only meaningful
// together with the configuration they came from. Disagreement between .env
// and the shipped config means one of them is describing another deployment.
test("rejects a chain id that disagrees with the config id", () => {
  assert.throws(() => resolveProtocolConfig({ ...env(), CHAIN_ID: "8453" }), /disagrees with/);
});

test("rejects an environment that disagrees with the config id", () => {
  assert.throws(() => resolveProtocolConfig({ ...env(), BOSON_ENV: "staging" }), /disagrees with/);
});

test("rejects a non-numeric chain id", () => {
  assert.throws(() => resolveProtocolConfig({ ...env(), CHAIN_ID: "base" }), /is not an integer/);
});

test("RPC_URL overrides the shipped default, which is used when it is absent", () => {
  const config = resolveProtocolConfig(env());
  assert.equal(rpcUrlFor(config, env()), config.jsonRpcUrl);
  assert.equal(rpcUrlFor(config, { ...env(), RPC_URL: "https://example.test" }), "https://example.test");
});

test("a role with no key cannot sign, and an unknown role is refused", () => {
  assert.throws(() => signerFor("buyer", env(), null), /BUYER_PRIVATE_KEY is not set/);
  assert.throws(() => signerFor("mediator", env(), null), /unknown role/);
});

// The entitlement property, kept as a test rather than a promise: chain code
// reads wallet keys, so it must not be able to read the tracking key or the
// model provider key. If either ever appears in this list, a component that
// can move funds has been handed a credential it has no business holding.
test("chain code is not entitled to the tracking or model provider keys", () => {
  for (const forbidden of ["SHIP24_API_KEY", "SHIP24_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]) {
    assert.ok(!CHAIN_ENV_KEYS.includes(forbidden), `${forbidden} must not be readable by chain code`);
  }
  const needed = [
    ...Object.values(ROLE_KEYS),
    "META_TX_RELAYER_API_KEY",
    "META_TX_RELAYER_API_ID_PROTOCOL",
    "META_TX_RELAYER_API_ID_EXCHANGE_TOKEN",
  ];
  for (const key of needed) {
    assert.ok(CHAIN_ENV_KEYS.includes(key), `${key} must be readable by chain code`);
  }
});

// ⭐ The protocol id is the one that matters: the purchase is the only buyer
// action this system relays. A second id for the exchange token is supported
// because some chains carry a token that can execute a meta-transaction, but it
// is optional — see docs/chain.md.
const TOKEN = "0x036CBD53842C5426634E7929541EC2318F3DCF7E"; // deliberately mixed case
const credentials = {
  EXCHANGE_TOKEN_ADDRESS: TOKEN,
  META_TX_RELAYER_API_KEY: "key",
  META_TX_RELAYER_API_ID_PROTOCOL: "protocol-id",
};

test("the protocol api id is nested under the diamond address and the method", () => {
  const config = resolveProtocolConfig(env());
  const override = metaTxOverrideFrom(config, credentials);
  const diamond = config.contracts.protocolDiamond.toLowerCase();
  assert.equal(override.apiKey, "key");
  assert.equal(override.apiIds[diamond][META_TX_METHOD], "protocol-id");
  assert.equal(META_TX_METHOD, "executeMetaTransaction");
  // No URL given, so the one shipped in the configuration must stand.
  assert.ok(!("relayerUrl" in override));
});

// The approval is not relayed on this configuration — neither USDC on Base
// Sepolia implements executeMetaTransaction — so the token id is absent in the
// normal case and its absence must not stop the purchase being relayed.
test("the exchange token api id is optional", () => {
  const config = resolveProtocolConfig(env());
  const override = metaTxOverrideFrom(config, credentials);
  assert.deepEqual(Object.keys(override.apiIds), [config.contracts.protocolDiamond.toLowerCase()]);
  assert.ok(!(TOKEN.toLowerCase() in override.apiIds));
});

test("an exchange token api id, when given, is keyed under the token address", () => {
  const config = resolveProtocolConfig(env());
  const override = metaTxOverrideFrom(config, {
    ...credentials,
    META_TX_RELAYER_API_ID_EXCHANGE_TOKEN: "token-id",
  });
  assert.equal(override.apiIds[TOKEN.toLowerCase()][META_TX_METHOD], "token-id");
  // The SDK lowercases the address before looking it up, so a mixed-case
  // address in .env must not produce a key it can never match.
  assert.ok(!(TOKEN in override.apiIds));
});

test("a relayer URL override is carried into the SDK configuration", () => {
  const override = metaTxOverrideFrom(resolveProtocolConfig(env()), {
    ...credentials,
    META_TX_RELAYER_URL: "https://relayer.test",
  });
  assert.equal(override.relayerUrl, "https://relayer.test");
});

// Reads must keep working before the relayer is provisioned, which is why an
// empty environment produces no override rather than an error.
test("no credentials means no override", () => {
  assert.equal(metaTxOverrideFrom(resolveProtocolConfig(env()), {}), undefined);
});

// Caught here rather than inside a relay attempt, where the signature has
// already been produced and the failure reads as a wallet problem.
test("a partial set of relayer credentials is refused", () => {
  const config = resolveProtocolConfig(env());
  for (const missing of ["META_TX_RELAYER_API_KEY", "META_TX_RELAYER_API_ID_PROTOCOL"]) {
    const partial = { ...credentials };
    delete partial[missing];
    assert.throws(() => metaTxOverrideFrom(config, partial), /must be set together/, `missing ${missing}`);
  }
});

// A token id alone relays nothing: the key and the protocol id are what the
// purchase asserts on.
test("an exchange token api id without the key and the protocol id is refused", () => {
  assert.throws(
    () => metaTxOverrideFrom(resolveProtocolConfig(env()), {
      EXCHANGE_TOKEN_ADDRESS: TOKEN,
      META_TX_RELAYER_API_ID_EXCHANGE_TOKEN: "token-id",
    }),
    /must be set together/
  );
});

// The token id has nowhere to live without the address it is keyed on.
test("the exchange token address is required to key the token api id", () => {
  const partial = { ...credentials, META_TX_RELAYER_API_ID_EXCHANGE_TOKEN: "token-id" };
  delete partial.EXCHANGE_TOKEN_ADDRESS;
  assert.throws(
    () => metaTxOverrideFrom(resolveProtocolConfig(env()), partial),
    /EXCHANGE_TOKEN_ADDRESS is required/
  );
});

// ⭐ A read taken straight after a relayed transaction can miss it. The relayer
// resolves its wait as soon as the transaction is mined, and the shipped RPC
// endpoint is a pool of nodes that do not all have that block yet — so a state
// read can be answered by a node still one block behind. Polling the read is
// the only reliable way across: there is nothing to subscribe to.
test("a state read is retried until it returns something", async () => {
  let calls = 0;
  const read = async () => (++calls < 3 ? null : "seller 36");
  assert.equal(await waitForState(read, { what: "a seller", intervalMs: 1, timeoutMs: 500 }), "seller 36");
  assert.equal(calls, 3);
});

// A transient RPC failure is exactly what this loop exists to ride out, so a
// throwing read is retried like an empty one rather than ending the wait.
test("a read that throws is retried, and its error explains a timeout", async () => {
  const read = async () => {
    throw new Error("connection reset");
  };
  await assert.rejects(
    () => waitForState(read, { what: "a seller", intervalMs: 1, timeoutMs: 20 }),
    /timed out .* a seller.*connection reset/s
  );
});

test("a read that never returns anything times out naming what it waited for", async () => {
  await assert.rejects(
    () => waitForState(async () => null, { what: "an exchange id", intervalMs: 1, timeoutMs: 20 }),
    /timed out .* an exchange id/s
  );
});

// Zero is a legitimate result and an empty string is a legitimate uri: the
// wait must key on "answered", not on "truthy", or it spins until it times out
// on a read that succeeded immediately.
test("a falsy but present result ends the wait", async () => {
  assert.equal(await waitForState(async () => 0, { what: "a count", intervalMs: 1, timeoutMs: 20 }), 0);
});
