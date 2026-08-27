# The chain path

Every on-chain action in this system — creating the seller account, signing an offer, the atomic
purchase, raising a dispute, escalating it, resolving it — goes through `@bosonprotocol/core-sdk`,
called directly. There is no tool-server layer between this code and the protocol.

Verify the whole path at any time, without a wallet key and without spending anything:

```
npm run chain-check
```

It reads configuration, the node, the protocol's limits, the dispute resolver, the relayer and the
exchange token, and exits non-zero if any of them is not what the build assumes.

## Pinned versions

| Package | Version | Why this one |
|---|---|---|
| `@bosonprotocol/core-sdk` | `1.48.1-alpha.2` | Matches the deployed `testing` environment. The stable line lags it |
| `@bosonprotocol/ethers-sdk` | `1.18.1-alpha.2` | The `Web3LibAdapter` implementation. Same `@bosonprotocol/common@1.34.0-alpha.2` as the SDK above — they must agree |
| `ethers` | `5.7.2` | ⚠️ **v5, not v6.** `@bosonprotocol/ethers-sdk` declares `ethers@^5.5.0` as a peer dependency, and the SDK's own internals are built on the `@ethersproject/*` v5 packages |
| `lodash` | `4.17.21` | ⚠️ **Not our dependency.** See below |

All four are pinned exactly. An alpha can be republished, and a floating range on a pre-release is a
build that changes underneath you.

⚠️ **`@bosonprotocol/core-sdk@1.48.1-alpha.2` has an undeclared dependency.** It requires
`lodash/groupBy` at import time but does not list `lodash` in its own dependencies, so importing the
SDK throws `Cannot find module 'lodash/groupBy'` unless `lodash` is installed alongside it. It is
declared here to work around that, and it is the *only* reason this repository depends on lodash —
if a later SDK release declares it, drop it from here.

⚠️ **ethers v5 is a constraint, not a preference.** Anything lifted from code written against ethers
v6 needs porting: `BigNumber` is a class with methods (`.isZero()`, `.toString()`) rather than a
native `bigint`, providers live under the `providers` namespace, and typed-data signing differs.

## Configuration comes from the protocol, not from us

The protocol ships its own configuration, keyed by config id: contract addresses, the subgraph, a
default RPC endpoint and the relayer. `src/chain.mjs` reads that configuration and checks it agrees
with `.env` rather than restating it — a restated address is one that can silently disagree with the
chain it names.

What `.env` actually decides is small: which configuration (`BOSON_ENV`, `BOSON_CONFIG_ID`,
`CHAIN_ID`), which dispute resolver and exchange token, an optional RPC override, the relayer
credentials, and the wallet keys. Everything else is read.

⚠️ **A dispute resolver id is only meaningful together with its configuration.** The same number
names unrelated resolvers on different configurations, including on the same chain. The two are
always read together, and `chain-check` reports them together.

The startup checks refuse to proceed when `CHAIN_ID` disagrees with the configuration's chain, when
`BOSON_ENV` disagrees with its environment, or when the configuration carries no relayer URL.

## The relayer

The buyer holds the exchange token and no native currency: every buyer action is a signature, relayed
by someone else who pays the gas. That relayer is **run by the protocol**, and its URL is shipped
inside the protocol configuration.

⚠️ **The URL alone relays nothing.** A relay asserts on a relayer URL, an **API key** and an
**API id**, and throws before sending if any is missing. The credentials are ours to supply:

| `.env` | Required | Notes |
|---|---|---|
| `META_TX_RELAYER_URL` | no | Overrides the URL shipped in the configuration |
| `META_TX_RELAYER_API_KEY` | **yes** | Sent to the gateway as `x-api-key` |
| `META_TX_RELAYER_API_ID_PROTOCOL` | **yes** | The purchase, relayed to the protocol contract |
| `META_TX_RELAYER_API_ID_EXCHANGE_TOKEN` | **yes** | The approval, relayed to the token contract |

⭐ **Two ids, because the buyer signs against two contracts.** The purchase goes to the protocol.
The approval that lets the protocol take the money goes to the exchange token, through
`relayNativeMetaTransaction`, which asserts with the **token** as the contract address. An id is
looked up as `apiIds[contract][method]`, the method defaulting to `executeMetaTransaction`, so an id
registered for one contract is not an id for the other.

