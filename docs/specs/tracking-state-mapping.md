# Spec — tracking state → protocol action

How courier tracking events drive the exchange. **Frozen before the adapter is written**: everything
downstream is implemented against this table, so changing it invalidates work rather than extending
it.

Companion to [`offer-model.md`](./offer-model.md), which produces the `exchangeId` this operates on.

---

## 1. Two vocabularies, one direction

The adapter translates **carrier events** into **protocol actions**. It is the only component that
speaks both, and the translation runs one way: tracking never reads protocol state to decide what a
parcel did.

### Map on `statusMilestone`, not `statusCode`

The provider reports three levels of granularity. Use the coarsest.

| Field | Example | Use it? |
|---|---|---|
| `statusMilestone` | `in_transit` | ✅ **Yes.** A small, closed, carrier-independent set |
| `statusCategory` | `transit` | No — redundant with the milestone |
| `statusCode` | `transit_handover` | ❌ **No.** Fine-grained and carrier-specific |

The provider aggregates roughly 1,200 carriers. `statusCode` values vary between them, so a mapping
built on codes is a mapping that breaks the first time a parcel travels by a different carrier. The
milestone set is the provider's own normalisation and is the stable surface.

**The milestone set**, corroborated by the `statistics.timestamps` object the API returns alongside
every tracking result:

`pending` · `info_received` · `in_transit` · `out_for_delivery` · `failed_attempt` ·
`available_for_pickup` · `delivered` · `exception`

---

## 2. The mapping

The dispute period opens at purchase, not at delivery — see [`offer-model.md`](./offer-model.md) §2 —
so a single window covers shipping *and* inspection. "Window healthy" below means that window still
has more than the watchdog threshold remaining (§4).

| Tracking milestone | Window | Protocol action | Buyer-facing state |
|---|---|---|---|
| `pending`, `info_received` | healthy | **none** | on its way |
| `in_transit`, `out_for_delivery` | healthy | **none** | on its way |
| `failed_attempt`, `available_for_pickup` | healthy | **none** | needs you — the buyer must act with the carrier |
| `exception` | healthy | **none** — see §3 | we're looking into it |
| `delivered` | healthy | **none** — offer confirmation, never take it | it arrived |
| `available_for_pickup` **ever observed** | **nearing expiry** | **none** — see below. The window completes and the seller is paid | it's waiting for you to collect |
| *any other non-`delivered`* | **nearing expiry** | ⭐ **`raiseDispute`** on the buyer's behalf | we've raised this for you |
| dispute open, contested | — | **none** — hand evidence to the mediator | being sorted out |
| dispute open | **resolution period nearing expiry** | ⭐ **`escalateDispute`** to the dispute resolver | a person is now looking at it |

Two rows carry the product. The rest is bookkeeping.

### Why `delivered` takes no protocol action

Completing an exchange pays the seller irreversibly. **Tracking proves arrival, not condition** — it
cannot see a crushed box — so treating a delivery scan as confirmation would pay out on evidence that
does not support the conclusion.

On `delivered` the adapter therefore only *enables* confirmation. The buyer confirms and the seller
is paid, or the buyer disputes, or the window lapses and the seller is paid anyway. **A delivery scan
never moves money on its own.**

### ⭐ When the seller has performed and the buyer has not

`available_for_pickup` means the parcel reached a collection point and is **waiting for the buyer**.
The seller has fully performed: the goods were sent, arrived, and were made available. If the buyer
never collects, the parcel is eventually returned to sender — but the failure is the buyer's, not the
seller's.

**The watchdog must not raise a dispute in that case.** Doing so would accuse a seller who did
everything correctly, on evidence that in fact shows they succeeded. It would also make non-collection
a free option: a buyer could recover their money by doing nothing at all, and would not even need to
intend it, because the system would raise the dispute on their behalf automatically.

So here the protocol default — the window lapses, the seller is paid — **is the correct outcome**, and
the watchdog stands down. The watchdog exists to stop the buyer losing by inaction *when the loss is
not their fault*. It is not an advocate that acts against sellers regardless of what happened.

**The test is sticky, not current.** Once `available_for_pickup` has been observed **at any point**,
the watchdog stands down for that exchange permanently — including if the parcel is later returned to
sender and the milestone becomes `exception`. A naive reading of the *current* milestone would raise
a dispute at exactly the moment the buyer's own non-collection caused the return. Evaluate against
the full event list, per §5.

