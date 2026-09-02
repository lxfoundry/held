# Spec — evidence assembly, the mediator and the case clerk

What the system reads when tracking cannot settle a dispute, and what it is allowed to do with it.

Tracking proves arrival, not condition. When a parcel arrives and something is nonetheless wrong,
there is no oracle that can decide the case — the evidence is photographs, a message thread and the
terms the parties agreed. This document specifies the component that assembles that evidence, and
the two thin behaviours built on it.

Everything here operates on the `exchangeId` produced by [the offer model](./offer-model.md) and on
the tracking snapshots produced by [the tracking-state mapping](./tracking-state-mapping.md).

---

## 1. One core, two behaviours

**Evidence assembly is a single component. The mediator and the clerk are thin layers on it.**

Both need the same three things — read the evidence, work out what is missing, go and get it — and
the temptation to build them as two features is the main design risk in this part of the system.

| | Reads | Produces | Runs at |
|---|---|---|---|
| **Mediator** | the bundle | a proposed split, with its reasoning | a raised dispute the parties are trying to settle |
| **Clerk** | the bundle | a case file | an escalated dispute going to a human decider |

⚠️ **The clerk does not recommend an outcome**, and this is enforced by how its input is built
rather than by asking it not to — see [§4.4](#44-the-clerk-cannot-see-a-proposal).

### 1.1 What triggers the mediator

**One trigger: a dispute exists on the exchange** — `disputeRaisedAt` is set on the record. Delivery
state, evidence quality and which rung of the ladder the case resembles have no part in it.

Who put it there is what varies:

| Tracking says | The buyer | Who raises | Mediation |
|---|---|---|---|
| `delivered` | is content | nobody — they confirm, or the window lapses and the seller is paid | no dispute, so none |
| **`delivered`** | **finds something wrong** | **the buyer, explicitly** | ⭐ **the case this component exists for** |
| not delivered, window nearing expiry | passive | the watchdog, on their behalf | runs; the evidence is usually one-sided |
| not delivered | acts before the watchdog | the buyer | runs |
| made available for collection | — | nobody automatically — the watchdog stands down, because the seller performed | only if the buyer raises anyway |

⭐ **The watchdog cannot produce the mediator's central case, by design.** On `delivered` the
decision function takes no action, on the ground that confirming belongs to the buyer — tracking
proves arrival, not condition, and cannot see a crushed box
([tracking-state mapping](./tracking-state-mapping.md)). A parcel that arrived damaged therefore
reaches mediation **only because the buyer said so**. There is no automatic path into rung three and
there should not be one: an automatic raise on a delivered parcel would accuse a seller on evidence
that shows they performed.

⭐ **Rungs are outcomes, not code paths.** A raised dispute is a raised dispute. Rung two is the
sub-case where the evidence is one-sided enough that the seller accepts at once — but if they do not,
that dispute sits open and is handled identically. **Mediation therefore runs on every open dispute**,
and no rule decides which ones deserve it. Such a rule would be tracking-derived policy in code,
which is the thing [§4](#4-the-bounds) exists to keep out.

> ⚠️ **Prerequisite: a buyer-initiated raise, which does not exist yet.**
>
> The only raisers today are the watchdog and the seeding script. The buyer's *"something is wrong"*
> action has to be built before the mediator's principal case is reachable at all, and it is a
> separate piece of work from anything else in this document.
>
> It needs no new mechanism. It spends **the same pre-signed `raiseDispute` authorisation the
> watchdog would have spent** — one instrument, two possible spenders — and the watchdog then stands
> down on its own, because the decision function moves to the escalation branch as soon as
> `disputeRaisedAt` is set. What it does need is that the attempt is recorded **before** the relay and
> attributed when the chain confirms, so a raise whose confirmation is lost is not later attributed
> to the wrong party.
>
> Attribution is buyer-visible and is the whole point of getting it right: a buyer who raised a
> dispute themselves must not be told the system raised it for them. As everywhere, the buyer never
> encounters the word *dispute*.

---

## 2. The evidence bundle

The bundle is a **deterministic, serialisable list of items**. It is the only thing either behaviour
reads. Nothing downstream may reach around it to a live source.

```js
{
  exchangeId: "241",
  items: [
    { id: "trk-7", kind: "tracking_event", provenance: "carrier",  visibility: "shared", ... },
    { id: "pho-2", kind: "photo",          provenance: "buyer",    visibility: "shared", ... },
    { id: "msg-4", kind: "message",        provenance: "seller",   visibility: "shared", ... },
    { id: "lst-1", kind: "listing",        provenance: "listing",  visibility: "shared", ... },
    { id: "off-1", kind: "offer_terms",    provenance: "chain",    visibility: "shared", ... },
  ],
  hash: "…",
}
```

### 2.1 `id` — stable, short, and cited

Every item carries an id that is stable for the life of the case. The model cites these ids in its
findings, and [the grounding bound](#42-grounding) checks every citation against the bundle it was
given. Ids are short by design: they appear many times in model output, and a UUID per item is
tokens spent on nothing.

Ids are assigned by assembly, in a defined order, so the same sources always produce the same ids.

### 2.2 `provenance` — where the item came from, and what it is worth as evidence

| `provenance` | Meaning | What it can and cannot support |
|---|---|---|
| `carrier` | A tracking event, as reported by the tracking aggregator | Proves the parcel's **movement and arrival**. Not signed by the carrier — it is the aggregator's read of the carrier. Says nothing about condition |
| `buyer` | Submitted by the buyer — photographs, statements | Unverified. A photograph shows what it shows; it does not establish when it was taken |
| `seller` | Submitted by the seller, including their messages | Unverified, same as above |
| `listing` | The description of the item as it stood at purchase | Establishes **what was described**, which is what an inaccuracy claim is measured against. Belongs to the offer rather than to either party — see [§3.1](#31-the-listing-belongs-to-the-offer) |
| `chain` | Read from the protocol — price, periods, resolver, timestamps | The only provenance that is cryptographically settled |

⭐ **Provenance is a first-class field rather than a comment** because the system's honesty about
evidence quality has to survive into the output. A case file that presents an aggregator's tracking
read and a buyer's photograph as the same kind of fact is misleading, and the fix belongs in the data
model, not in the prompt.

### 2.3 `visibility` — a slot, not a feature

Every item carries `visibility`, and **in this build every item is `shared`**. Assembly takes a
viewer parameter, and it is always the mediator.

The field exists because private submission is how real redress schemes work: parties submit to the
decider, not to each other. This build does not implement it, for a reason worth stating plainly —
**there is no seller-side interface in this system**, so a seller-private submission could only be an
authored fixture that changes an outcome nobody can inspect. The system would be claiming a
capability it does not have.

What one shared record buys, and what should be said rather than discovered:

> Every item is shared. The file the mediator reads is the file both parties read, and neither party
> has an information advantage over the other or over the mediator.

⚠️ **A field that is never exercised will be wrong the first time it is.** `visibility` is a marker
for a decision that has been made and deferred, not a working feature. Implementing it is not a
matter of populating the field: it requires per-audience views, a redaction pass over any text shown
to a party, and the grounding bound in [§4.2](#42-grounding) becoming an audience check rather than
a containment check — because reasoning that cites a private item leaks it. Do not treat the presence
of this field as evidence that the work is nearly done.

### 2.4 The hash

The bundle is hashed over its serialised items. The hash is what makes a case reproducible: a
proposal is recorded against the bundle that produced it, and [the replay path](#7-replay) keys on
it. Two runs over the same evidence produce the same hash; adding one photograph produces a
different one, which is exactly the event [the mediator's second round](#5-the-mediator) turns on.

---

## 3. Assembly

Assembly reads five sources and produces the bundle. It is a pure function of its inputs — it
performs no network calls of its own, so a case can be rebuilt from what is on disk.

It takes a **viewer**, which selects the items that viewer may see. Today every item is `shared` and
every caller passes the mediator, so the parameter has one value and selects everything
([§2.3](#23-visibility--a-slot-not-a-feature)). It is present so that the shape of the record does
not have to change later, not because it does anything now.

| Source | Where it comes from | Real or authored |
|---|---|---|
| Tracking events | the captured event store | **Real** — genuine carrier events for a genuine parcel |
| Offer terms | read from the protocol for the `exchangeId` | **Real** |
| Photographs | files supplied with the case | **Real** — photographs of a real parcel and its contents |
| Message thread | a case fixture | **Authored.** There is no seller-side interface; the seller's side of this system is scripted |
| Listing | a case fixture | **Authored**, modelled on a real peer-to-peer marketplace listing. Belongs to the offer by design — [§3.1](#31-the-listing-belongs-to-the-offer) |

⚠️ **The authored items are marked as such in the bundle and stay marked all the way to the case
file.** The distinction between what was captured and what was written is the kind of thing that
gets lost in a rendering layer, and it is not recoverable afterwards.

### 3.1 The listing belongs to the offer

Treating the listing as a case fixture is a property of this build, not of the design. **The listing
is offer metadata.**

A protocol offer carries `metadataUri` and `metadataHash`, and [the offer model](./offer-model.md)
has the **seller sign the full offer** — which commits to those fields. A listing carried in offer
metadata is therefore not a screenshot somebody kept; it is *the description the seller signed*,
fixed at the moment of purchase, and the hash on chain makes any later alteration detectable. Pinned
to content-addressed storage, it survives the original advertisement being edited or deleted — which
is the ordinary fate of a marketplace listing, and otherwise the ordinary way an inaccuracy claim
becomes unarguable.

The metadata would carry the description text, a capture of the advertisement, and its source
address.

> ⚠️ **What that proves, precisely.** It proves the description has not changed since purchase and
> that the seller signed it. It does **not** prove the marketplace ever displayed it — the capture is
> still a capture. The claim is *this is what was agreed*, never *this is what was published*, and
> the distinction matters for the same reason tracking data is the aggregator's read rather than the
> carrier's attestation.

**Not implemented in this build.** Offers currently carry placeholder values in both fields, and the
listing is an authored fixture with `provenance: "listing"`. Nothing downstream should assume the
listing is anchored, and nothing should be written that would have to be unwound if it later is: the
bundle already carries the listing as its own item with its own provenance, which is the whole of
what anchoring it would change.

⚠️ **Photographs carry location data**, both in EXIF metadata and in whatever is visible in frame.
Case fixtures are committed to this repository. Strip metadata at the point a photograph enters the
case store, on the same principle as the tracking fixtures: redact at capture time, not in a later
audit.

---

## 4. The bounds

The model produces the number and the reasoning. **Code bounds what the number can be and checks
that the reasoning is grounded. No bound evaluates whether the number is fair** — fairness is the
model's whole job, the proposal is inert until a human accepts it, and either party may decline.

This distinction is the point. A guard that encoded a fairness rule would be the system's own policy
wearing the model's clothes, and it would be wrong the moment a case did not match the rule that was
written for it.

### 4.1 The action space

The model's settlement-bearing output is **one number**: the buyer's share of the escrowed pot,
0–100%. The output schema has no field for any other remedy — not a replacement, not a partial
return, not a deadline. A wider remedy is **unrepresentable**, not rejected.

This mirrors the protocol rather than constraining it. Mutual resolution is:

```
resolveDispute(exchangeId, buyerPercentBasisPoints, signature)
```

signed as an EIP-712 struct with exactly two fields:

```
Resolution { exchangeId: uint256, buyerPercentBasisPoints: uint256 }
```

one of which is the exchange id. There is nowhere in the protocol to put a remedy that is not a
percentage, so there is nowhere in this system either.

> ⚠️ **`buyerPercentBasisPoints` is the buyer's share, in basis points, 0–10000.**
>
> Direction and scale are both easy to invert, and inverting either pays the wrong party in full.
> - `10000` → the buyer receives the entire pot. `0` → the seller does.
> - Offers in this build carry `sellerDeposit: 0`, so **the pot is exactly the item price.**
> - A refund of 40 on an item priced at 200 is a buyer share of **20%**, which is **2000**.
>
> The model proposes a percentage. Conversion to basis points happens once, in one place, and is
> covered by a test that asserts the direction and not merely the arithmetic.

### 4.2 Grounding

Every finding carries `evidenceIds`, and **every id must exist in the bundle the model was given.**
A citation to an absent id fails the proposal.

This is an anti-fabrication check, not a fairness check. It says nothing about whether the finding is
correct — only that the thing it cites was actually in front of the model. A proposal that reasons
from a photograph nobody submitted is unusable regardless of what number it reaches.

On failure: retry once, then fail the case rather than present an ungrounded proposal.

### 4.3 Consent

**The proposal is inert.** It is recorded and shown. It settles only when `resolveDispute` is called
carrying the counterparty's signature over the `Resolution` struct.

That requirement is the protocol's, not this system's, which is what makes it worth relying on: one
party signs and the *counterparty* submits, so no arrangement of this code can settle a dispute on
one party's say-so. A signature is held bound to one exchange and one exact percentage, and the
submission is checked against the proposal the accepting party was shown — so a consent given for
one proposal cannot settle another, and neither party can be settled at a number they never saw.
Declining is the absence of an acceptance rather than an action: an unaccepted proposal simply does
not settle, and the case reaches a human decider by the escalation path.

The mediator has no signer, no credential and no chain access:

⭐ **The request that runs the mediator has no `tools` field at all.** The rule that no model-driven
component may hold a tool that moves funds is therefore not a discipline anyone has to maintain — it
is the absence of a parameter, visible in one place, and its violation would be a visible addition
rather than an invisible omission.

### 4.4 The clerk cannot see a proposal

The clerk's bundle is constructed **without** the proposal record. Not filtered on the way out —
absent on the way in.

The requirement is that no proposed split leaks into a case file that goes to a human decider, whose
job is to decide without being anchored. Implementing that as an instruction in a prompt would make
it a request; implementing it as input construction makes it a fact about what the clerk can
possibly know.

---

## 5. The mediator

One function. It returns a **discriminated union**, not two modes:

```js
// Gaps that matter — one round, however many requests
{
  status: "needs_evidence",
  requests: [
    {
      what:          "a photograph of the outer shipping carton",
      whyItMatters:  "…",          // shown to the party
      whoCanProvide: "buyer",
      wouldChange: [               // internal — never shown, see §5.1
        { answer: "carton intact",  implies: "damage pre-existing; description inaccurate", split: 20 },
        { answer: "carton crushed", implies: "damage in transit; packing inadequate",       split: 8  },
      ],
    },
    …
  ],
  provisional: { buyerPercent: 20, reasoning: "…" },   // internal
  findings: [ … ],
}

// A proposal
{
  status: "proposal",
  buyerPercent: 20,
  reasoning: "…",
  findings: [ { statement: "…", evidenceIds: ["pho-2", "lst-1"] }, … ],
}

// Contested beyond what evidence can settle
{
  status: "cannot_settle",
  reasoning: "…",
  findings: [ … ],
}
```

**`requests` is a list, and its contents are case-specific.** Nothing about a request is drawn from a
fixed set: the model writes what it needs and why, and may address either party. *Re-take the carton
photograph square to the damage, it is out of focus* and *the description says bought new a month ago
— the purchase receipt would settle it* are the same mechanism as the carton question, not
extensions of it.

It is a list rather than a single request because a case handler who asks for one thing, receives it,
then asks for a second has cost the party two round trips to learn what one would have. If the model
can see three gaps, it asks for three.

**`cannot_settle` is the honest third outcome.** Some cases are contested in a way more evidence will
not fix. Without this branch the model's only ways to express that are to keep asking or to produce a
number it does not believe, and the second is the exact failure the bounds in [§4](#4-the-bounds)
exist to prevent — a confident figure with nothing under it. A case that cannot settle goes to rung
four, which is what rung four is for.

> ⚠️ **`cannot_settle` means *more evidence would not settle this*, not *the parties disagree*.**
> Disagreement is the normal condition of a dispute and contradictory evidence is ordinary — a buyer
> and a seller describing the same parcel differently is the case, not a failure of the case. If
> `cannot_settle` comes to mean disagreement it will be returned for everything, and the rung that is
> supposed to be rare becomes the default.

`findings` is present in **both** branches and is bound by [§4.2](#42-grounding) in both. A request
for evidence rests on the model having read something that told it what was missing, and that
reasoning is as citable as a proposal's — a `needs_evidence` result with no findings is a question
asked from nowhere.

**Rounds are the same function over successively larger bundles.** A round runs against a bundle,
asks for what is missing, the evidence is added, the bundle hashes differently, and the next round
runs. A case with no gap proposes on the first call; there is no special case and no separate "ask"
path.

⭐ **Rounds are not a conversation, which is why there can be several.** Each round is an independent
call over a larger bundle, with its own hash and its own recording. There is no history to resend, no
conversation state to carry and no context to manage, so the record and replay paths in
[§7](#7-replay) handle any number of rounds unchanged. What multi-round costs is a loop, a cap and a
flag — see [§5.3](#53-rounds-and-how-a-case-is-guaranteed-to-end).

⭐ **The diagnostic question is load-bearing or it should not be asked.** A request is only useful if
the answer changes the proposal — if the same number comes back either way, the question was
decoration. This is directly testable: run round one, add the item, run round two, and assert the
number moved. A mediator that asks questions whose answers change nothing is worse than one that does
not ask, because it spends a party's effort to produce the appearance of diligence.

### 5.1 How the mediator knows it has enough

It does not, and asking it to judge that would be circular — *"ask only if it matters"* is an
instruction, not a mechanism. The question is answered by removing it:

> **The mediator never decides it has enough. Asking is not what it does when it lacks a number — it
> is what it does when it has one and can say what would change it. A request is a claim that a
> specific, obtainable piece of evidence would move the split, with the alternative outcomes named.**

That is what `wouldChange` and `provisional` are for. Every `needs_evidence` result carries the split
the model would propose **right now**, and every request carries the branches it expects and what
each would imply. If the branches converge, the question does not matter and is not asked.

⚠️ **`cannot_settle` is the one state with no provisional split, and that is the point of it.** It is
not "I have a number but I am unsure" — that case has a provisional and asks, or proposes. It is *no
defensible number exists on this evidence*, which is a different claim and the one that justifies
spending a human's time. A `cannot_settle` carrying a split it declined to propose would be neither.

This turns the load-bearing rule above from something checkable only afterwards into something the
model must commit to **at the moment of asking**. Four things follow, and the first three are the
reason this is worth the extra fields:

- **The deadline always has an answer ready.** [§5.3](#53-rounds-and-how-a-case-is-guaranteed-to-end)
  says a round that cannot be answered in time proposes on what it has. With `provisional`, *what it
  has* is already a number rather than a scramble at the worst moment.
- **An unanswered request degrades into a decision.** The mediator proposes the branch the existing
  evidence best supports and records which branch it assumed.
- **A final round never has to invent anything**, so the round cap cannot force a number that came
  from nowhere.
- **Calibration becomes measurable.** The model said *intact → 20*, the photograph came back intact,
  and it proposed 12. Its own counterfactual was wrong, and that is visible in the record without
  anyone having to form a view on whether 12 was fair.

> ⚠️ **`wouldChange` and `provisional` are never shown to a party.** If the buyer can see *intact →
> 20%, crushed → 8%*, they know which photograph to send, and the evidence request becomes a
> multiple-choice question with the marks printed on it.
>
> `whyItMatters` is the shown field, and it has to motivate the request **without revealing which
> answer favours the party being asked**. The naive rendering displays the whole request object,
> which is why this is written down rather than left to be noticed.

**What this does not fix.** Over-curiosity is now detectable after the fact — the branches are in the
record and can be compared with what actually happened. **Over-confidence is not.** A mediator that
proposes when a question would have helped produces no request, no branch, and no signal of any kind.
The round cap and the ladder bound the damage; nothing here prevents it.

⚠️ **No materiality threshold belongs in code.** Do not add a bound rejecting requests whose branches
differ by less than some percentage. Where that line falls is case-specific judgement, it is the
model's to make, and it is inspectable in the record — encoding it would be the same error as
encoding a fairness rule ([§4](#4-the-bounds)).

### 5.2 Reasoning is a field, not a trace

`reasoning` is part of the structured output. It is **not** the model's thinking trace.

The parties are shown what the model chose to present as its account of the decision, which is stable
across runs, quotable, and addressed to them. A raw reasoning trace is none of those things — it is
addressed to nobody, and presenting it as an explanation misrepresents what it is.

### 5.3 Rounds, and how a case is guaranteed to end

A component that asks for evidence can wait forever, and a component that may ask again can ask
forever. Three bounds prevent it, and **the mediator owns only the weakest of them**.

**1. A round cap.** `MEDIATOR_MAX_ROUNDS`, default 3. The final round is *told* it is final and must
return `proposal` or `cannot_settle`; `needs_evidence` is not a valid answer to a final round. This
bounds the number of calls, and nothing else.

**2. The deadline is the protocol's, not the mediator's.** A raised dispute has a resolution period,
and when it lapses **the seller is paid** — the same fact the watchdog exists for. The watchdog
already escalates at `ESCALATE_LEAD` before that instant, computed from `disputeRaisedAt` and
`resolutionPeriodMs` on the exchange record.

`disputeRaisedAt` is **the date the protocol recorded**, read back off the chain when the raise is
confirmed — never the moment the recording process noticed. The protocol enforces the resolution
period against its own clock, so a deadline computed from a local one is a deadline for a different
instant, and the gap is unbounded: a record rewritten while a dispute is already open reads as
undisputed, and would otherwise date a day-old dispute to now.

Mediation therefore runs inside a window that is already guarded, and its deadline is that escalation
instant — read from the record, never a timer the mediator starts. Each round checks the time
remaining. A round that cannot plausibly be answered before the deadline does not ask: it proposes on
what it has, or returns `cannot_settle`.

**3. The ladder is the actual guarantee.** If mediation reaches no agreement — cap exhausted,
deadline reached, requests unanswered, or the model saying outright that it cannot settle — the
watchdog escalates and rung four takes over. The case ends whether or not the mediator succeeds.

⭐ **The mediator has no termination responsibility it can fail at**, and that is the property worth
having. Its bounds are a counter it cannot exceed and a clock it did not set, both enforced outside
it. A component that must not hang is a component that eventually will.

⚠️ **An unanswered request is a normal ending, not an error.** There is no seller-side interface in
this build, so a request addressed to the seller *will* go unanswered — the first realistic case
produces one. The case proceeds on the evidence that exists, and the case file records what was asked
and never provided. Treating unanswered as an error condition would deadlock exactly the cases the
system is for.

---

## 6. The clerk

Same bundle, different output: a case file containing the timeline, both parties' positions, what was
requested and what was provided, and what remains contested.

It runs on the cases mediation did not close — the round cap exhausted, the deadline reached, a
`cannot_settle`, or requests that went unanswered. **Every request across every round appears in the
case file, answered or not.** An unanswered request is part of the record of a case, not an absence
from it: what a party was asked for and did not supply is exactly the kind of thing a human decider
needs and cannot reconstruct afterwards.

The clerk's job is completeness, not judgement. It does not recommend, cannot see a proposal
([§4.4](#44-the-clerk-cannot-see-a-proposal)), and marks every item with its provenance so a human
decider can weigh a buyer's photograph differently from a protocol read.

---

## 7. Replay

Every model call writes `{ bundleHash, request, response }` to a case store.

A replay mode serves the recorded response for a matching bundle hash instead of calling the API.
This exists for three reasons, in ascending order of importance:

1. Tests run against recorded responses with no API key, like the rest of this repository.
2. A case can be re-examined later without re-running a model that may since have changed.
3. **The system runs without network access to the model provider.** A demonstration that depends on
   a live API call over an unreliable connection has a failure mode that no amount of care removes.

⚠️ **Replay is disclosed wherever it is used.** A replayed proposal is a recording of a real run, and
is labelled as one — the honest claim is *"this ran, here is what it produced"*, never an implication
that it is running now.

---

## 8. The model call

A single request per round. No tools, no agent loop, no conversation.

| | |
|---|---|
| Model | `claude-opus-5` |
| SDK | `@anthropic-ai/sdk` — **not currently a dependency; it must be added** |
| Output | Structured output via `output_config: { format: … }` against the schemas in [§5](#5-the-mediator) |
| Thinking | `thinking: { type: "adaptive" }` |
| Tools | **none — no `tools` field**, see [§4.3](#43-consent) |
| Photographs | passed as image content blocks, base64 |
| Credentials | `ANTHROPIC_API_KEY` and `MEDIATOR_MODEL` in `.env`, already reserved in `.env.example` |
| Round cap | `MEDIATOR_MAX_ROUNDS`, default 3 — **new, to be added to `.env.example`** ([§5.3](#53-rounds-and-how-a-case-is-guaranteed-to-end)) |

`MEDIATOR_MODEL` defaults to `claude-opus-5` when unset. The model in use is recorded on every case
record, so a case file states which model produced its proposal rather than leaving it to be inferred
from a deployment date.

⚠️ **`output_format` is a deprecated parameter and is not what this uses.** The current parameter is
`output_config.format`.

The prompt carries the objective — assess the evidence and propose the split that is most fair —
together with the constraints from [§4](#4-the-bounds) and the provenance framing from
[§2.2](#22-provenance--where-the-item-came-from-and-what-it-is-worth-as-evidence). **It carries no
case-specific rules.** A prompt that names the situation it expects has stopped being a mediator and
become a lookup table with a language model attached.

---

## 9. Testing

| What | How |
|---|---|
| Assembly determinism | same sources → same ids, same hash; one added item → different hash |
| Provenance preservation | authored items stay marked through assembly and into the case file |
| Basis-point conversion | direction **and** scale, including both endpoints |
| Action-space bound | out-of-range and non-numeric proposals are rejected |
| Grounding bound | a citation to an absent id fails; a valid citation passes; both branches are checked |
| Grounding retry | one ungrounded response retries; a second one fails the case rather than presenting it |
| Clerk isolation | a bundle built for the clerk contains no proposal, asserted structurally |
| Two-round behaviour | recorded round one asks; recorded round two, with the item added, proposes a different number |
| Trigger | mediation runs on any record with `disputeRaisedAt` set, whoever raised it, and on no record without it |
| Provisional present | every `needs_evidence` carries a provisional split; `cannot_settle` carries none |
| Branches present | every request names at least two branches, and they do not all imply the same split |
| Display isolation | nothing rendered to a party contains `wouldChange` or `provisional`, asserted over the whole rendered surface |
| Round cap | a final round returning `needs_evidence` is rejected; the cap is never exceeded |
| Deadline | with the escalation instant passed, no request is made and the case closes on what it has |
| Unanswered request | a request nobody answers ends the case normally and appears in the case file |
| Replay | a matching hash serves the recording and makes no API call |

Everything above runs against recorded responses and needs no API key. Only a live call needs one.

---

## 10. Open

- **Private submissions** — deferred, with the reasoning and the real cost in
  [§2.3](#23-visibility--a-slot-not-a-feature).
- **Negotiation after a proposal.** Rounds of evidence-gathering are specified
  ([§5.3](#53-rounds-and-how-a-case-is-guaranteed-to-end)); rounds of *bargaining* are not. A party
  who declines a proposal and counters with their own number has no path here. The protocol supports
  repeated resolution attempts, so this is a gap in this system rather than in what is underneath it.
- **A channel to reach a party.** The mediator can address a request to either party, but only the
  buyer is reachable — requests are shown in the buyer's view and that is the whole mechanism. A
  request to the seller is recorded, shown and expected to go unanswered
  ([§5.3](#53-rounds-and-how-a-case-is-guaranteed-to-end)).