⚠️ **A missing token id fails at the approval** — the step before the purchase — which reads as a
wallet problem rather than a relayer one.

`src/chain.mjs` nests both ids under their lowercased addresses. The SDK lowercases the address
before looking it up, so a mixed-case address in `.env` would otherwise build a key it can never
match. The override is merged over the shipped configuration, so the URL and the forwarder ABI
survive when only the credentials are given.

The gateway speaks two endpoints that matter here:

| Endpoint | Used for |
|---|---|
| `GET /api/v2/meta-tx/systemInfo?networkId=<chainId>` | Reachability, and the forwarder domain for the ERC-20-fee path |
| `POST /api/v2/meta-tx/native` | The relay itself — every signed meta-transaction this system sends |

`chain-check` probes `systemInfo` rather than the gateway root, because a gateway that is up but not
routing this API would pass a root check and fail every relay. **It proves the gateway is up and
routing. It does not prove a relay** — that needs a real signature, and is proven by the first live
exchange.

⚠️ **`coreSDK.isMetaTxConfigSet` is a real check, despite appearances.** It tests the same three
fields the relay path asserts on, so `false` means relaying will throw. The field names read as
leftovers from the retired third-party relayer, and they are — but the protocol's own gateway kept
that service's API shape, credentials included. A shipped configuration on its own makes it `false`;
supplying the credentials makes it `true`. It answers **per contract**: pass
`checkMetaTxConfigSet({ contractAddress })` to ask about the exchange token rather than the protocol,
which is what `chain-check` does for both.

⚠️ **Unprovisioned, the SDK never reaches its own clean error.** The id lookup indexes `apiIds`
before testing whether it exists, so a relay attempt with no credentials dies on a `TypeError` from
inside the SDK instead of on the intended "not configured to relay meta transactions" message.
`npm run chain-check` reports the condition directly rather than letting it surface that way.

⚠️ **`systemInfo` returns a stale forwarder domain** on this configuration — a leftover name and an
empty `verifyingContract`. It is consumed only by the ERC-20-fee forwarder path, which this system
does not use: our transactions go through the protocol's own meta-transaction handler and are relayed
by `POST /api/v2/meta-tx/native`. Do not build anything on that response.

## Protocol limits

Read live from the protocol on 27 August 2026, on `testing-84532-0`:

| Limit | Value |
|---|---|
| Minimum dispute period | **7 days** |
| Minimum resolution period | **7 days** |
| Maximum resolution period | 90 days |
| Maximum escalation response period | 90 days |
| Protocol fee | 0.5% |
| Buyer escalation deposit | 10% **of the dispute resolver's fee**, not of the price |

⭐ **Both floors are hard.** An offer with either period below seven days is rejected at creation, so
no window can be shortened to make a test run faster. The watchdog is calibrated by its **lead** —
it acts at `created + (period − lead)`, and the lead is ours to choose — never by shortening a
window. See [`specs/offer-model.md`](./specs/offer-model.md).

⭐ **The dispute resolver's zero fee is load-bearing twice.** It means the seller needs no funds
before a sale, and — because the escalation deposit is a percentage *of that fee* — it means
escalating costs the buyer nothing. `chain-check` fails if the resolver ever charges for the exchange
token, because both properties would break silently.

## Traps worth knowing

⚠️ **`getProtocolFeePercentage` is overloaded** — `()` and `(address,uint256)`. An overloaded name is
not bound bare on an ethers contract, so the no-argument form must be named in full:

```js
configHandler["getProtocolFeePercentage()"]()   // works
configHandler.getProtocolFeePercentage()        // throws "is not a function"
```

⚠️ **Not every protocol limit is on the SDK.** Its protocol-config surface exposes one method. The
period floors, fees and escalation deposit are read from the contract directly, through the ABIs the
SDK re-exports as `abis`.

⚠️ **`src/chain.mjs` has dependencies and `src/receiver.mjs` does not.** The receiver is the one
process exposed to the internet and it stays dependency-free; nothing in it may import the chain
module, directly or transitively.

## Entitlements

`src/chain.mjs` reads only the environment keys chain code is entitled to — the chain settings and
the three wallet keys. The tracking key and the model provider key are excluded by construction, so
code that can move funds cannot read them. There is a test that fails if either is ever added to that
list.

The three wallets are separate accounts on purpose: the buyer holds the exchange token and no native
currency, the seller pays no gas at all, and the dispute resolver only ever decides.
