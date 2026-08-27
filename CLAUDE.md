# CLAUDE.md — held

**Held — buy from a stranger. Keep your money until it's sorted.** A buyer-side app for
peer-to-peer marketplace purchases. The buyer's money is escrowed by Boson Protocol rather than sent
to the seller; real courier tracking releases it or triggers a refund; and when the parcel arrives
but something is wrong, an AI reads the evidence and proposes a settlement both sides can accept.

**The AI does everything except decide.**

## Architecture (implementation-relevant facts)

- **Chain: Base.** Boson Protocol's E-commerce Module. Boson is also deployed on Ethereum, Polygon,
  Arbitrum and Optimism — moving between those five is cheap; anything outside that set is not
  reachable, so no design may assume a non-Boson chain.

- **The flow is atomic commit + redeem** (BPIP-13 provides atomic create-commit-redeem). We collapse
  them into a single buyer action: the buyer reserves an item, the seller is told to ship, the clock
  starts. **The buyer never encounters the words voucher, rNFT, redeem, commit or exchange** — not in
  the UI, not in copy, not in an error message.

- **`redeem` does not mean "it arrived".** It is the buyer exercising the right to receive the item:
  the rNFT is burned, the seller is triggered to fulfil, and the **dispute period opens**. Anything
  written on the assumption that redeem is a delivery confirmation is wrong.

- ⭐ **Inaction pays the seller. This is the fact everything else follows from.**

  | Protocol event | What actually happens |
  |---|---|
  | Commit | Funds escrowed; buyer receives a tradeable rNFT |
  | Redeem | Seller triggered to fulfil; dispute period opens |
  | Complete | Buyer confirms satisfaction → seller paid immediately |
  | **Dispute period expires with no action** | ⚠️ **Seller is paid in full** |
  | **Dispute raised, resolution period lapses** | ⚠️ **Seller is paid** |

  There is **no path in which non-delivery refunds a passive buyer**. A buyer who receives nothing
  and does nothing pays in full.

- **Therefore the watchdog is mandatory, not a feature.** The oracle adapter is not only a settlement
  trigger. It monitors tracking and, if the parcel has not been delivered as the window approaches
  expiry, **raises the dispute on the buyer's behalf before the door closes** — and does the same as
  a resolution period nears expiry. Without it, the product does not protect anyone.

- ⚠️ **Never describe the non-delivery path as an automatic refund**, in code comments, docs, copy or
  commit messages. It is *the watchdog raising a dispute on evidence so clear the seller has no
  rational reason to contest it.* That is what the protocol actually does.

- **Delivery oracle: Ship24**, an aggregator, chosen because Royal Mail's and InPost's own tracking
  APIs are not self-service and cannot be provisioned in this timeline.
  - Auth `Authorization: Bearer apik_…`. **The production endpoint is `/trackers`.** Webhooks are
    push, not poll. Node.js SDK. Ship24's **Tracking API** product; its free tier carries both the
    API and webhooks, 10 shipments/month plus a 100-shipment first-month bonus, counted per
    **tracker** rather than per call.
  - ⚠️ **Ship24 has two independent subscriptions and they gate different endpoints.** *per-shipment*
    unlocks `/trackers` — create tracker, receive webhooks, fetch results. *per-call* unlocks
    `/tracking/search`. Holding one and calling the other returns `HTTP 422 no_active_subscription`,
    which is a plan-scope error and not an authentication failure — the key is fine.
  - ⚠️ **`/tracking/search` is a one-off query and subscribes to nothing.** Webhook updates are
    delivered per tracker, so every parcel must be registered through `/trackers` before any event is
    pushed. Registering a parcel late loses no history — carrier event lists are cumulative and the
    first fetch returns everything to date.
  - **Courier codes are verified against `GET /couriers`, never assumed.** Royal Mail is `gb-post`
    (`isPost: true`, no required fields); InPost UK is **`inpost-uk`**, not `inpost`. Carrier
    availability varies by plan — some carriers are paid-only — so check a new code against
    `/couriers` before writing a mapping that depends on it.
  - **Registering a tracker is provisioning, not runtime.** It belongs in a script, never in the
    adapter — the oracle adapter only ever receives.
  - ⚠️ **Royal Mail requires courier code `gb-post`.** Royal Mail tracking numbers are not
    self-identifying and a lookup without the code returns nothing.
  - ⚠️ **Standard 1st/2nd class produces no tracking events at all.** Only Tracked 24/48 and Special
    Delivery generate the event stream this system runs on.
  - The adapter is written **carrier-agnostic** — Ship24 covers ~1,200 carriers and the mapping
    layer should not hard-code Royal Mail beyond the courier code.

