# The buyer's view

The only part of this system a person looks at. Everything else — the receiver, the adapter, the
watchdog, the mediator, the clerk — runs unattended and is read through logs. This is the surface.

It is a **view over the stores**. It computes nothing about an exchange that the rest of the system
does not already know, it simulates nothing, and it holds no state of its own. If a screen says a
dispute was raised, a record on disk says so too.

## 1 · What it is not

- **Not a marketplace.** There is no discovery, no search, no listing creation, no seller interface.
  A buyer arrives holding a purchase that already exists.
- **Not multi-user.** No accounts, no sign-in, no sessions. It runs on one machine for one buyer.
- **Not deployed.** Unlike the receiver, this binds to loopback on a laptop and is never exposed.
  That is what makes it safe for it to hold chain credentials, which the receiver deliberately
  does not.
- **Not built.** No bundler, no framework, no front-end dependency tree. Three static files served
  as they are written.
- **Not browser-tested.** Its logic lives in a pure module that is tested directly; the markup is
  reviewed by looking at it. Browser automation is out of scope.

## 2 · The vocabulary rule

**No protocol vocabulary reaches the screen.** Not *voucher*, *rNFT*, *redeem*, *escrow*, *commit*,
*wallet*, *on-chain*, *smart contract*, *exchange*, or *dispute resolver*. The atomic commit-and-redeem
flow exists precisely so a buyer never encounters those words, and this view must not reintroduce them.

The rule is enforced structurally, not by review: **every user-visible string lives in
`BUYER_STRINGS` in `src/buyer-state.mjs`**, which is the one module a single test can walk. A string
written into HTML or into the view module is invisible to that test, so the spec requires that the
view model emit only

- keys resolved through `BUYER_STRINGS`, and
- values that are data — an item title, a price, a date, a tracking description.

## 3 · The two lines

An exchange presents as **two independent lines**, already implemented in `src/buyer-state.mjs`:

| Line | Answers | Source |
|---|---|---|
| **Money** | What happened to my money | the record: `finalisedAt`, `outcome` |
| **Parcel** | What happened to my parcel | the tracking snapshot and the record's dispute fields |

They change for different reasons at different moments and are never interleaved.

The money line itself is two parts: `moneyLine()` returns `{ key, text, meta }` — `text` is the
headline, `meta` a second line beneath it once the money has finalised (`null` while it is still
`held`). §4 gives the exact copy for both.

### 3.1 · The money line gains a third ending

`moneyLine()` currently returns *held*, *paid* or *returned*. That is one ending short.

Mutual resolution settles at a **percentage**, so an exchange can end with part of the money
returned and the rest paid — the buyer keeps the item and is compensated for its condition. Today
`scripts/watchdog.mjs` maps every non-zero buyer percentage to `outcome: "returned"`, and the buyer
is then told *"Your money has been returned."* while holding the item and most of the price gone to
the seller. **That is false, and it is false in the one case mutual resolution exists to produce.**

Two changes, and they are to **different things** — the record's `outcome` and the line the buyer
reads are not the same set, and conflating them is how `held` looks like it is being removed:

1. **`moneyLine()` gains a fourth line: `held | paid | returned | split`.** `held` is untouched and
   remains correct until the exchange finalises — whether that is by completion or by a resolved
   dispute.
2. **`outcome` gains a third value: `"paid" | "returned" | "split"`.** It stays `null` until the
   exchange finalises, because — as `scripts/watchdog.mjs` already puts it — an outcome is what
   happened to the money, and until then nothing has. `held` is therefore not an outcome and never
   was; it is the line rendered in the *absence* of one.
3. The record carries `buyerPercent` alongside `outcome`, so the view can state the amount rather
   than the fraction.

| `finalisedAt` | `outcome` | `buyerPercent` | Line |
|---|---|---|---|
| `null` | `null` | — | `held` |
| set | `"paid"` | `0` | `paid` |
| set | `"returned"` | `100` | `returned` |
| set | `"split"` | `0 < p < 100` | `split` |

