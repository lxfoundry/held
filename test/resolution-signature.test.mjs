import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreSDK, getConfigFromConfigId } from "@bosonprotocol/core-sdk";
import { EthersAdapter } from "@bosonprotocol/ethers-sdk";
import { utils, Wallet } from "ethers";
import { signConsent } from "../src/resolution.mjs";

// ⭐ No chain, no provider, no configured environment. Signing typed data is a
// local operation on a key: the adapter answers eth_signTypedData_v4 from the
// wallet itself rather than forwarding it to a node, so this whole file runs
// against the protocol's own shipped configuration and nothing else.
const CONFIG_ID = "testing-84532-0";

function signerFor() {
  const config = getConfigFromConfigId(CONFIG_ID);
  const wallet = Wallet.createRandom();
  const coreSDK = CoreSDK.fromDefaultConfig({
    web3Lib: new EthersAdapter(undefined, wallet),
    envName: config.envName,
    configId: config.configId,
  });
  return { config, wallet, coreSDK };
}

// ⚠️ Restated here on purpose, and nowhere else. src/resolution.mjs asks the
// SDK what the domain is rather than declaring one, which is right — a restated
// domain is one that can silently disagree with the contract that verifies it.
// The cost of deriving it is that nothing would notice if it changed, so the
// independent statement of it lives here, where a change fails a test instead
// of a transaction.
//
// Note what is absent: chainId. Boson puts the chain into `salt` and its
// EIP712Domain carries no chainId field at all.
const domainFor = (config) => ({
  name: "Boson Protocol",
  version: "V2",
  verifyingContract: config.contracts.protocolDiamond,
  salt: utils.hexZeroPad(utils.hexlify(config.chainId), 32),
});

const RESOLUTION = {
  Resolution: [
    { name: "exchangeId", type: "uint256" },
    { name: "buyerPercentBasisPoints", type: "uint256" },
  ],
};

test("⭐ a consent recovers to the address that signed it", async () => {
  const { config, wallet, coreSDK } = signerFor();

  const consent = await signConsent({ coreSDK, exchangeId: "241", buyerPercent: 25 });

  const recovered = utils.verifyTypedData(
    domainFor(config),
    RESOLUTION,
    { exchangeId: "241", buyerPercentBasisPoints: "2500" },
    utils.joinSignature({ r: consent.r, s: consent.s, v: consent.v })
  );
  assert.equal(recovered, wallet.address);
  assert.equal(consent.signedBy, wallet.address);
});

// ⚠️ Direction, not arithmetic. Both of these recover, and both are valid
// signatures — over different agreements. Signing the seller's share instead of
// the buyer's pays the wrong party in full, and no later check would catch it.
test("⭐ 20% is a consent to the buyer's 2000, not to the seller's 8000", async () => {
  const { config, wallet, coreSDK } = signerFor();

  const consent = await signConsent({ coreSDK, exchangeId: "241", buyerPercent: 20 });
  assert.equal(consent.buyerPercentBasisPoints, 2000);

  const signature = utils.joinSignature({ r: consent.r, s: consent.s, v: consent.v });
  const domain = domainFor(config);
  assert.equal(
    utils.verifyTypedData(domain, RESOLUTION, { exchangeId: "241", buyerPercentBasisPoints: "2000" }, signature),
    wallet.address
  );
  // The inverted reading is a different message, so it recovers to somebody
  // else. That it recovers to *anything* is the trap: an inverted consent is a
  // well-formed signature over an agreement nobody made.
  assert.notEqual(
    utils.verifyTypedData(domain, RESOLUTION, { exchangeId: "241", buyerPercentBasisPoints: "8000" }, signature),
    wallet.address
  );
});

test("a consent binds the exchange it names, so it cannot be moved to another", async () => {
  const { config, wallet, coreSDK } = signerFor();

  const consent = await signConsent({ coreSDK, exchangeId: "241", buyerPercent: 25 });
  const signature = utils.joinSignature({ r: consent.r, s: consent.s, v: consent.v });

  assert.notEqual(
    utils.verifyTypedData(
      domainFor(config), RESOLUTION,
      { exchangeId: "242", buyerPercentBasisPoints: "2500" }, signature
    ),
    wallet.address
  );
});

test("a percentage outside 0-100 is refused before anything is signed", async () => {
  const { coreSDK } = signerFor();
  await assert.rejects(() => signConsent({ coreSDK, exchangeId: "241", buyerPercent: 120 }), RangeError);
});

// The two ends of the range are legal agreements — the whole pot to one party —
// and the protocol takes them. Nothing here may quietly narrow the action space
// the model is allowed to propose over.
test("the ends of the range sign as readily as the middle", async () => {
  const { coreSDK } = signerFor();
  assert.equal((await signConsent({ coreSDK, exchangeId: "241", buyerPercent: 0 })).buyerPercentBasisPoints, 0);
  assert.equal((await signConsent({ coreSDK, exchangeId: "241", buyerPercent: 100 })).buyerPercentBasisPoints, 10000);
});