⚠️ **This carries a reciprocal obligation.** Declining to act is only defensible because the system
**told the buyer, prominently and repeatedly**, that the parcel was waiting. The `needs you`
buyer-facing state is therefore not cosmetic — it is what earns the right to stand down. If that
notification is ever weakened, this rule has to be revisited with it.

**`failed_attempt` is deliberately treated differently.** A failed attempt is ambiguous: the carrier
may have tried and found nobody in, may have logged an attempt it never made, or may have gone to the
wrong address. Nothing has been *made available* to anyone. The seller's performance is therefore not
demonstrated, and the watchdog still raises. In practice `failed_attempt` is a transient state that
resolves into `delivered`, `available_for_pickup` or `exception` before any deadline is reached.

---

## 3. Why `exception` does not raise a dispute

`exception` is the strongest non-delivery signal a carrier emits — lost, damaged, returned to sender.
It is tempting to raise immediately.

Don't. Raising early **forfeits the remaining window**, during which a parcel flagged as an exception
may still arrive; exceptions are frequently transient (a missorted item, a failed handover) and
resolve without intervention. The deadline logic already covers the case: if the parcel genuinely
never arrives, the window nears expiry and the watchdog raises then, on evidence that has become
unambiguous rather than merely alarming.

An `exception` therefore changes what the buyer sees and nothing else. **Waiting costs nothing here
and raising early costs the remaining window** — so wait.

---

## 4. The watchdog

Inaction pays the seller. There is no path in which a passive buyer who receives nothing is refunded,
and the same is true one level down: a dispute whose resolution period lapses also pays the seller.
The watchdog exists because of that asymmetry, and it is not optional.

### ⭐ The invariant

> **The watchdog may only take actions that keep the buyer's options open. It may never take one
> that closes them.**

| May | Must never |
|---|---|
| `raiseDispute` — stops the clock that pays the seller | `completeExchange` — pays the seller |
| `escalateDispute` — hands the case to a human decider | `resolveDispute` — settles for an amount |
| | `retractDispute` — abandons the buyer's position |

Every permitted action preserves a decision for a human to make later. Every forbidden one disposes
of money. This is the same boundary the AI components observe, applied to the automated one: **no
component of this system settles anything on its own.**

Escalation is free to the buyer because the dispute resolver's fee is zero for the exchange token —
see [`offer-model.md`](./offer-model.md) §3. If that fee were ever non-zero, autonomous escalation
would be spending the buyer's money without asking, and this invariant would have to be revisited.

### ⭐ How the watchdog is authorised

**Both automatic actions are the buyer's to take.** The protocol requires the sender of
`raiseDispute` and `escalateDispute` to be the exchange's buyer, and under a meta-transaction the
sender is whoever signed it. A service acting on its own authority cannot do either — the call
reverts.

So the watchdog holds **pre-signed meta-transactions**, captured from the buyer at purchase:

| Held | Scope |
|---|---|
| A signed `raiseDispute` meta-transaction | one `exchangeId`, one function |
| A signed `escalateDispute` meta-transaction | one `exchangeId`, one function |

When a deadline nears, the watchdog relays the relevant one. It never holds the buyer's private key
and never constructs a new authorisation.

> **This is what makes the invariant above structural rather than aspirational.** The watchdog does
> not *refrain* from completing an exchange or settling a dispute — it **cannot**, because no
> signature authorising either exists. The action space is enforced by cryptography, not by policy.

**Sequencing.** `exchangeId` is not known until the purchase transaction is mined, so the
pre-authorisations cannot be signed alongside it. They are a **second signing step immediately
after**, once the id is read from the logs.

**Requirements on the stored authorisations:**

- **Distinct nonces.** Each pre-signed transaction carries its own meta-transaction nonce, so the two
  are independent and neither depends on the other executing first. ⚠️ Confirm the protocol's nonce
  semantics are arbitrary-and-marked-used rather than sequential — sequential nonces would invalidate
  a pre-signed transaction the moment any other one executed.
- **They are bearer instruments.** Narrowly scoped ones, but anyone holding them can perform that one
  action on that one exchange. Store them as secrets. **They must never reach a fixture, a log or a
  commit.**
- **Discard on use.** Once relayed, or once the exchange completes, the stored authorisation is spent
  and is deleted.
