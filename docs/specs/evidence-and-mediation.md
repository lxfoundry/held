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
| `listing` | The listing text as published before purchase | Establishes **what was described**, which is what an inaccuracy claim is measured against |
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
| Listing | a case fixture | **Authored**, modelled on a real peer-to-peer marketplace listing |

⚠️ **The authored items are marked as such in the bundle and stay marked all the way to the case
file.** The distinction between what was captured and what was written is the kind of thing that
gets lost in a rendering layer, and it is not recoverable afterwards.

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

That requirement is the protocol's, not this system's, which is what makes it worth relying on. The
mediator has no signer, no credential and no chain access:

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
// A gap that matters
{
  status: "needs_evidence",
  request: {
    what:          "a photograph of the outer shipping carton",
    whyItMatters:  "…which cause it supports, and how it changes the answer",
    whoCanProvide: "buyer",
  },
  findings: [ … ],
}

// A proposal
{
  status: "proposal",
  buyerPercent: 20,
  reasoning: "…",
  findings: [ { statement: "…", evidenceIds: ["pho-2", "lst-1"] }, … ],
}
```

`findings` is present in **both** branches and is bound by [§4.2](#42-grounding) in both. A request
for evidence rests on the model having read something that told it what was missing, and that
reasoning is as citable as a proposal's — a `needs_evidence` result with no findings is a question
asked from nowhere.

**The two rounds are the same function over different bundles.** Round one runs against a bundle
missing an item that would change the answer, and asks for it. The item is added, the bundle hashes
differently, and round two runs and proposes. A case with no gap proposes on the first call; there is
no special case and no separate "ask" path.

⭐ **The diagnostic question is load-bearing or it should not be asked.** A request is only useful if
the answer changes the proposal — if the same number comes back either way, the question was
decoration. This is directly testable: run round one, add the item, run round two, and assert the
number moved. A mediator that asks questions whose answers change nothing is worse than one that does
not ask, because it spends a party's effort to produce the appearance of diligence.

### 5.1 Reasoning is a field, not a trace

`reasoning` is part of the structured output. It is **not** the model's thinking trace.

The parties are shown what the model chose to present as its account of the decision, which is stable
across runs, quotable, and addressed to them. A raw reasoning trace is none of those things — it is
addressed to nobody, and presenting it as an explanation misrepresents what it is.

---

## 6. The clerk

Same bundle, different output: a case file containing the timeline, both parties' positions, what was
requested and what was provided, and what remains contested.

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
| Replay | a matching hash serves the recording and makes no API call |

Everything above runs against recorded responses and needs no API key. Only a live call needs one.

---

## 10. Open

- **Private submissions** — deferred, with the reasoning and the real cost in
  [§2.3](#23-visibility--a-slot-not-a-feature).
- **Multi-round exchange.** The mediator asks once and proposes. A real case might need several
  rounds, and a party might decline and counter. The protocol supports repeated resolution attempts;
  this system does not model the negotiation around them.
- **Chasing evidence from a party who does not respond.** The mediator can request; it has no channel
  to follow up on and no policy for what happens when a request goes unanswered. In this build the
  request is shown to the buyer and that is the whole mechanism.