- **The aggregator is a trust hop, and the system says so.** Evidence is Ship24's *read* of the
  carrier, not an attestation signed by the carrier. Do not describe tracking data as carrier-signed
  or as proof of anything but arrival. **Tracking proves arrival, not condition** — which is exactly
  why the AI half exists.

- **Tracking state → protocol action.** Freeze this mapping before writing the adapter:

  | Tracking state | Action |
  |---|---|
  | Delivered | Allow the buyer to confirm; otherwise let the window run to completion |
  | In transit, window healthy | No-op |
  | **Not delivered, window nearing expiry** | ⭐ **Watchdog: raise dispute on the buyer's behalf** |
  | Delivered but disputed | Hand evidence to the mediator |
  | **Dispute open, resolution period nearing expiry** | ⭐ **Watchdog again** — lapsing here also pays the seller |

  The two watchdog rows are the ones that keep the buyer whole. Everything else is bookkeeping.

- **The escalation ladder** — each rung cheaper than the one below, most cases never descend:
  1. It arrives, nothing happens; seller paid. Nobody acts.
  2. It doesn't arrive; the watchdog raises the dispute and the tracking evidence is unambiguous, so
     the seller accepts. Full refund.
  3. It arrives but something's wrong; the AI mediator proposes a split both sides accept. Settled
     on-chain.
  4. They can't agree; the AI assembles the case file and a human dispute resolver decides.

- **The AI's action space is one number, 0–100%.** Boson's mutual resolution is a split of the
  escrowed pot, so the AI cannot invent a remedy — it proposes a percentage, over a pot both parties
  already agreed to lock, with remedies agreed up front, which either party is free to decline.
  **Nothing in this system may give the AI a wider action space than that**, and no code path may
  let an AI-proposed split settle without an explicit human acceptance.

- **Mediator and clerk are two thin behaviours on one shared component — build it once.** Both need
  *read the evidence, work out what's missing, go and get it*. That shared evidence-assembly
  component is the highest-value thing in the codebase.
  - **Mediator** (rung 3): reads tracking history, photos, the message thread and the original offer
    terms; identifies and requests what's missing; proposes a split **with its reasoning shown**;
    either party may accept or decline; acceptance settles on-chain.
  - **Clerk** (rung 4): assembles the complete case file — evidence, timeline, both positions, what
    was requested and provided, what remains contested — and hands it to a human decider.
    ⚠️ **The clerk does not recommend an outcome.** No code path may leak a proposed split into the
    case file.

## Scope

**Buyer view only.** The seller side is scripted for the demo, and that is stated plainly rather
than hidden.

**Do not build**, in any form:

- Seller onboarding wizard, or any seller-side flow
- Discovery, search or matching — you bring your own listing; this is not a marketplace
- Wallet onboarding — accounts are pre-provisioned
- Multi-chain support — one chain
- Agent-initiated purchase — **the buyer is a human**; agent buying drags in mandate, allowance and
  spending-constraint questions this product deliberately does not answer
- Anything in the high-value module: fractionalisation, RWAs, luxury

Front-end scope is the single largest risk to this project. The product is a **proposition with a
working prototype**, and it says so.

## Layout

Five components are genuinely new work; everything else is reuse:

| # | Component | Notes |
|---|---|---|
| 1 | **Oracle adapter + watchdog** | Ship24 webhook receiver mapping tracking events to protocol state transitions, plus the deadline watchdog. Not optional. **The receiver exists** (`src/receiver.mjs`, [`docs/receiver.md`](./docs/receiver.md)); the mapping to protocol actions and the watchdog do not yet |
| 2 | **Evidence assembly** | ⭐ The shared core. Reads tracking, photos, messages and offer terms; determines what's missing; requests it |
| 3 | **Mediator behaviour** | Thin layer on (2): propose a percentage split with visible reasoning |
| 4 | **Clerk behaviour** | Thin layer on (2): render the case file |
| 5 | **Buyer UI** | Thin but genuinely polished. The only visible surface |

Directory names for the components not yet written are settled when the build plan lands. What
exists is fixed:

- `src/` — runtime code. Zero dependencies so far, and the receiver stays that way
- `scripts/` — provisioning and capture, run by hand. Never a runtime path
- `test/` — `node --test`, no framework
- `fixtures/` — captured tracking data, scrubbed at capture time and committed
- `docs/specs/` — what the system is and how it behaves
- `docs/plans/` — how a piece of it gets built

## Toolchain

**Boson Core SDK, called directly.** Every chain interaction — seller account creation, offer
signing, the atomic create-commit-redeem meta-transaction, raising a dispute, mutual resolution —
goes through `@bosonprotocol/core-sdk` and its relayer. The offer flow is specified in
[`docs/specs/offer-model.md`](./docs/specs/offer-model.md).

⚠️ **No MCP tool surface for chain access, and that is deliberate.** MCP exists to give an *agent* a
set of tools. Nothing here is an agent that needs to touch the chain: the buyer interface is a view,
the seller side is scripted, and the oracle adapter and watchdog are a service driven by webhooks and
a clock.

⭐ The two components that *are* model-driven — the mediator and the clerk — **must not have
chain-calling tools at all.** That is what makes the bounded action space above a property of the
architecture rather than of a prompt. **No AI component may be given a tool that can move funds**,
and no MCP server may be introduced to give one.

**Rebuild nothing** — this repo is add-ons only: agents, apps, and new contracts only if something is
genuinely required at chain level.

`.mcp.json` is **not written yet and is not needed to build**. If one is ever added it is for local
development tooling only (e.g. querying the subgraph while debugging), never for a runtime code path,
and it lives at this repository root because `.mcp.json` is read from the project root only.

## Rules

1. **Self-contained repo.** All code, comments, commit messages and docs must make sense with only
   this repository checked out. Never reference files, paths or documents outside it.
2. **No secrets, ever, in any commit**: Ship24 API keys, wallet mnemonics, private keys, LLM provider
   keys and email credentials live in `.env` (gitignored); commit `.env.example` with empty values.
   On-chain addresses and public tracking numbers are fine.
3. **Commit messages are neutral, technical and present tense** — "map Ship24 delivery events to
   protocol state transitions", "raise dispute before window expiry". Never framed around an
   audience, an event or a pitch.
4. **Testnet first.** No Base mainnet transaction from code that hasn't passed the testnet circuit.
   Mainnet config changes get their own commit.
5. **No protocol vocabulary in anything the buyer sees.** Never "voucher", "rNFT", "redeem",
   "commit" or "exchange" in a user-visible string, including error messages and email copy.
6. **Never say "Facebook app"** or name a specific marketplace brand. Say *peer-to-peer marketplace
   listings*.
7. Public-facing docs (README, API reference) describe **what the system does** — never event,
   campaign or competition tactics.
8. ⚠️ **Scrub tracking fixtures before committing them.** Captured courier events carry personal
   location data. This repository is publishable at any moment, so redact **at capture time** — not
   in a later audit, because a fixture is public from the moment the repo is, and nobody re-reads a
   committed JSON file. Tracking numbers themselves are fine; the places attached to them are not.

   ⚠️ **A field-name scrub is not enough.** `recipient.address` and `recipient.postCode` are the
   obvious fields, but postcodes also arrive **inside free-text event strings** — a real observed
   event reads `"location": "<Town> Post Office [AB12 3CD]"` while `recipient.postCode` is `null`.
   Scrub by **pattern as well as by field**: run a UK postcode regex over the whole serialised
   payload, not over a list of keys you expect to be sensitive.