- **If the buyer acts first**, the pre-signed transaction is simply never used.

⚠️ **If pre-authorisation is declined or fails, that exchange is unprotected**, and the buyer
interface must say so plainly rather than implying a watch that does not exist. The product promise
is that the buyer need not watch the deadline — making that promise without holding the signature to
keep it would be the worst failure available to this system.

### Thresholds

Both are named constants, not literals scattered through the adapter.

Both periods they measure against are **offer parameters**, fixed at purchase and specified in
[`offer-model.md`](./offer-model.md) §3: `disputePeriodDuration` runs from purchase,
`resolutionPeriodDuration` (3 days) runs from the moment a dispute is raised.

| Constant | Guards | Production | Demo |
|---|---|---|---|
| `DISPUTE_RAISE_LEAD` | Raise when this much of `disputePeriodDuration` remains | 48 h | scaled to the compressed window |
| `ESCALATION_LEAD` | Escalate when this much of `resolutionPeriodDuration` remains | 24 h | scaled likewise |

⭐ **Each threshold must be materially smaller than the period it guards.** If `ESCALATION_LEAD`
approaches `resolutionPeriodDuration`, the watchdog escalates the instant a dispute is raised — every
case reaches a human decider, the parties never get the chance to settle between themselves, and the
cheapest and most common path stops existing. The same holds one level up: a `DISPUTE_RAISE_LEAD`
too close to `disputePeriodDuration` raises disputes before the parcel has had a chance to arrive.

Express each as `max(fraction × period, floor)`. A pure fraction collapses to nothing on a short
window; a pure floor exceeds the whole period on a short one. Demo windows are compressed to minutes,
so the floor must scale with them or the watchdog fires before the parcel has moved.

⚠️ **A window must never be allowed to lapse in testing.** A lapsed dispute period pays the seller
and the exchange cannot be recovered — the parcel and the test run are both spent.

---

## 5. Event handling

The adapter receives pushed events and must survive the ways delivery goes wrong.

- **Idempotent.** The same event may arrive more than once. Key on tracker id plus event id and
  discard repeats. **A duplicate must never produce a second protocol write.**
- **Out of order.** Do not assume monotonic arrival. Derive state from the full event list on the
  tracking result, not from the event that happened to arrive last.
- **Never regress a milestone.** Once `delivered` is seen, a later `in_transit` does not undo it.
- **Idle is not healthy.** The watchdog runs on a clock, not on events. A parcel that stops producing
  events entirely is precisely the case it exists for — a delivery deadline cannot be driven by the
  arrival of a message that never comes.
- **A newly registered tracker reports `pending` with an empty event list** until the parcel is
  accepted into the network. That is not a failure.

⚠️ **Scrub before persisting.** Captured events carry postcodes and address fragments, including
inside free-text `location` strings where no field name suggests it. See rule 8 in `CLAUDE.md`.

---

## 6. Deliberately not automated

| Not automated | Why |
|---|---|
| Confirming receipt | Pays the seller. Belongs to the buyer |
| Proposing or accepting a split | The AI proposes; only a human accepts |
| Retracting a dispute | Abandons the buyer's position |
| Acting on `failed_attempt` / `available_for_pickup` | The carrier needs the *buyer*, not us |
| Raising a dispute after the parcel was made available for collection | The seller performed. Non-collection is the buyer's own doing, and the protocol default is already the just outcome |
| Deciding an escalated dispute | The dispute resolver decides. That is the whole point |

---

## 7. Invariants

1. **Only two protocol writes are ever automatic**: `raiseDispute` and `escalateDispute`, each
   relayed from a **pre-signed authorisation the buyer gave for that exchange**. Any new automatic
   write is a change to this spec, not an implementation detail — and would require a new signature
   the buyer has not given.
2. **No tracking event, of any kind, moves money by itself.**
3. **The mapping keys on `statusMilestone`.** Reading `statusCode` in the adapter is a defect.
4. **The watchdog is driven by a clock, never by an event.**
5. **Every automatic action is reversible by a human**; none disposes of funds.
6. **The watchdog never raises against a seller who performed.** If `available_for_pickup` has ever
   been observed for an exchange, no dispute is raised for it automatically — whatever the milestone
   later becomes.
7. **The watchdog never holds a private key** — only narrowly scoped signed instructions, which are
   secrets, are never committed, and are discarded once spent.
