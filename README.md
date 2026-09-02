

# Held

### *Buy from a stranger. Keep your money until it's sorted.*

Consumer protection that doesn't need a platform.

---

## 1. Context

Held is a buyer-side app for peer-to-peer marketplace purchases, built on
[Boson Protocol](https://bosonprotocol.io) and deployed on Base.

It is being built for the **EasyA hackathon at the UK Parliament on Friday 4 September 2026**.

---

## 2. The problem

### The everyday version

You find something on a peer-to-peer marketplace listing. It's exactly what you want. But the seller
is 200 miles away, so you can't collect in person, and you have no reason to trust them.

Your options today:

- **Send the money and hope.** If they vanish, it's gone.
- **Walk away.** Which is what most people do.

That is a real market failing to clear because two strangers can't trust each other over £200.

### When it does go wrong

Recourse at this value is effectively unavailable:

| Route | Why it fails at £200 |
| --- | --- |
| Small claims court | Costs money, takes months. Economically irrational at this value. |
| Chargeback | Doesn't exist outside card rails. Bank transfer is final. |
| Platform arbitration | Decided in secret, no published reasoning, no appeal — and the platform has a commercial incentive to retain the seller. |
| Police / Action Fraud | Volume vastly exceeds capacity for low-value cases. |

**The practical answer for most people is: you eat it.**

This is an access-to-justice gap: the cost of obtaining justice exceeds the value of the dispute, so
the dispute goes unresolved. The same gap that ombudsman schemes, alternative dispute resolution and
the small claims track exist to close at higher values.

**Held does not replace courts. It serves the cases courts were never going to reach.**

---

## 3. The product

### One sentence

> **Buy from a stranger online, and your money doesn't leave until the parcel actually arrives. If it
> doesn't, you get it back. And if it arrives broken, something reads the evidence and helps you
> settle, in the open.**

### What it is

1. **Escrow without a platform** — your money is committed but not sent, held by a smart contract
   neither party controls
2. **Delivery evidence as the trigger** — real courier tracking releases the money or triggers a
   refund, with no human in the loop
3. **An AI that does everything except decide** — it mediates when the parcel arrives but something's
   wrong, and prepares the case when a human is genuinely needed

### What it is not

- ❌ **Not a marketplace.** No discovery, search or matching. You bring your own listing.
- ❌ **Not a payments product.** The money movement is the least interesting part.
- ❌ **Not an AI judge.** See §5.
- ❌ **Not for agents doing the buying.** The buyer is a human. Agent-initiated purchase drags in
  mandate, allowance and spending-constraint questions this product deliberately does not answer.
- ❌ **Not a finished product.** It is a proposition with a working prototype, and it says so.

### 3a. The flow — and why the watchdog is mandatory

Commit and redeem are collapsed into a single atomic action, using the atomic create-commit-redeem
path (BPIP-13).

This matters because the protocol's native two-step flow does not mean what a buyer would assume:

| Protocol action | What it actually does |
| --- | --- |
| **Commit** | Buyer's funds are escrowed; buyer receives a tradeable rNFT |
| **Redeem** | ⚠️ **Not "it arrived."** The buyer exercises the right to receive the item — the rNFT is burned, the seller is triggered to fulfil, and the dispute period opens. |
| **Complete** | Buyer confirms they received it and are satisfied → seller paid immediately |
| **Dispute period expires** | ⚠️ **Inaction is treated as success. The seller is paid in full.** |

Collapsing commit and redeem means the buyer never encounters the concepts of voucher, rNFT or
redemption at all. They reserve an item, the seller is told to ship, the clock starts. One action, no
vocabulary.

*Out of scope by design:* the rNFT is tradeable between commit and redeem, so a committed position
could be sold on. The atomic flow forecloses that, deliberately.

#### The consequence: inaction favours the seller, so the system must act for the buyer

Read the table again — **if the parcel never arrives and the buyer does nothing, the buyer pays in
full.** The same is true one level down: if a dispute is raised and the resolution period lapses with
no action, the seller is paid.

Most consumer protection fails in exactly this way. People miss deadlines.

**So the oracle adapter is not only a settlement trigger — it is a watchdog.** It monitors tracking
and, if the parcel has not been delivered as the window approaches expiry, it raises the dispute on
the buyer's behalf before the door closes.

> **You don't have to watch it. If it doesn't turn up, we raise it for you.**

---

## 4. The escalation ladder

This is the spine of the product. Each rung is cheaper than the one below it, and most cases never
descend.

| # | Rung | Who acts | Cost |
| --- | --- | --- | --- |
| **1** | **It arrives. Nothing happens.** Tracking confirms delivery; the buyer confirms, or the window simply passes. Seller paid. | Nobody | Zero |
| **2** | **It doesn't arrive — and the system notices.** The watchdog sees non-delivery and raises the dispute before the window closes. The tracking evidence is unambiguous, so the seller agrees immediately. Full refund. | Software acts; seller accepts | Near-zero |
| **3** | **It arrives, but something's wrong.** Contested, and tracking can't settle it. The AI mediator reads the evidence and proposes a split both sides would rationally accept. They agree. Settled on-chain. | AI proposes, humans accept | Near-zero |
| **4** | **They can't agree.** The AI assembles the complete case file; a human dispute resolver makes the call. Reasoning published. Appeal exists. | AI prepares, human decides | Real, but rare |

> ⚠️ **Rung 2 is not an automatic refund**, and it is important not to describe it as one. The
> protocol has no path where non-delivery refunds a passive buyer — inaction pays the seller. Rung 2
> is the watchdog raising a dispute for you, on evidence so clear the seller has no rational reason
> to contest it.

**Expensive human judgment is reserved for the cases that actually need it.**

The ladder is proportionate — the response scales with the difficulty of the case. It is honest: this
does not automate justice, it automates everything around it. And at the rung where most volume sits,
it ends in agreement rather than a verdict.

---

## 5. The AI's role, precisely bounded

> **The AI does everything except decide.**

At rung 3 it compresses the work to zero — the parties agree and nobody escalates. At rung 4 it
compresses the human's job to the single irreducible act: deciding.

The Financial Ombudsman Service has **case handlers** who gather evidence and assemble the file, and
**ombudsmen** who decide. Held automates the case handler, not the ombudsman.

### The bounded action space

The protocol's mutual resolution is a **split of the escrowed pot**. So:

> **The AI cannot invent a remedy. It proposes a percentage.**

- Action space: **one number, 0–100%**
- Over a pot **both parties already agreed to lock**
- With remedies **agreed up front**
- Which **either party is free to decline**

This is a property of the architecture, not of a prompt: the model-driven components have no
chain-calling tools at all, and no code path lets an AI-proposed split settle without explicit human
acceptance.

### The two behaviours

Both sit on one shared evidence-assembly component.

**Rung 3 — Mediator**

- Reads tracking history, photos, the message thread, the original offer terms
- Identifies what's missing and requests it
- Proposes a split, **with its reasoning shown**
- Either party may accept or decline. Acceptance settles on-chain.

**Rung 4 — Clerk**

- Assembles the complete case file: evidence, timeline, both parties' positions, what was requested
  and what was provided, what remains contested
- Chases missing evidence from both sides *(production: email/messaging; not built in the prototype)*
- Hands a finished file to a human decider
- **Does not recommend an outcome**

---

## 6. Architecture

| Layer | Choice |
| --- | --- |
| Escrow and dispute resolution | Boson Protocol E-commerce Module, via `@bosonprotocol/core-sdk` |
| Chain | Base (Base Sepolia for testnet) |
| Exchange token | ERC-20 (USDC). Native currency is unusable — a meta-transaction cannot forward `msg.value`. |
| Buyer transactions | Signatures relayed as meta-transactions; the buyer holds no native currency |
| Delivery oracle | Ship24, webhook push per registered tracker |

**The aggregator is a trust hop, and the system says so.** Tracking evidence is Ship24's read of the
carrier, not an attestation signed by the carrier. **Tracking proves arrival, not condition** — which
is exactly why the AI half exists.

Repository layout:

- `src/` — runtime code. `src/receiver.mjs` is the one process exposed to the internet and stays
  dependency-free.
- `scripts/` — provisioning and capture, run by hand. Never a runtime path.
- `test/` — `node --test`, no framework
- `fixtures/` — captured tracking data, scrubbed of personal location data at capture time
- `docs/specs/` — what the system is and how it behaves
- `docs/plans/` — how a piece of it gets built

Longer form: [`docs/chain.md`](docs/chain.md), [`docs/receiver.md`](docs/receiver.md),
[`docs/specs/offer-model.md`](docs/specs/offer-model.md).

---

## 7. Scope

**Buyer view only.** The seller side is scripted for the demo, and that is stated plainly rather than
hidden.

Deliberately not built: seller onboarding, discovery or matching, wallet onboarding, multi-chain
support, agent-initiated purchase.

---

## 8. Running it

Requires Node (see `.nvmrc`).

```bash
npm install
cp .env.example .env     # fill in; .env is gitignored and holds every secret
npm run chain-check      # verifies the chain path end to end, read-only, needs no key
npm run provision        # idempotent; sets up the accounts chain-check looks for
npm test
```

`npm run seed` and `npm run confirm` plan and stop by default — neither signs nor submits anything
without an explicit `-- --execute`.

The webhook receiver is containerised (`Dockerfile`) and deploys to Fly (`fly.toml`). It requires a
public HTTPS origin, since Ship24 pushes events to it, and it refuses to start without a tracker
allowlist.

**No secrets in any commit.** API keys, wallet mnemonics, private keys and provider credentials live
in `.env` only. On-chain addresses and public tracking numbers are fine.

---

## 9. The buyer's view

The one screen a buyer looks at. It is a **view over the stores**: it computes nothing about an
exchange that the rest of the system does not already know, it simulates nothing, and it holds no
state of its own. If the screen says a dispute was raised, a record on disk already says so.

Full behaviour — every screen state, the vocabulary rule, the failure table — is specified in
[`docs/specs/buyer-view.md`](docs/specs/buyer-view.md). This section covers only how to run it.

### Running it

```bash
npm run buyer
```

Serves on `http://127.0.0.1:3100` by default. The page itself reads two query parameters from the
URL:

- `?purchase=<exchangeId>` — show one purchase. Omitted, the page shows the list of every purchase
  the view can render.
- `?photo=<photoId>` — which photograph the "add evidence" action attaches, once a dispute is open
  and evidence has been requested. Absent, that action is simply not drawn — the view never guesses
  which photograph to send on the buyer's behalf.

Environment variables, read once at startup:

| Variable | Default | Notes |
|---|---|---|
| `BUYER_UI_PORT` | `3100` | Deliberately not `PORT` — the receiver owns that name |
| `EXCHANGES_DIR` | `state/exchanges` | Shared with the watchdog and the scripts |
| `EVENTS_DIR` | `fixtures/events` | Shared with the receiver |
| `BUYER_UI_ALLOW_CONFIRM` | `false` | See below |

⚠️ **It binds to `127.0.0.1` only, and refuses to start bound to anything else — it is never
deployed.** Unlike the receiver, this process holds chain credentials: a signer, a relayer
credential. Loopback-only is what makes holding them here acceptable, and that ordering is
load-bearing — if this process ever needed to answer a socket other than loopback, that would be a
different design, not a configuration change.

### `BUYER_UI_ALLOW_CONFIRM`

Completing an exchange pays the seller immediately, cannot be undone, and forfeits the ability to
dispute that exchange — so the completing action refuses unless `BUYER_UI_ALLOW_CONFIRM=true`.

This is an **operator guard, never a buyer-facing one**. It has no expression on screen — no
confirmation dialogue, no second tap, no warning about irreversibility — because completing is an
ordinary, optional convenience and the interface presents it as one (see below).

A server started with `BUYER_UI_ALLOW_CONFIRM=true` connects to the chain **at startup**, before it
serves a single request, and refuses to start at all if that connection fails. An unarmed server
never connects to the chain — every read the buyer's screen polls is answered from the stores
alone. Connecting eagerly rather than lazily moves a misconfigured chain's failure to a startup
error an operator can see, rather than to the first press of the button.

### Completing is optional. Disputing is not.

If nobody presses "It arrived, all good", the dispute period elapses on its own and the seller is
paid anyway — completing only makes that happen sooner. The screen states the date the seller is
paid regardless, above both buttons.

Raising a dispute carries no such backstop once a parcel shows as delivered: the watchdog stands
down on a delivered parcel, because tracking proves arrival, not condition. **Nothing raises a
dispute on behalf of a buyer whose parcel arrived broken.** If they do not press "Something's wrong"
before the period elapses, the seller is paid and it is final.

### The listing requirement

The exchange record itself holds no item title, price or image — it is protocol state, and giving
it display copy would create a second price that could disagree with the one that actually moves.
The view instead reads a `listing` block from `fixtures/case/<exchangeId>.json`:

```json
{
  "exchangeId": "239",
  "listing": { "title": "…", "body": "…", "priceText": "200" }
}
```

`photos` and `messages` in the same file are present only once a dispute case exists; a purchase
with no case at all still needs the `listing` block on its own. **A purchase whose exchange id has
no such file is omitted from the list, and logged loudly** — never rendered half-drawn with a blank
title and no price.

### `npm run replay`

```bash
npm run replay -- <trackerId> --from fixtures/events --into state/demo-events --every 3
```

A parcel moves on its own schedule — a real delivery takes days from dispatch to arrival, which
makes the view hard to watch end to end. `replay` reads a previously captured snapshot's event list
from `--from` and writes those events one at a time into the store at `--into`, through the same
`ingest()` call the webhook receiver makes on a real push, pausing `--every` seconds between them.
Point `EVENTS_DIR` at the same `--into` directory to watch the replay through the running view.

It never fabricates an event and never writes a derived state directly — everything it writes came
out of a real capture, and deriving state from the event list stays the store's job. `--from` and
`--into` must be different directories: replay never writes into its own source.

---

## 10. AI models used

**In the product — one model, reached from one file.** Mediation is the only path that calls a
model. It uses **Claude Opus 5** (`claude-opus-5`) through the official `@anthropic-ai/sdk`, and
`src/model.mjs` is the only module in this repository that talks to a model provider.

The case file is not a second such path. `src/clerk.mjs` has no imports at all and calls nothing: it
assembles the file deterministically from the evidence bundle and the case record, and records which
model *mediated* rather than consulting one itself.

| | |
|---|---|
| Model | `claude-opus-5`, overridable with `MEDIATOR_MODEL` |
| SDK | `@anthropic-ai/sdk`, pinned to an exact version |
| Output | structured output via `output_config.format` against a JSON schema |
| Thinking | `thinking: { type: "adaptive" }` |
| Tools | **none — there is no `tools` field in the request** |

The absent `tools` field is the point rather than an oversight. No model-driven component here holds
a tool that can move funds, and that is a property of the code — one file, one request shape, in
which adding such a tool would be a visible change — rather than an instruction in a prompt. The
model's entire action space is one number between 0 and 100; `src/proposal.mjs` checks it, and
checks that every finding cites evidence that was actually in front of the model, before either can
reach the protocol. Nothing settles without an explicit human acceptance, and either party may
decline.

Which model produced a proposal is recorded on the case record and stated in the case file, taken
from what the API reports it served rather than from what the request asked for.

Every call is recorded against the hash of the evidence that produced it, and a matching hash serves
the recording instead of calling the API. The test suite runs entirely on recordings and needs no
API key. A replayed proposal is a recording of a real run and is labelled as one wherever it is
shown.

**In development.** The code, tests and documentation in this repository were written with Claude
Code, using Claude Opus 5. Commits carry a `Co-Authored-By: Claude Opus 5` trailer where that
applies.

---

## 11. Licence

Apache License 2.0 — full text in [`LICENSE`](./LICENSE). Copyright 2026 LX Foundry.

This is the same licence the Boson Protocol SDKs are published under, so the dependency tree sits
under one permissive licence with no compatibility question. Apache-2.0 also grants an express
patent licence alongside the copyright one, which matters more here than it would for a plain
library: the escalation ladder and the watchdog are mechanisms, not just code.
