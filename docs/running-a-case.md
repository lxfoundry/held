# Running a case end to end

From a fresh clone to a proposed split, on a real exchange, with real model calls.

Every step that has a genuine choice in it lists the options and what each one routes the case
towards. Take the ⭐ row if you have no reason to prefer another.

> ⭐ **For the case that is already committed, see [`running-the-demo.md`](./running-the-demo.md)**
> instead — four recorded states, no model calls and no network. This document is for making a new
> one, where what the model says has never been seen before.

> ⚠️ **Two of these steps spend something and cannot be undone** — seeding an exchange moves testnet
> funds, and settling finalises one permanently. Both plan and stop without `--execute`. Nothing else
> here costs anything except the model calls in step 6, which are marked.

---

## 0 · Clone and set up

```bash
git clone https://github.com/lxfoundry/held.git && cd held
npm ci
cp /path/to/your/.env .env
npm run chain-check     # reads only, needs no key — verifies the whole chain path
```

`state/` is created on demand by every store, so a fresh clone needs no directories made by hand.

⚠️ **`state/` is gitignored, so a fresh clone has no exchange records at all.** Every exchange that
existed elsewhere is invisible here, including any case with committed recordings. That is the right
starting point for this document — you are about to make a new one — but if you meant to carry an
existing case across, copy `state/` too.

---

## 1 · Choose the parcel

Tracker fixtures are committed and already scrubbed, so **nothing here needs the tracking provider**
and nothing consumes a shipment from its quota.

| | Option | Tracker | Routes the case towards |
|---|---|---|---|
| ⭐ | **A delivered parcel** | `076c427a-7418-4c36-a1b8-785ff18ece96` (`VU509120741GB`, 9 events) | **Arrived, but something is wrong.** Tracking cannot speak to condition, so the buyer has to say so — step 4A, then mediation |
| | **The other delivered parcel** | `8645991e-538a-40a2-8618-6f9d3777a6ae` (`MZ544750899GB`, 7 events) | Identical, but this is the tracker the committed case uses. Leave it free unless you want to replace that case |
| | **An in-transit parcel** | `96a4693b-33b5-45b3-9fff-32c596798c96` (`VU499656714GB`, 1 event) | **It never arrived.** The watchdog's branch — step 4B. No mediation: the evidence is unambiguous and the remedy is a full refund |
| | **A parcel of your own** | `npm run register -- <trackingNumber> gb-post`, then `npm run fetch -- <trackerId>` | Whatever the carrier actually did. ⚠️ Consumes one shipment from the tracking plan, and needs a genuinely posted parcel. Tracked services only — standard post produces no events at all |

---

## 2 · Create the exchange on chain

```bash
npm run seed -- --tracker 076c427a-7418-4c36-a1b8-785ff18ece96 --tracking-number VU509120741GB
```

Read the offer it prints, then add `--execute`.

> ⚠️ **`--execute` spends the buyer's money and cannot be undone.** One relayed transaction creates
> the offer, commits to it and redeems it; the commit moves the price into escrow. After that the
> money leaves only by confirmation, by a resolved dispute, or by the window lapsing — and a lapsed
> window pays the seller.

Note the exchange id it prints. It is `NEW` everywhere below.

| | Option | Effect |
|---|---|---|
| ⭐ | plain `--execute` | Creates, commits and redeems in one transaction |
| | `--adopt <exchangeId> --execute` | Sends nothing. Recovery only: an exchange is live on chain but has no local record — this reads it back, signs the authorisations and writes the record |

---

## 3 · Look at it

```bash
npm run buyer          # http://127.0.0.1:3100/?purchase=NEW
```

The parcel state, the money state, and whichever actions are available. Omit `?purchase=` to see
every purchase the view can render.

⚠️ **The purchase is omitted from the list, and logged loudly, until step 5 gives it a listing.**
That is deliberate: a purchase is never drawn half-built with a blank title and no price.

| | Option | Effect |
|---|---|---|
| ⭐ | nothing set | Nothing that moves money is armed. Every such action is drawn disabled with a reason |
| | `BUYER_UI_ALLOW_CONFIRM=true` | Arms "everything's fine" — confirming receipt **pays the seller immediately and finalises** |
| | `BUYER_UI_ALLOW_SETTLE=true` | Arms accepting a proposed split — see step 8 |

---

## 4 · Open the case

A case exists only once a dispute is open. Nothing mediates without one.

| | Option | Command | When it applies |
|---|---|---|---|
| ⭐ **A** | **The buyer says something is wrong** | `npm run raise -- NEW --execute` | The parcel arrived. **The only route for a delivered parcel** — the watchdog stands down on delivery, because condition is exactly what tracking cannot see |
| **B** | **The watchdog raises it** | `npm run watchdog` | The parcel has not arrived and the window is nearing expiry. Set `DISPUTE_RAISE_LEAD_MS` just under the offer's real dispute period to make it fire immediately. ⚠️ The lead is global — it sweeps *every* exchange in the store, so point `EXCHANGES_DIR` at an isolated directory |

Both spend the same pre-signed authorisation; whichever goes first, the other stands down.

---

## 5 · Give the case its evidence

The tracking comes from the carrier and the offer terms from the chain, so both are already there.
The listing, the message thread and the photographs came from people — nothing can derive them, and
a new exchange has none. `npm run mediate` reads that file unconditionally.

```bash
npm run new-case -- NEW --photos --messages --execute
```