`scripts/watchdog.mjs` and `src/completion.mjs` write the record columns; `moneyLine()` reads them.

## 4 · Every state

Copy is exact. `{…}` is data resolved at render time.

### Money

| `outcome` | Copy |
|---|---|
| `null` — not finalised | **Your money is held.** · The seller can't touch it. |
| `paid` | **Seller has been paid.** · {price} · {date} |
| `returned` | **Your money has been returned.** · {price} · back to you |
| `split` | **{refund} has come back to you.** · The seller has been paid the rest. |

Each row is two parts. The bold sentence is `text` — the largest type on the screen, in every state.
Everything after the middot is `meta` — a second, quieter line beneath it, filled from the matching
`*_meta` string in `BUYER_STRINGS` (`paid_meta`, `returned_meta`, `split_meta`). `moneyLine()` returns
`{ key, text, meta }`; `meta` is `null` whenever the line is `held` — the money hasn't finalised, so
there is nothing yet to add — and also on `paid` and `returned` for a listing that states no price,
where a second line built from that price would have nothing to state. Only `split`'s second line is
copy alone, and it is always present. `{date}` in `paid_meta` is `finalisedAt`, formatted the same way §5's deadline
date is, so two dates on the same screen cannot disagree in style.

An `outcome` that is absent, or one `moneyLine()` does not recognise, is **not an ending**: the line
falls back to `held` rather than to any of the three. Each of the three asserts where the money went,
and a record that names no outcome supports none of those assertions — least of all `paid`, which
tells the buyer their money is gone. `src/exchanges.mjs` skips null fields when it writes and does
not validate what it reads, so this is a state a store can hold, not a hypothetical.

The two clean endings render green; **`split` renders amber**. A negotiated ending is neither of the
other two, and colouring it as one of them repeats the error §3.1 fixes.

`split` carries one supporting line beneath the item, and only `split` does — a third piece of copy,
separate from `meta` and drawn below the item row rather than inside the money block:

> You both agreed. No platform, no court.

It is the only ending both parties chose, and the only one worth saying anything about.

### Parcel

| Condition | Copy |
|---|---|
| **no tracking at all** | We don't have tracking for this |
| in transit | On its way |
| `failed_attempt` | The courier couldn't deliver it — it needs you |
| `available_for_pickup` | It's waiting for you to collect |
| `exception` | We're looking into it |
| delivered | It arrived |
| dispute raised by the watchdog | It hasn't arrived. We've raised this for you. |
| dispute raised by the buyer | Let's sort this out |
| escalated | A person is now looking at it |

**A line describing an open process must not survive finalisation; a line that states a fact may.**
"Let's sort this out" and "A person is now looking at it" are both present-tense claims about a
process still running — once `finalisedAt` is set, both are false, and `parcelLine()` falls through
to whatever the tracking data shows beneath them (a delivered parcel then reads "It arrived"). "It
hasn't arrived. We've raised this for you." states what happened rather than what is still open; it
remains true after settlement and is not conditioned on `finalisedAt` at all.

⚠️ **An absence is not a state, and is not drawn as one.** Every row but the first states where the
parcel is. A record whose `trackerId` resolves to no snapshot — never registered, cleaned up, or an
`EVENTS_DIR` pointing elsewhere — supports none of those claims, and the in-transit row is the
fall-through, so it read *"On its way"* about a parcel nothing has scanned. On a finalised record it
sat directly beneath *"Seller has been paid."* This is the same rule §4's `outcome` fallback states,
on the other line: **what the store does not hold is not asserted.** ⭐ A tracker that exists and has
simply not been scanned yet is a different thing — that is `pending`, and it still reads *"On its
way"*.

## 5 · The delivered state, and what the buyer owes

When a parcel is delivered, the screen offers two actions:

> **It arrived, all good** — completes the exchange, paying the seller now
> **Something's wrong** — raises a dispute

**These two have opposite relationships to the deadline, and the screen must say so.** Above the
buttons:

> The seller is paid on {date}. If something's wrong, say so before then.

Both clauses are true and each answers one button, in the order the buttons appear. `{date}` is
`redeemedAt + disputePeriodMs` off the record — never a written-in date.

Two rules follow from that being **the only warning they get**, and they are the same rule twice:
*a date on this line is a claim, and a wrong one costs the buyer their money.*

- **Both terms, or no line.** The record permits a null `redeemedAt`, and `null + a period` is not
  an error — it is an instant in January 1970. Where either term is not a number the notice is
  **omitted**, never rendered from what is there. The buttons are unaffected: the deadline is
  unstated, not the purchase.
- **Read against the buyer's calendar**, which is a fixed zone and not the machine's. These are
  instants; a date is what a person reads off a calendar. Formatted in UTC, a deadline half an hour
  past midnight shows as the day before — telling the buyer to act a day early — and formatted in
  the serving machine's own zone, the date on screen would depend on which laptop drew it.
  A carrier's scan in the parcel timeline is the **one exception and reads its own clock**: it
  carries the offset it was stamped with, and shows the time printed on the scan.

Why this line is required rather than decorative:

- **Completing is optional.** If the buyer does nothing the dispute period elapses and the seller is
  paid anyway. Completing only makes that happen sooner. A screen that implies the seller depends on
  the buyer's attention to be paid describes a mechanism this is not, and an unfair one.
- **Raising is not optional.** The watchdog stands down on a delivered parcel — *"delivered;
  confirming belongs to the buyer"* — because tracking proves arrival, not condition. **Nothing
  raises a dispute on behalf of a buyer whose parcel arrived broken.** If they do not act before the
  period elapses, the seller is paid and it is final. This line is the only warning they get.

## 6 · Architecture

```
   browser ──poll──▶ src/buyer-server.mjs ──▶ src/buyer-view.mjs  (pure)
      │                      │                        ▲
      │                      ├── exchange store ──────┤
      │                      ├── tracking store ──────┤
      │                      ├── case store ──────────┤
      │                      └── listing fixture ─────┘
      │
      └──POST──▶ src/completion.mjs · src/disputes.mjs · src/resolution.mjs
```

| Module | Responsibility | Depends on |
|---|---|---|
| `src/buyer-view.mjs` | **Pure.** `viewFor({ record, tracking, caseRecord, listing, photos, events, allowConfirm, allowSettle })` → the whole view model. Every state in §4 is one case. | `buyer-state.mjs` only |
| `src/buyer-state.mjs` | All user-visible copy; the two lines | nothing |
| `src/buyer-server.mjs` | HTTP: static files, JSON reads, action writes | the stores, the action modules |
| `public/index.html`, `held.css`, `held.js` | One screen, rendered from the view model | nothing |
| `src/completion.mjs` | Completing an exchange, extracted from `scripts/confirm-receipt.mjs` | chain |
| `src/disputes.mjs` | Raising on the buyer's behalf — **already written; arrives with the buyer-initiated raise branch, which this spec assumes is merged** | chain |
| `src/resolution.mjs` | Settling a proposal — **the seam, see §9** | chain |
| `scripts/replay.mjs` | Writes captured carrier events into a store on a timer | the tracking store |

`src/buyer-view.mjs` performs **no I/O**. The server gathers, the view decides, the client draws.
That is what makes every state in §4 a table row in a test rather than a browser session.

**The client draws every action the model emits, and decides none of them.** `allowConfirm` and
`allowSettle` are the two operator settings the model takes, and they work the same way: the
operator's choice becomes an action that is enabled, or one drawn disabled with a neutral reason.
A client that dropped an action the model reported as enabled would leave the buyer reading the
mediator's question with no visible way to answer it — so it draws what it is told.

⚠️ **Adding a photograph takes no such setting, and is never drawn disabled** (§8.3). Which branch
of the damage case to attach is an operator's decision, but it is not a decision about *whether* the
buyer may answer: it reaches the server in the page's own URL, is sent back in the `photos` request
body, and never appears in the buyer's model. `photos` — the photographs the case already holds —
is an input to the model for the opposite reason: it is what §8.4 draws back to the buyer.

