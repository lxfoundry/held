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
`{ key, text, meta }`; `meta` is `null` exactly when `held` is — the money hasn't finalised, so there
is nothing yet to add. `{date}` in `paid_meta` is `finalisedAt`, formatted the same way §5's deadline
date is, so two dates on the same screen cannot disagree in style.

The two clean endings render green; **`split` renders amber**. A negotiated ending is neither of the
other two, and colouring it as one of them repeats the error §3.1 fixes.

`split` carries one supporting line beneath the item, and only `split` does — a third piece of copy,
separate from `meta` and drawn below the item row rather than inside the money block:

> You both agreed. No platform, no court.

It is the only ending both parties chose, and the only one worth saying anything about.

### Parcel

| Condition | Copy |
|---|---|
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

## 5 · The delivered state, and what the buyer owes

When a parcel is delivered, the screen offers two actions:

> **It arrived, all good** — completes the exchange, paying the seller now
> **Something's wrong** — raises a dispute

**These two have opposite relationships to the deadline, and the screen must say so.** Above the
buttons:

> The seller is paid on {date}. If something's wrong, say so before then.

Both clauses are true and each answers one button, in the order the buttons appear. `{date}` is
`redeemedAt + disputePeriodMs` off the record — never a written-in date.

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
| `src/buyer-view.mjs` | **Pure.** `viewFor({ record, tracking, caseRecord, listing, events, photos, allowConfirm })` → the whole view model. Every state in §4 is one case. | `buyer-state.mjs` only |
| `src/buyer-state.mjs` | All user-visible copy; the two lines | nothing |
| `src/buyer-server.mjs` | HTTP: static files, JSON reads, action writes | the stores, the action modules |
| `public/index.html`, `held.css`, `held.js` | One screen, rendered from the view model | nothing |
| `src/completion.mjs` | Completing an exchange, extracted from `scripts/confirm-receipt.mjs` | chain |
| `src/disputes.mjs` | Raising on the buyer's behalf — **already written; arrives with the buyer-initiated raise branch, which this spec assumes is merged** | chain |
| `src/resolution.mjs` | Settling a proposal — **the seam, see §9** | chain |
| `scripts/replay.mjs` | Writes captured carrier events into a store on a timer | the tracking store |

`src/buyer-view.mjs` performs **no I/O**. The server gathers, the view decides, the client draws.
That is what makes every state in §4 a table row in a test rather than a browser session.

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
carries the wordmark and nothing else. There is no navigation, no routing and no back button: the
list of purchases is the same page with no purchase selected.

The tracking timeline appears **only** while the parcel is in transit or delivered-and-undisputed.
Once a dispute exists, the mediator's question or proposal takes that space. Both are never on
screen together — they answer different questions and the second is the one that matters once it
exists.

## 8 · Actions

| Method | Path | Calls | Guard |
|---|---|---|---|
| `GET` | `/api/purchases` | — | — |
| `GET` | `/api/purchases/:id` | — | — |
| `POST` | `/api/purchases/:id/complete` | `completion.mjs` | `BUYER_UI_ALLOW_CONFIRM` |
| `POST` | `/api/purchases/:id/raise` | `disputes.mjs` | — |
| `POST` | `/api/purchases/:id/photos` | the case store | — |
| `POST` | `/api/purchases/:id/settle` | `resolution.mjs` | see §9 |

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

## 9 · The settlement seam

`resolveDispute` is not implemented anywhere in this repository. `src/resolution.mjs` exists to
define its interface now so that nothing else has to change when it arrives:

```js
export function settle({ exchangeId, buyerPercent })   // throws NotBuiltError
```

Until it is implemented the endpoint returns `501`, the client renders the settlement action
**disabled with a truthful label**, and the state does not advance. The view model still implements
the `returned` and `split` endings of §4 and they are still tested — the moment `settle()` works,
they render with no further change.

**The interface must not pretend.** A settlement action that appears to succeed while nothing
settled is the one failure this whole system exists to prevent.

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
| `completion.mjs`, `resolution.mjs` | Called with a store and a stub; `settle()` asserts it throws until implemented |
| The screen itself | Reviewed by looking at it. No browser automation |
