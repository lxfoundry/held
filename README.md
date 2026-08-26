# Held
### *Buy from a stranger. Keep your money until it's sorted.*

## 1. Context

TBD

---

## 2. The problem

### The everyday version

You find something on Facebook Marketplace, Gumtree, Vinted. It's exactly what you want. But the seller is 200 miles away, so you can't collect in person, and you have no reason to trust them.

Your options today:

- **Send the money and hope.** If they vanish, it's gone.
- **Walk away.** Which is what most people do.

That is a real market failing to clear because two strangers can't trust each other over £200.

### The version that lands with policymakers

If it *does* go wrong, recourse is effectively unavailable:

| Route | Why it fails at £200 |
|---|---|
| Small claims court | Costs money, takes months. Economically irrational at this value. |
| Chargeback | Doesn't exist outside card rails. Bank transfer is final. |
| Platform arbitration | Decided in secret, no published reasoning, no appeal — and the platform has a commercial incentive to retain the seller. |
| Police / Action Fraud | Volume vastly exceeds capacity for low-value cases. |

**The practical answer for most people is: you eat it.**

This is an **access-to-justice gap**. The cost of obtaining justice exceeds the value of the dispute, so the dispute goes unresolved. Policymakers already have furniture for this idea — ombudsman schemes, alternative dispute resolution, the small claims track.

**We are not replacing courts. We are serving the cases courts were never going to reach.**

---

## 3. The product

### One sentence

> **Buy from a stranger online, and your money doesn't leave until the parcel actually arrives. If it doesn't, you get it back — automatically. And if it arrives broken, something reads the evidence and helps you settle, in the open.**

### What it actually is

A buyer-side app for peer-to-peer marketplace purchases that gives you:

1. **Escrow without a platform** — your money is committed but not sent, held by a smart contract neither party controls
2. **Delivery evidence as the trigger** — real courier tracking releases the money or refunds it, with no human in the loop
3. **An AI that does everything except decide** — mediates when the parcel arrives but something's wrong, and prepares the case when a human is genuinely needed

### What it is *not*

- ❌ Not a marketplace. We don't do discovery, search or matching. You bring your own listing.
- ❌ Not a payments product. The money movement is the least interesting part.
- ❌ Not an AI judge. See §5.
- ❌ Not for agents doing the buying. **The buyer is a human.** Agent-initiated purchase drags in mandate, allowance and spending-constraint questions this product deliberately does not answer.
- ❌ Not a finished product. It is a **proposition with a working prototype** — and we say so.

### 3a. The simplified flow — and why the watchdog is mandatory

**We collapse commit and redeem into a single atomic action.** Protocol support exists: BPIP-13 provides atomic create-commit-redeem.

This matters because Boson's native two-step flow does not mean what a buyer would assume:

| Protocol action | What it actually does |
|---|---|
| **Commit** | Buyer's funds are escrowed; buyer receives a tradeable rNFT |
| **Redeem** | ⚠️ **Not "it arrived."** The buyer exercises the right to receive the item — the rNFT is burned, the **seller is triggered to fulfil**, and the **dispute period opens**. |
| **Complete** | Buyer confirms they received it and are satisfied → seller paid immediately |
| **Dispute period expires** | ⚠️ **Inaction is treated as success. The seller is paid in full.** |

Collapsing commit and redeem means **the buyer never encounters the concepts of voucher, rNFT or redemption at all.** They reserve an item; the seller is told to ship; the clock starts. One action, no vocabulary.

*Deliberately out of scope:* the rNFT is tradeable between commit and redeem, so a committed position can be sold on. Real capability, wrong story for this audience — the atomic flow forecloses it and that is fine.

#### ⭐ The consequence: inaction favours the seller, so the system must act for the buyer

This is not a detail. Read the table again — **if the parcel never arrives and the buyer does nothing, the buyer pays in full.** The same is true one level down: if a dispute is raised and the resolution period lapses with no action, the seller is paid.

Most consumer protection fails in exactly this way. People miss deadlines.