### 6.1 · Where the item comes from

The exchange record holds no item title, price or image — it is protocol state, and adding display
copy to it would create a second price that can disagree with the one that moves. The view reads
the `listing` block already present in `fixtures/case/<exchangeId>.json`:

```json
{ "listing": { "title": "…", "body": "…", "priceText": "200" } }
```

**Every exchange the view shows needs one**, including exchanges with no case, where `photos` and
`messages` are simply absent.

### ⚠️ The displayed price is the listing's, and is deliberately not the amount that moves

The listing states what the item is worth — a retired set at £200. The exchange behind it is settled
in a fraction of a test token. **These are not reconciled, and a disagreement between them is not an
error.** The view renders `listing.priceText` with `listing.currency` and never reads a price from
the chain.

Everything derived from the price inherits that. When a proposal settles at 20% and the screen reads
*"£40 has come back to you"*, £40 is 20% of the listing's price. It is the **proportion** that is
real and settled on chain; the amount is the proportion expressed in the currency the item was
listed in.

Two consequences, both deliberate:

- A price is a **presentational fact about the listing**, never a claim about what a chain moved.
  Nothing in the view may present it as the latter.
- The view therefore needs no chain read to render any state, which is what lets it draw a complete
  screen from three files on disk.

## 7 · The screen

One purchase fills the screen as a single column of about 440px, centred. The remaining width
carries the wordmark and nothing else. The list of purchases is the same page with no purchase
selected, and **the wordmark links to it** — `href="/"`, which drops every query parameter and so
returns the list whichever purchase, and whichever photograph, the address named. That link is the
only navigation on the screen; there is no menu and no back button.

A row in that list draws the item, then **the parcel line** — where the parcel has got to — and then
the money line **only when it is not `held`**. "Your money is held" is true of every purchase that
has not finished, so drawing it on every row said the same sentence repeatedly and distinguished
nothing; where the parcel has got to is the one thing that differs between two open purchases. The
money line is still what separates the endings, since a finished purchase reads "It arrived" whether
the seller was paid, the money came back or they split it — so it is drawn beneath, and only then.

The tracking timeline appears **only** while the parcel is in transit or delivered-and-undisputed.
Once a dispute exists, the mediator's question or proposal takes that space. Both are never on
screen together — they answer different questions and the second is the one that matters once it
exists.

The mediator writes in paragraphs, and they are drawn as paragraphs: the reasoning is split on the
blank lines the text already carries, one element each. Set as the text of a single element every
break collapses into a space, and two thousand characters of argument arrive as one unbroken
block — the whole of it, correctly, and unreadable.

That reasoning is also **capped in height and scrolls in place**. Left to run, a four-paragraph
argument is well over a thousand pixels in a 440px column, which puts the amount it explains and the
two buttons that answer it on different screens. Nothing is hidden or summarised — rung 3 is a
proposal *with its reasoning shown*, and the whole of it is in the box.

Beneath whichever of those is drawn, and above the buttons, sits the **evidence block**: a count of
the photographs the buyer has already sent, and those photographs as thumbnails. It is present on
exactly the same window as the mediation block — a dispute exists and nothing has settled — and only
while the case holds at least one photograph. See §8.4.

⭐ **A thumbnail opens.** It is 84px square and it is the thing being argued about, so pressing one
lays that photograph over the page at full size. Dismissed by pressing anywhere on it or by Escape,
and the thumbnail that opened it takes focus back.

Three properties, and each answers a way this would otherwise be wrong:

- **A press, not a hover.** Hover has no answer on a touch screen, and a picture that covers the page
  because the pointer crossed it is a worse failure than one that needs a press. The thumbnails are
  reachable by keyboard and open on Enter or Space for the same reason.
