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

Set up the accounts that path needs — the seller's account and the buyer's allowance — with:

```
npm run provision              # do whatever is missing
npm run provision -- --dry-run # report only
```

It is idempotent and takes its target from `.env`, so it is also the migration tool: pointed at
another configuration it provisions that one from scratch. It is the first thing that proves the
relayer end to end, because the seller's account is created **gaslessly**, from a wallet holding no
native currency at all.

## Creating and completing an exchange

Two commands move money, and they are the only two here that do:

```
npm run seed -- --tracker <trackerId> --tracking-number <trackingNumber>
npm run confirm -- <exchangeId>
```

⭐ **Both plan and stop unless `--execute` is passed.** Run as above, each performs every read and
every guard, prints exactly what it would do — for `seed` the offer terms, the periods and the price
at the token's own decimals; for `confirm` the exchange, its state and what completing it pays — and
then stops. **Nothing is submitted and no money moves, so there is nothing to undo.** `--execute` is
what makes either one real, and it means the same thing in both:

```
npm run seed -- --tracker <trackerId> --tracking-number <trackingNumber> --execute
npm run confirm -- <exchangeId> --execute
```

⚠️ **A planning run of `seed` does sign the seller's offer** — locally, off-chain, sent nowhere.
Building and signing the offer is where a bad price, a bad period or a missing field is actually
caught, so a plan that skipped it would not be planning the run that happens. The claim `--execute`
carries is about **submitting**, not about signing: without it nothing reaches the relayer and no
money moves. (`--adopt`, below, signs nothing without `--execute`.)

⚠️ **Every value is the next argument, never joined with `=`.** `--tracker=T` and `--adopt=239` are
refused rather than half-understood — the parser reads `--flag value`, so an `=`-joined value would
otherwise read as though the flag had never been passed at all.

⚠️ **`seed --execute` escrows the buyer's money.** One relayed meta-transaction creates the offer,
commits to it and redeems it: the price leaves the buyer's wallet at the commit, and there is no
buyer-side cancel after the redeem — the money leaves escrow when the buyer confirms receipt, when a
raised dispute is resolved, or when the window lapses, which pays the seller. The same run then
captures the buyer's two pre-signed authorisations, `raiseDispute` and `escalateDispute`, and writes
the record the watchdog sweeps. They cannot be signed any earlier, because the exchange id they are
scoped to does not exist until the purchase is mined, and an exchange without them is unprotected —
which the script says out loud.

It also refuses to seed one parcel twice: a tracker already named by an unfinalised exchange is
rejected rather than quietly escrowing a second lot of the buyer's money for one delivery. `--force`
overrides that, deliberately and loudly.

### Adopting an exchange that is already live

```
npm run seed -- --adopt <exchangeId> --tracker <trackerId> --tracking-number <trackingNumber>
npm run seed -- --adopt <exchangeId> --tracker <trackerId> --tracking-number <trackingNumber> --execute
```

⭐ **The recovery half of `seed`, and it sends no transaction of any kind.** The window `seed` keeps
short is not zero: a run can die after the relay has landed, leaving an exchange live on chain with
no local record and no authorisations — holding the buyer's money with nothing standing guard, and
invisible to the watchdog, which sweeps records. `--adopt` reads that exchange back from the
protocol, signs the two authorisations against it and writes the record, so the watchdog can see an
exchange it previously could not. It never creates an offer, never commits and never escrows
anything; `--execute` still gates the signing and the write.

The tracker and tracking number are **required**, exactly as when seeding, and they are the operator
supplying them from memory rather than the script reading them back: the tracker id is the only
handle the watchdog has for resolving delivery evidence, and nothing on chain knows it.

It refuses, before signing anything, an exchange that does not exist on this configuration, one
**committed by a different buyer** (ids are global and dense, so a mistyped one lands on a
stranger's live exchange, where our authorisations would revert and the record would claim it is
guarded), one that has not been redeemed, and one that is already finalised. It also refuses one
that already has held authorisations, or a record naming a **different** tracker, naming which of the
two it found — adopting rewrites the record rather than merging into it, so the dispute, escalation
and finalisation fields reset and the tracker becomes the one on the command line. Those fields come
back on the watchdog's next sweep, because the protocol is asked for them; **the tracker does not**,
nothing on chain knows it, and the record is its only copy — which is what that refusal is really
protecting. **`--force` overrides it**, and is the flag to reach for when what is already there is
known to be lost or wrong. A record that exists and cannot be parsed refuses the same way, and names
the file to go and read.

⭐ **One state is not an overwrite, and is not refused: a record with an empty authorisation list, no
instruments held, and the same tracker.** That is exactly what a `seed` run that died between writing
the record and signing leaves behind — the record is written first so that failure is visible rather
than invisible — and finishing it is what `--adopt` is for. So the recovery command `seed` prints is
one `--adopt` accepts, and it carries `--force` itself in the case that needs it: a run that failed
*between* the two signatures leaves one instrument on disk, which is a real overwrite.

A tracker already held by another unfinalised exchange is a **warning** here rather than a refusal,
unlike on the seed path: adopting escrows nothing, and the usual cause is a second exchange for one
parcel that now needs guarding. While both are open the duplicate-purchase lookup can find either,
and nothing here disambiguates them for you.

⚠️ **No command undoes an escrow.** The only script that finalises an exchange is `confirm`, and it
finalises by *paying the seller* — so it belongs to the exchange whose parcel actually arrived, and
to that one only. Getting the buyer's money back on the other runs through a **dispute**: the
watchdog raises one on that exchange's behalf as its window nears expiry, and nothing in this
repository resolves a dispute, so it ends with the seller agreeing a split or the dispute resolver
deciding. Which exchange takes which route is a decision, not a command. Leaving both alone is not
the neutral option — a lapsed window pays the seller, and here that is twice for one parcel.