| | Option | What the file holds | What the mediator gets to work from |
|---|---|---|---|
| ⭐ | `--photos --messages` | Listing, one photograph of the damaged item, one buyer message | A complaint, an image, and a gap where the parcel's outer packaging should be |
| | `--photos` only | Listing and the photograph | An image with nothing said about it |
| | `--messages` only | Listing and the complaint | An account with nothing shown |
| | neither | Listing alone | Almost nothing — enough to draw the purchase, not enough to mediate |
| | `--title "…" --body "…" --price N` | Your own listing copy | A different promise, so a different reading of what was owed |
| | copy the committed case | `cp fixtures/case/241.json fixtures/case/NEW.json` and change the `exchangeId` line | The full worked case, including the seller's replies |

Defaults: title `Offer <exchangeId>`, body the same as the title, price `200`. It never overwrites
an existing case.

⚠️ **What the model then says is genuinely new.** Recordings are keyed on the bundle hash, which
takes in the exchange id, the tracking and the timings — so nothing about your case replays, and the
question it asks and the number it lands on are its own.

---

## 6 · Run a round

```bash
npm run mediate -- NEW              # dry run — nothing recorded, so it stops. Free
npm run mediate -- NEW --execute    # a real request
```

| | Option | Cost | Effect |
|---|---|---|---|
| ⭐ | `--execute` | one request | The round runs and the answer is recorded under `fixtures/case/recordings/` |
| | no flag | nothing | Replays a recorded round; stops on an unrecorded one without calling anything |

Two settings change the shape of what comes back:

| Setting | Effect |
|---|---|
| `MEDIATOR_MAX_ROUNDS=2` | Round 2 is final, so it **must** propose. One question, then a number |
| `MEDIATOR_MAX_ROUNDS=3` | Round 2 may ask again. Three rounds before it is forced to decide |
| `MEDIATOR_MODEL` | Which model answers. Defaults to `claude-opus-5` |

⚠️ **Live rounds leave untracked files.** `fixtures/case/recordings/` is committed, not ignored, so
each new round drops a JSON there. Delete them or commit them deliberately.

---

## 7 · Answer the question

The mediator asks for one thing. How you answer is where the case branches, and it is the same
evidence slot every time — the photograph of the outer carton — so exactly one variable moves.

| | Option | How | What the evidence then shows |
|---|---|---|---|
| ⭐ | **The carton is intact** | Press **Add a photo** | An undamaged outer carton around a damaged item |
| | **The carton is crushed** | Open `?purchase=NEW&photo=carton-crushed`, then press it | An impact that reached the item through the packaging |
| | **Crushed, with the padding visible** | `?photo=carton-crushed-padded` | The same impact, and packing that was not inadequate |
| | **Answer nothing** | Run `mediate` again unchanged | The round is the same round asked twice — it is not numbered again. Let the deadline pass instead and the case closes on what it has |

Then run the next round:

```bash
npm run mediate -- NEW --execute
```

Under a cap of 2 this one must propose. Refresh the browser: the percentage, the refund in pounds
and the full reasoning are on the buyer's screen.

---

## 8 · Decide what happens to the money

| | Option | How | Effect |
|---|---|---|---|
| ⭐ | **Stop here** | — | The proposal and its reasoning stand on screen. Nothing has moved |
| | **Settle it** | `npm run accept -- NEW --percent <n> --execute` (the seller signs), then arm `BUYER_UI_ALLOW_SETTLE=true` and accept on the buyer's screen | ⚠️ **Irreversible.** The pot splits and the exchange finalises. It cannot be reset, re-run or reopened, and nothing in this repository can undo it |
| | **Don't accept, with the watchdog running** | `npm run watchdog` | A proposal is **inert**: it settles if the buyer accepts and otherwise does not. As the resolution window runs down the watchdog **escalates before it lapses**, so the case reaches a person by the path that already exists |
| | **Don't accept, with nothing watching** | — | ⚠️ The window lapses and **the seller is paid in full.** There is no passive refund anywhere in the protocol — which is the whole reason the watchdog is not optional |

⚠️ **There is no decline button, on purpose.** Wiring one would escalate on a press meaning *"not
this number"* — skipping a rung of the ladder, irreversibly, at the buyer's cost. The action is
drawn disabled with a reason that says what happens instead. Reasoning in
[`specs/buyer-view.md`](specs/buyer-view.md) §9.4.

Two things make an accidental settlement hard, and both are deliberate. The buyer can only settle at
**the number they were shown** — the same function that puts it on screen is the one that submits
it. And a settlement needs a counterparty signature that exists on disk, is bound to one exchange
and one exact percentage, and is spent once: **with no consent signed, an armed button still cannot
move anything.**

---

## Where it all lives

| | |
|---|---|
| `state/exchanges/NEW.json` | The chain's view of the exchange. Gitignored, and reconciled from chain truth |
| `state/cases/NEW.json` | The rounds so far. Delete it and the next round is round 1 again |
| `fixtures/case/NEW.json` | The case's own evidence, from step 5 |
| `fixtures/case/recordings/` | One file per answered round, keyed on the bundle hash |
| `fixtures/events/<trackerId>.json` | The carrier's events, scrubbed at capture time |

Longer form on the pieces: [`chain.md`](chain.md), [`receiver.md`](receiver.md),
[`specs/evidence-and-mediation.md`](specs/evidence-and-mediation.md),
[`specs/buyer-view.md`](specs/buyer-view.md).