- ⚠️ **While it is open, focus is held inside it.** It is marked modal, which asserts that everything
  behind it is inert, and Tab is where that assertion gets tested: the overlay holds nothing
  focusable, so an untrapped Tab would walk focus onto the buttons behind the scrim — controls the
  buyer cannot see, one of which settles a case. Focus is held rather than cycled, there being
  nothing to cycle between, and Escape remains the way out.
- ⚠️ **It is drawn outside the app root.** The screen redraws whenever the model changes — a
  photograph added, a round answered — and an overlay inside that root would vanish mid-look, on a
  tick the buyer did not cause and cannot see. It is attached to the document once and outlives every
  redraw.
- **It carries no copy of its own.** Every string on this screen resolves through `BUYER_STRINGS`
  ([§2](#2--the-vocabulary-rule)), and a close label invented in the page would be the single
  exception — one word in the one place the vocabulary test cannot reach it. The enlarged photograph
  carries the model's own `alt`, and the ways out are the ones a full-screen image already implies.

## 8 · Actions

| Method | Path | Calls | Guard |
|---|---|---|---|
| `GET` | `/api/purchases` | — | — |
| `GET` | `/api/purchases/:id` | — | — |
| `GET` | `/api/purchases/:id/photos/:position` | — | see §8.4 |
| `POST` | `/api/purchases/:id/complete` | `completion.mjs` | `BUYER_UI_ALLOW_CONFIRM` |
| `POST` | `/api/purchases/:id/raise` | `disputes.mjs` | — |
| `POST` | `/api/purchases/:id/photos` | `case-input.mjs` | see §8.3 |
| `POST` | `/api/purchases/:id/settle` | `resolution.mjs` | `BUYER_UI_ALLOW_SETTLE`, and see §9 |

The client polls `GET /api/purchases/:id` every 2 seconds. Polling rather than server-sent events
because it is a fraction of the code and the difference is unobservable over loopback.

### 8.1 · Completing is guarded, quietly

Completing pays the seller and cannot be undone — and, more practically, it **forfeits the ability
to dispute that exchange**. An accidental request while a machine is being set up would silently
destroy the exchange it lands on.

So the endpoint refuses unless `BUYER_UI_ALLOW_CONFIRM=true`, which is the same protection
`--execute` gives the equivalent scripts.

⚠️ **This guard is for the operator, never for the buyer.** It has no buyer-facing expression: no
confirmation dialogue, no second tap, no warning about irreversibility. Completing is an ordinary,
optional convenience and the interface must present it as one — see §5.

### 8.2 · Every request must come from this view's own page

Loopback keeps other machines out. It does not keep other *pages* out: this port is reachable from
every tab in the buyer's browser, and a `POST` with no body and no non-safelisted header triggers no
preflight, so CORS never intervenes — **CORS hides the response, not the request.** A server that
routed on the path alone would complete an exchange for any page that guessed a small integer at a
documented port, and completing is irreversible.

So, before any route runs:

- a request carrying an `Origin` header other than `http://127.0.0.1:<port>` or
  `http://localhost:<port>` is refused;
- a request whose `Host` is absent, or names anything but loopback, is refused — which also closes
  DNS rebinding, where a name the attacker controls resolves to `127.0.0.1` and the request arrives
  with their `Host` and no `Origin` at all.

Both answer `403` with an operator-facing body. The buyer's own page sends both headers correctly
and nothing else can. This is the check that establishes *who is calling*; §8.1's is an operator
arming the machine, and neither substitutes for the other.

### 8.3 · Adding a photograph rewrites one region of the case file

`fixtures/case/<exchangeId>.json` is committed, and it is the same file `scripts/mediate.mjs` reads
and `scripts/demo-reset.mjs` edits. So a photograph is attached by **replacing that one region of the
file's text**, never by re-serialising the record. A re-serialisation reformats the message thread and the listing
too — one action becomes a large diff on a file nothing else had touched — and it leaves the
photographs in a shape the reset can no longer restore byte for byte.

There is therefore **one writer and one format**: `src/case-input.mjs` makes the same edit
`scripts/demo-reset.mjs` does, through the one function in `src/case-fixture.mjs` that performs it.

That function moves a case between **rounds** — a round being the photographs a case is defined to
hold at that point in the mediation, named in source rather than read off the file. The request
body's `photo` id names the round a case reaches once that photograph has been added, and applying
the round sets the whole list of photographs at once.

⭐ **The `photo` id is optional, and its absence is the ordinary case.** The buyer presses one
button; which photograph that attaches is a lookup in the rounds table, taking the first one they
declare. An operator naming one selects another branch instead. The action is therefore **never
drawn disabled** — it was, unless a photograph appeared in the page's URL, which made a primary
control under a question asking for evidence unusable as drawn.

⚠️ **The buyer is never asked which one.** The photographs of the outer carton are one evidence
slot holding competing versions of the same fact, and which version is true is precisely what the
mediator reads the evidence to establish — the branches settle at different numbers. A control asking the
buyer to state whether their carton was crushed would be asking them to label their own evidence,
and to pick their own settlement while doing it. Three properties follow from that alone,
rather than from separate checks:

- the id is matched against the rounds held in source, so one that names no round is refused with
  `404`. No path is ever built from it and nothing is read off disk to decide, which is what closes
  traversal;
- applying the round a case already stands in reproduces its text exactly, so a repeat leaves the
  file untouched and still answers `200`;
- the photographs of the outer carton are **one evidence slot** and carry the same id, so the
  branch that arrives fills the slot rather than joining the one already in it. A case holding both
  an intact and a crushed outer carton would be evidence that contradicts itself.

The write is atomic — a private temporary file, then a rename — and the text is parsed before it is
written, so text that would not parse is never the text on disk.

⚠️ **A case input is never created here.** The photographs are one region of a file that also
carries the listing and the message thread, so a file written by this action alone would hold
photographs and neither of those — a purchase the view omits for having no listing (§6.1). An absent
case is refused rather than invented.

⚠️ **Nor is a case that stands at no round.** Applying a round sets the whole list of photographs at
once, so on a case holding evidence these rounds do not describe, this action would not add a
photograph — it would **replace that case's evidence with another case's**, silently, in the file
the mediator reads to decide what a buyer is owed. The precondition is therefore that the case
already stands at one of the rounds, and it is checked before anything is written:

- **any** round, not the one the move opens from, because the branches are alternatives within one
  slot and any of them takes any other — a case at a crushed branch takes the intact carton and
  becomes a case at the intact one;
- a case holding **no** photographs stands at no round, so it is refused too: the opening round *is*
  the first photograph, and no move reaches it. §6.1's "`photos` and `messages` are simply absent"
  describes exactly this shape, and a purchase in it has nothing here to add;
- the refusal is an **absence — `404`** — and not a `500`. There is no photograph here to attach;
  nothing is broken.

### 8.4 · What the buyer has sent is on the screen

**A press that changes nothing on screen has not confirmed anything.** Adding a photograph writes to
the case file, and for a time nothing in the model represented that file, so the one action a buyer
can complete unaided answered `200` and returned a model identical to the one already rendered. The
count had previously ridden along inside the mediation block, read by nothing, and was removed on the
rule that a field nothing reads is a claim nobody checks — the field was never the mistake, not
drawing it was.

The model therefore carries an `evidence` block of exactly three drawn fields:

| Field | What it is |
|---|---|
| `summary` | `1 photo added`, or `{count} photos added` — two strings in `BUYER_STRINGS`, never one with a count spliced into a noun |
| `alt` | one description for every thumbnail: *A photo you added*. What a photograph shows is something only the buyer knows |
| `photos` | one URL per photograph, addressing it **by its position in that case's own list** |

⚠️ **A position, never a name and never a path.** The model carries no filename, so the only thing a
caller controls is an integer. Four things stand between a request and a file read, in order: the
route matches digits only; the index must fall inside the list that case actually holds; the path it
resolves to must sit directly inside the photographs directory; and its extension must be on a
three-entry allow-list. The first three make traversal *unrepresentable* rather than rejected — there
is no caller-supplied string anywhere in the path that gets resolved — and the fourth is what stops a
hand-edited case file naming something that is not an image. Anything that fails answers `404`: a
photograph that is not there is an absence, not a broken component.

⚠️ **The URL names a position, and the file at a position changes** the moment a photograph is
added — so it must never be cached outright. The response carries an entity tag derived from the
file's own size and modification time and `cache-control: no-cache`, which gives the browser a `304`
while nothing has moved and a fresh body the instant something does. Without it the two-second poll
refetches every thumbnail; with a plain long cache, a press would leave the previous photograph on
screen.

## 9 · Settling

Accepting a proposal settles it on chain, and it is the only path in this system that returns money
to a buyer.

**Mutual resolution takes two agreements, and they are made by different parties at different
times.** The protocol requires the counterparty's signature over a `Resolution` struct, and requires
somebody other than that counterparty to submit it — which is what makes a settlement impossible on
one party's say-so. `src/resolution.mjs` holds both halves in one file, because they have to agree
on one number:

```js
signConsent({ coreSDK, exchangeId, buyerPercent })   // the counterparty's half
settle({ exchangeId, buyerPercent, exchanges, consents, authorisations, chain, execute })
```

The seller side is scripted, so **the seller signs and the buyer submits**.
`scripts/accept-resolution.mjs <exchangeId> --percent <n> --execute` signs and writes one consent;
nothing is submitted there, no gas is paid and nothing settles.

### 9.1 · A consent is not an authorisation

`src/authorisations.mjs` holds **standing** instruments: they name an action, the deadline logic
spends one unattended, and `PERMITTED_ACTIONS` is a closed list carrying nothing that disposes of
funds.

A consent is the opposite shape. It is bound to **one exchange and one exact percentage**, so it
cannot settle at any other split — there is no discretion in it to delegate. That narrowness is what
makes it safe to hold, and it is why it lives beside the proposal it agrees to, in `state/consents/`,
rather than in a store of standing authorisations.

It is still a bearer instrument: whoever holds it can settle at that split. So it is a secret, its
directory is fixed in source under the one path this repository ignores, and it is discarded the
moment it is spent. It cannot live on the exchange record — `src/exchanges.mjs` refuses to write a
signature — nor on the case record, which every mediation round rewrites whole.

### 9.2 · What settling refuses, and when

Every refusal is decided from the record **before anything is signed**: an exchange already
finalised, one with no dispute open, one that has been escalated, and a request naming no split at
all. Each is a revert the protocol would give anyway, named here so a person reads a sentence rather
than decodes one.

⭐ **The consent is checked against the split being settled, never read for it.** The route takes
the proposal's percentage from the same function that draws it on screen, so the buyer can only ever
settle at the number they were shown, and a consent signed for one proposal cannot settle another.

`buyerPercentBasisPoints` is the **buyer's** share, 0–10000. The one conversion lives in
`src/proposal.mjs`; nothing else works it out.

### 9.3 · The record follows the protocol, never the request

`settle()` writes only once the protocol has confirmed, and it writes **the split the protocol
recorded**, mapped through `outcomeFor()` — not the one that was asked for. A relayed
meta-transaction that reverted returns through the path a successful one returns through, so the
read-back is what proves anything happened.

A confirmation that times out leaves the record untouched **and the consent unspent**: the
transaction may yet have landed, the watchdog reconciles finalisation and outcome from chain truth
on its next sweep, and a consent discarded here could not be produced again without the
counterparty.

### 9.4 · Arming, and declining

The endpoint is armed by `BUYER_UI_ALLOW_SETTLE`, separately from `BUYER_UI_ALLOW_CONFIRM`. Both
move money irreversibly and they are different acts — completing pays the seller in full and
forfeits the dispute; settling splits a pot on a proposal both parties have seen — so an operator
may want one without the other. An armed server connects to the chain at startup and refuses to
start if it cannot, rather than failing on the first press. The guard in §8.2 is what establishes
*who is calling*; this one is an operator arming the machine, and neither substitutes for the other.

⚠️ **Declining is not a chain call, and is deliberately not a button.** A proposal is inert: it
settles if the buyer accepts it and otherwise does not. If they never accept, the resolution window
runs down and the watchdog escalates before it lapses, so the case reaches a person by the path that
already exists. Wiring the control to that path would escalate on a press meaning *"not this
number"* — skipping a rung of the ladder, irreversibly, and at the buyer's cost. The action is
therefore drawn disabled with a reason that states what happens instead, on the same principle as
the photograph control: an offer with no visible answer to it is worse than a disabled control that
explains itself.

**The interface must not pretend.** A settlement action that appears to succeed while nothing
settled is the one failure this whole system exists to prevent, so every refusal reaches the buyer
as *"that didn't go through"* and never as an ending.

## 10 · Replay

`scripts/replay.mjs` writes previously captured carrier events into a nominated store directory on a
timer, through the same store API the receiver uses. It exists so the view can be exercised, and a
delivery watched from dispatch to arrival, without waiting on a real parcel or a reachable network.

It is a separate process writing real captured events. **The view has no replay mode, no fixtures of
its own and no simulated state** — which is what keeps "the screen shows the stores" true when it is
being demonstrated rather than merely tested.

## 11 · Failure

| Situation | Behaviour |
|---|---|
| A chain call is in flight | The action renders as working. The store is unchanged until it confirms |
| A chain call fails or times out | A plain retry. **Never a success the store cannot support** |
| A chain call landed but its confirmation did not | The record is not advanced; the next read reconciles from chain truth, as elsewhere in this system |
| A store is unreadable | That purchase renders as unavailable. One bad record never blanks the list |
| No listing fixture | That purchase is omitted from the list and logged loudly |

The RPC endpoint is known to time out occasionally. Every action must therefore be safe to retry,
and no screen may derive a state from "the request I sent" rather than from what a store holds.

## 12 · Configuration

| Variable | Default | Notes |
|---|---|---|
| `BUYER_UI_PORT` | `3100` | Deliberately not `PORT` — the receiver owns that name |
| `EXCHANGES_DIR` | `state/exchanges` | Shared with the watchdog and the scripts |
| `EVENTS_DIR` | `fixtures/events` | Shared with the receiver |
| `BUYER_UI_ALLOW_CONFIRM` | `false` | §8.1 |
| `BUYER_UI_ALLOW_SETTLE` | `false` | §9.4 |

The case store is **not** configurable. `scripts/mediate.mjs` reads `state/cases` and the listing
fixtures at `fixtures/case/<exchangeId>.json` as fixed paths, and this view reads the same two. A
configurable copy that disagreed with the mediator's would be worse than a fixed one that cannot.

It binds to `127.0.0.1` only, and refuses to start bound to anything else. It reads chain
credentials, which is acceptable **only** because of that.

## 13 · Testing

| Unit | How |
|---|---|
| `buyer-view.mjs` | Table-driven over every state in §4. Pure, so this is the whole of the logic |
| The vocabulary rule | The existing walk of `BUYER_STRINGS`, extended to assert the view model emits no string absent from it |
| `moneyLine()` with a split | `outcome: "split"` with a percentage renders the amount, not "returned" |
| `buyer-server.mjs` | Request-level, as the receiver is tested: routes, guards, malformed input |
| `completion.mjs`, `resolution.mjs` | Called with a store and a stub, never the chain |
| A consent's signature | Signed and recovered with no chain: the address comes back, and 20% is the buyer's 2000 rather than the seller's 8000 |
| `settle()`'s refusals | Finalised, undisputed, escalated, no consent, and a consent at another split — each proven to refuse before the chain is reached |
| The photograph write | Against the committed case file's **text**: the opening round plus the photograph reproduces it byte for byte, and §8.3's properties still hold on what the route wrote |
| The screen itself | Reviewed by looking at it. No browser automation |