⚠️ **`confirm --execute` pays the seller.** It completes the exchange, the escrow is released
immediately, and it cannot be reversed. It is the buyer's decision and nothing else's: no tracking
event may reach it, because tracking proves arrival and not condition. It refuses on an exchange that
does not exist, is already finalised, has not been redeemed, or is disputed — completing a disputed
exchange reverts, and that is the ordinary case where the watchdog raised a dispute and the parcel
then turned up.

`npm run provision` and `npm run register` keep the opposite default deliberately: they do the work,
and offer `--dry-run` for a report. An allowance can be re-granted and a tracker can be
re-registered, so neither needs the stronger guard.

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
| `META_TX_RELAYER_API_ID_EXCHANGE_TOKEN` | no | Not used by either design — see below. Leave it empty |

An id is looked up as `apiIds[contract][method]`, the method defaulting to `executeMetaTransaction`,
so an id registered for one contract is not an id for another. The purchase is signed against the
protocol, which is why the protocol id is the one that must be present.

### The approval, and why there is no second api id

The buyer needs the protocol to be able to take the money, and the obvious design is to relay that
authorisation too, so the buyer never needs gas for anything. **That design is available on this
chain.** It is not the one this build uses — see the end of this section — but the reason is a
deliberate choice, not a limitation.

⚠️ **Do not reason about it from `executeMetaTransaction` on the token.** That was the older pattern:
an ERC-20 carrying its own native meta-transaction entrypoint, which is what the Polygon child tokens
implement. USDC on Base and Base Sepolia does **not** work that way and there is no credential that
makes it. Reading the absence of that method as "the approval cannot be relayed" is wrong, and was
believed here for a while.

⭐ **The mechanism is ERC-3009.** The buyer signs a `ReceiveWithAuthorization` payload for the
exchange token, and that authorisation travels **inside the purchase meta-transaction sent to the
protocol** — `relayMetaTransaction` routes to
`executeMetaTransactionWithTokenTransferAuthorization` when `transferAuthorizations` is non-empty.
There is no separate relay aimed at the token, which is why one api id, for the protocol, is all the
relayer needs.

Boson moved to this design across all three layers:

| Layer | Change |
|---|---|
| Protocol contracts | [bosonprotocol/boson-protocol-contracts#1123](https://github.com/bosonprotocol/boson-protocol-contracts/pull/1123) |
| Core SDK | [bosonprotocol/core-components#1028](https://github.com/bosonprotocol/core-components/pull/1028) |
| Meta-tx gateway | [bosonprotocol/meta-tx-gateway#66](https://github.com/bosonprotocol/meta-tx-gateway/pull/66) |

Read live on `testing-84532-0`, 27 August 2026:

| Checked | Result |
|---|---|
| Diamond routes `executeMetaTransaction(address,string,bytes,uint256,bytes)` | facet `0xe22Eaede9c1769671F76BA1c7717746388321D6F` |
| Diamond routes `executeMetaTransactionWithTokenTransferAuthorization(…)` | same facet — **the ERC-3009 entrypoint is live** |
| `0x036cbd53842c5426634e7929541ec2318f3dcf7e` — Circle's USDC, what `.env` names | **ERC-3009 present** (`authorizationState`, `DOMAIN_SEPARATOR`, `version` `"2"`), EIP-2612 `nonces` present |
| `0x8A04d904055528a69f3E4594DDA308A31aeb8457` — "USDC Testnet", shipped as USDC in the configuration | a plain ERC-20 behind a proxy: no ERC-3009, no `permit`, no `nonces` |

The pinned `core-sdk@1.48.1-alpha.2` already carries the signing helpers —
`signReceiveWithErc3009Authorization` and, for tokens that need them,
`signReceiveWithErc2612Permit`, `signReceiveWithPermit2` and a DAI-permit variant. Each returns a
`TransferAuthorization` tagged with its strategy, handed to `relayMetaTransaction` as
`transferAuthorizations`.

⚠️ **`/ready` proves registration, not capability.** It answers whether an api id is registered
against a contract. `0x8A04d9…` reports ready and implements none of the three authorisation
standards, so a `ready` response is not evidence that a path works.

### What this build does instead

**The buyer grants a plain allowance once, as provisioning** — `npm run provision`, an ordinary
transaction from the buyer's own wallet, exactly as that wallet is funded once. Everything afterwards
is relayed: the purchase, the dispute, the escalation.

That is one direct transaction in the lifetime of an account, against a pre-provisioned wallet, and
it is already done. **ERC-3009 is how that last transaction would be removed** if the buyer is ever
expected to arrive with no gas at all — a real scenario for a product whose whole premise is a
stranger with a wallet, and the reason this is written down rather than left as a footnote.

⚠️ **The allowance is granted to the balance, not to infinity.** An unlimited approval turns a
single bad signature into a drained wallet, and re-running the provisioning script re-grants it.

`META_TX_RELAYER_API_ID_EXCHANGE_TOKEN` therefore stays empty — not because the token cannot be
relayed to, but because nothing in either design relays a separate transaction to it.


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

⭐ **Never read state back directly after a relayed transaction — use `waitForState`.** The
relayer's `wait()` resolves as soon as the transaction is mined, but the RPC endpoint the protocol
ships is a **pool** of nodes, and they do not all have that block at the same instant. A read taken
immediately afterwards can be answered by a node one block behind and report, quite truthfully, that
nothing happened. It reads exactly like a failed transaction and is not one — this was first hit
creating the seller account, which succeeded while the script that created it concluded it had
failed. There is nothing to subscribe to, so `waitForState` polls the read until it answers.

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