**So the oracle adapter is not only a settlement trigger — it is a watchdog.** It monitors tracking and, if the parcel has not been delivered as the window approaches expiry, **it raises the dispute on the buyer's behalf, before the door closes.**

> **You don't have to watch it. If it doesn't turn up, we raise it for you.**

That is a genuine product requirement, a genuine consumer-protection insight, and one of the strongest lines available for the room.

### Positioning

**Framing (DECIDED):** *Consumer protection that doesn't need a platform.*

Two secondary framings available for different perpectives, supported by the same artifact:

*Proportionate redress for low-value trade — the access-to-justice gap*

OR

*The trust layer for commerce between parties who have no relationship*

---

## 4. The escalation ladder

**This is the spine of the product.** Everything else is detail.

Each rung is cheaper than the one below it. Most cases never descend.

| # | Rung | Who acts | Cost |
|---|---|---|---|
| **1** | **It arrives. Nothing happens.** Tracking confirms delivery; the buyer confirms, or the window simply passes. Seller paid. | Nobody | Zero |
| **2** | **It doesn't arrive — and the system notices.** The watchdog sees non-delivery and raises the dispute before the window closes. The tracking evidence is unambiguous, so the seller agrees immediately. Full refund. | Software acts; seller accepts | Near-zero |
| **3** | **It arrives, but something's wrong.** Contested, and tracking can't settle it. AI mediator reads the evidence and proposes a split both sides would rationally accept. They agree. Settled on-chain. | AI proposes, humans accept | Near-zero |
| **4** | **They can't agree.** AI assembles the complete case file; a human dispute resolver makes the call. Reasoning published. Appeal exists. | AI prepares, human decides | Real, but rare |

> ⚠️ **Rung 2 is not a magic automatic refund**, and it is important not to describe it as one. Boson has no path where non-delivery refunds a passive buyer — inaction pays the seller. Rung 2 is *the watchdog raising a dispute for you, on evidence so clear the seller has no rational reason to contest it.* That is honest to the protocol, and a better story: the system is on your side while you are not looking.

**The line that does the work:**

> **Expensive human judgment is reserved for the cases that actually need it.**

### Why the ladder matters more than any single feature

- It is **proportionate** — the response scales with the difficulty of the case
- It is **honest** — we're not claiming to automate justice, we're claiming to automate everything around it
- It **ends in agreement, not a verdict**, at the rung where most volume sits
- It maps cleanly onto how UK redress already works, which makes it legible to the room

---

## 5. The AI's role, precisely bounded

### The principle

> **The AI does everything except decide.**

At rung 3 it compresses the work to zero — the parties agree and nobody escalates. At rung 4 it compresses the human's job to the single irreducible act: deciding.

### The analogy to use out loud

> The Financial Ombudsman Service has **case handlers** who gather evidence and assemble the file, and **ombudsmen** who decide.
>
> **We've automated the case handler, not the ombudsman.**

This is legible to every MP in the room, demonstrates literacy in how UK redress actually works, and pre-empts the AI objection before anyone raises it.

### The bounded action space — the strongest defensibility argument we have

Boson's mutual resolution is a **split of the escrowed pot**. So:

> **The AI cannot invent a remedy. It proposes a percentage.**

- Action space: **one number, 0–100%**
- Over a pot **both parties already agreed to lock**
- With remedies **agreed up front**
- Which **either party is free to decline**

If anyone in that room pushes on the AI, that is the sentence that ends the challenge. It is also simply true to the protocol.

### The two behaviours

Both sit on **one shared component**.

**Rung 3 — Mediator**
- Reads: tracking history, photos, the message thread, the original offer terms
- Identifies what's missing and requests it
- Proposes a split, **with its reasoning shown**
- Either party may accept or decline. Acceptance settles on-chain.

**Rung 4 — Clerk**
- Assembles the complete case file: evidence, timeline, both parties' positions, what was requested and what was provided, what remains contested
- Chases missing evidence from both sides *(production: email/messaging. Demo: described, not built)*
- Hands a finished file to a human decider
- **Does not recommend an outcome**

---


