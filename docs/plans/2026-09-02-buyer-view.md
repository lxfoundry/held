# Buyer's View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the one surface a person looks at — a local, fixture-driven web view that renders an exchange's money line, parcel line, evidence prompt and proposal from the stores, and carries the buyer's three actions.

**Architecture:** A pure module (`src/buyer-view.mjs`) turns three store reads plus a listing into a complete view model; a zero-dependency HTTP server (`src/buyer-server.mjs`) gathers, serves and accepts actions; three static files draw it. Nothing in the view computes protocol state, and nothing simulates it — the stores are the only truth, and a separate replay process advances them.

**Tech Stack:** Node 22, ESM, `node:http`, `node --test`, `node:assert/strict`, ESLint 9. **No runtime dependencies are added by any task in this plan.**

**Spec:** [`docs/specs/buyer-view.md`](../specs/buyer-view.md) — read it before Task 1. The plan argues from it and does not restate its reasoning.

## Global Constraints

- **Node >= 22**, ESM (`.mjs`) throughout. Test with `npm test` (`node --test`), lint with `npm run lint`. Both must be clean at every commit.
- **No new dependencies.** Not for the server, not for the client, not for tests.
- **Every user-visible string lives in `BUYER_STRINGS` in `src/buyer-state.mjs`.** A string written into HTML, into `buyer-view.mjs`, or into the server is a defect, and Task 3 adds the test that catches it.
- **No protocol vocabulary reaches the screen:** not *voucher*, *rNFT*, *redeem*, *escrow*, *commit*, *wallet*, *on-chain*, *smart contract*, *exchange*, or *dispute resolver*.
- **The server binds `127.0.0.1` only** and refuses to start otherwise. It is never deployed.
- **Completing has no buyer-facing guard.** No confirmation dialogue, no second tap, no irreversibility warning. The only guard is the `BUYER_UI_ALLOW_CONFIRM` environment variable, which exists for the operator.
- **Assumes `src/disputes.mjs` is merged** (the buyer-initiated raise branch). Task 6 imports it.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/buyer-state.mjs` | *modify* — all copy, the two lines, the split ending | 1 |
| `scripts/watchdog.mjs` | *modify* — write `outcome: "split"` and `buyerPercent` | 2 |
| `src/buyer-view.mjs` | *create* — the pure view model. No I/O | 3 |
| `src/completion.mjs` | *create* — completing, extracted from the script | 4 |
| `scripts/confirm-receipt.mjs` | *modify* — becomes a thin caller | 4 |
| `src/resolution.mjs` | *create* — the settlement seam | 5 |
| `src/buyer-server.mjs` | *create* — routes, guards, gathering | 6 |
| `public/index.html`, `public/held.css`, `public/held.js` | *create* — the screen | 7 |
| `scripts/replay.mjs` | *create* — advances captured events on a timer | 8 |
| `fixtures/case/<id>.json` | *create* — a listing per demonstrated exchange | 8 |

## ⚠️ The price on screen is not the amount that moves

**Decided, and now spec §6.1.** A listing reads `"priceText": "200"` in pounds while the exchange it
describes settles in a fraction of a test token. They are **not** reconciled and the disagreement is
not an error.

What every task must therefore hold to:

- The view renders `listing.priceText` with `listing.currency`, and **reads no price from the chain
  in any state**.
- A refund amount is the listing's price times the proposal's percentage. The **proportion** is the
  settled fact; the amount is that proportion expressed in the listed currency.
- No test may assert that the two agree, and no code may reconcile them.

---

### Task 1: The money line gains `split`, and the copy the screen needs

**Files:**
- Modify: `src/buyer-state.mjs`
- Test: `test/buyer-state.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `BUYER_STRINGS` — gains `split`, `split_note`, `paid_meta`, `returned_meta`, `split_meta`, `deadline_notice`, `from_a_stranger`, `add_photo`, `accept_proposal`, `decline_proposal`, `arrived_all_good`, `something_wrong`, `settle_unavailable`
  - `fill(text, values)` → `string` — replaces `{name}` placeholders
  - `moneyLine(record, { priceText, currency } = {})` → `{ key, text }`
  - `parcelLine({ tracking, record })` → `{ key, text }` *(unchanged)*

- [ ] **Step 1: Write the failing tests**

Append to `test/buyer-state.test.mjs`:

```js
import { moneyLine, parcelLine, BUYER_STRINGS, fill } from "../src/buyer-state.mjs";

test("a split ending states the amount that came back, not that the money was returned", () => {
  const settled = record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 });
  const line = moneyLine(settled, { priceText: "200", currency: "£" });
  assert.equal(line.key, "split");
  assert.equal(line.text, "£40 has come back to you.");
});

test("0 and 100 percent remain the two clean endings", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "paid", buyerPercent: 0 })).key, "paid");
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "returned", buyerPercent: 100 })).key, "returned");
});

test("held survives, and is what an unfinalised exchange reads whatever else is set", () => {
  assert.equal(moneyLine(record({ outcome: null })).key, "held");
  assert.equal(moneyLine(record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" })).key, "held");
});

test("a split with no price says the fraction rather than inventing an amount", () => {
  const line = moneyLine(record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }));
  assert.equal(line.text, "20% has come back to you.");
});

test("fill replaces every placeholder and leaves nothing unresolved", () => {
  assert.equal(fill("paid on {date}", { date: "19 September" }), "paid on 19 September");
  assert.throws(() => fill("paid on {date}", {}), /date/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- --test-name-pattern="split|held survives|fill replaces"`
Expected: FAIL — `fill is not a function`, and `moneyLine` returns `paid` for a split.

- [ ] **Step 3: Implement**

In `src/buyer-state.mjs`, add to `BUYER_STRINGS`:

```js
  split: "{refund} has come back to you.",
  split_note: "You both agreed. No platform, no court.",

  paid_meta: "{price} · {date}",
  returned_meta: "{price} · back to you",
  split_meta: "The seller has been paid the rest.",

  // ⚠️ Both clauses are load-bearing and they answer different buttons, in the
  // order the buttons appear. Completing is optional — the period elapses and
  // the seller is paid regardless. Raising is not: nothing raises a dispute for
  // a buyer whose parcel arrived broken, because tracking proves arrival and
  // not condition. This line is the only warning they get.
  deadline_notice: "The seller is paid on {date}. If something's wrong, say so before then.",

  from_a_stranger: "{price} · from a stranger",
  arrived_all_good: "It arrived, all good",
  something_wrong: "Something's wrong",
  add_photo: "Add a photo",
  accept_proposal: "That works for me",
  decline_proposal: "No thanks",
  settle_unavailable: "Settling isn't available yet",
```

Then, replacing `moneyLine`:

```js
// A placeholder left unresolved would reach the screen as literal braces, so an
// absent value is an error rather than an empty string.
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (values[name] == null) throw new Error(`no value for {${name}}`);
    return String(values[name]);
  });
}

const line = (key, values = null) => ({
  key,
  text: values ? fill(BUYER_STRINGS[key], values) : BUYER_STRINGS[key],
});

export function moneyLine(record, { priceText = null, currency = "£" } = {}) {
  // An outcome is what happened to the money, and until the exchange finalises
  // nothing has. `held` is the line rendered in the absence of an outcome — it
  // is deliberately not one of `outcome`'s values.
  if (record.finalisedAt == null) return line("held");
  if (record.outcome !== "split") {
    return line(record.outcome === "returned" ? "returned" : "paid");
  }

  // Without a price there is no amount to state, and stating a fraction is
  // honest where inventing a number is not.
  const percent = record.buyerPercent;
  const refund =
    priceText == null
      ? `${percent}%`
      : `${currency}${formatAmount((Number(priceText) * percent) / 100)}`;
  return line("split", { refund });
}

// Whole pounds where the split is whole, two places where it is not. A refund
// of "£40.00" reads as a machine's output; "£40.5" reads as a bug.
function formatAmount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
```

Delete the old `const line = (key) => …` definition it replaces.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run lint`
Expected: PASS, no lint errors. The pre-existing vocabulary test must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/buyer-state.mjs test/buyer-state.test.mjs
git commit -m "Give the money line the ending mutual resolution actually produces"
```

---

### Task 2: The record carries the split

**Files:**
- Modify: `scripts/watchdog.mjs:122`
- Test: `test/watchdog.test.mjs`

**Interfaces:**
- Consumes: Task 1's `moneyLine`
- Produces: exchange records whose `outcome` is `"paid" | "returned" | "split"` and which carry `buyerPercent: number | null`

**Context:** `scripts/watchdog.mjs` currently reads
`outcome: settled(dispute.dispute.buyerPercent.isZero() ? "paid" : "returned")`. `buyerPercent`
arrives as an ethers `BigNumber` in basis points — 10000 is 100%. `assertShape()` in
`src/exchanges.mjs` validates only the millisecond fields, so no schema change is needed to store a
new number.

- [ ] **Step 1: Write the failing test**

Append to `test/watchdog.test.mjs`:

```js
import { outcomeFor } from "../scripts/watchdog.mjs";

test("basis points become the three endings, and a percentage the view can render", () => {
  assert.deepEqual(outcomeFor(0), { outcome: "paid", buyerPercent: 0 });
  assert.deepEqual(outcomeFor(10000), { outcome: "returned", buyerPercent: 100 });
  assert.deepEqual(outcomeFor(2000), { outcome: "split", buyerPercent: 20 });
  assert.deepEqual(outcomeFor(9999), { outcome: "split", buyerPercent: 99.99 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="basis points become"`
Expected: FAIL — `outcomeFor` is not exported.

- [ ] **Step 3: Implement**

In `scripts/watchdog.mjs`, above the sweep:

```js
// ⭐ Exported for the tests, and a pure function so they need no chain. The
// protocol speaks basis points; the buyer's view speaks a percentage and an
// amount, and only the two extremes are clean endings.
export function outcomeFor(basisPoints) {
  const buyerPercent = basisPoints / 100;
  if (buyerPercent === 0) return { outcome: "paid", buyerPercent };
  if (buyerPercent === 100) return { outcome: "returned", buyerPercent };
  return { outcome: "split", buyerPercent };
}
```

Replace the mapping at line 122:

```js
    ...(finalisedAt == null
      ? { outcome: null, buyerPercent: null }
      : outcomeFor(dispute.dispute.buyerPercent.toNumber())),
```

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/watchdog.mjs test/watchdog.test.mjs
git commit -m "Record which of the three endings a resolved dispute produced"
```

---

### Task 3: The view model

**Files:**
- Create: `src/buyer-view.mjs`
- Test: `test/buyer-view.test.mjs`

**Interfaces:**
- Consumes: `BUYER_STRINGS`, `fill`, `moneyLine`, `parcelLine` from `src/buyer-state.mjs`
- Produces:
  - `viewFor({ record, tracking, caseRecord, listing, events, photos, allowConfirm })` → view model below
  - `ACTIONS` — `{ COMPLETE: "complete", RAISE: "raise", PHOTO: "photo", SETTLE: "settle", DECLINE: "decline" }`

**The view model, in full:**

```js
{
  exchangeId: "241",
  item: { title: "Four retired sets", price: "£200 · from a stranger" },
  money: { key: "held", text: "…", tone: "held" | "paid" | "returned" | "split" },
  parcel: { key: "arrived", text: "It arrived" },
  note: "You both agreed. No platform, no court." | null,
  notice: "The seller is paid on 19 September. …" | null,
  timeline: [{ at: "2026-08-28T16:14:29+01:00", text: "Shipment Received" }] | null,
  mediation: null | { question: string | null, photos: number,
                      proposal: null | { refund: string, reasoning: string } },
  actions: [{ id: "complete", label: "It arrived, all good", primary: true,
              enabled: true, reason: null }],
  caseFile: false
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/buyer-view.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewFor, ACTIONS } from "../src/buyer-view.mjs";

const listing = { title: "Four retired sets", priceText: "200", currency: "£" };

const record = (over = {}) => ({
  exchangeId: "241",
  redeemedAt: Date.parse("2026-09-02T00:00:00Z"),
  disputePeriodMs: 17 * 86_400_000,
  resolutionPeriodMs: 7 * 86_400_000,
  disputeRaisedAt: null, disputeRaisedBy: null, disputeTimeoutAt: null,
  escalatedAt: null, finalisedAt: null, outcome: null, buyerPercent: null,
  ...over,
});

const tracking = (over = {}) => ({
  current: "in_transit", delivered: false, everAvailableForPickup: false,
  observed: ["in_transit"], eventCount: 1, lastEventAt: null, ...over,
});

const view = (over = {}) =>
  viewFor({ record: record(), tracking: tracking(), caseRecord: null, listing,
            events: [], photos: 0, allowConfirm: true, ...over });

test("in transit shows the timeline and offers nothing to do", () => {
  const v = view({ events: [{ occurrenceDatetime: "2026-09-02T09:00:00+01:00", status: "Shipment Received" }] });
  assert.equal(v.parcel.key, "on_its_way");
  assert.deepEqual(v.actions, []);
  assert.equal(v.notice, null);
});

test("delivered offers both actions and states the deadline once", () => {
  const v = view({ tracking: tracking({ current: "delivered", delivered: true }) });
  assert.deepEqual(v.actions.map((a) => a.id), [ACTIONS.COMPLETE, ACTIONS.RAISE]);
  assert.match(v.notice, /^The seller is paid on 19 September\. If something's wrong/);
});

test("without the operator's arming, completing is present but disabled", () => {
  const v = view({ tracking: tracking({ current: "delivered", delivered: true }), allowConfirm: false });
  const complete = v.actions.find((a) => a.id === ACTIONS.COMPLETE);
  assert.equal(complete.enabled, false);
  assert.equal(complete.reason, "BUYER_UI_ALLOW_CONFIRM is not set");
});

test("a raise the buyer made drops the timeline and opens the conversation", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [] },
  });
  assert.equal(v.parcel.key, "sorting_out");
  assert.equal(v.timeline, null);
  assert.equal(v.notice, null);
});

test("an evidence request becomes the question and the photo action", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ result: { status: "needs_evidence",
      requests: [{ to: "buyer", asks: "Can you photograph the outer shipping carton?" }] } }] },
  });
  assert.equal(v.mediation.question, "Can you photograph the outer shipping carton?");
  assert.equal(v.actions.find((a) => a.id === ACTIONS.PHOTO).enabled, true);
});

test("a proposal renders its amount and its reasoning, and settling is not yet available", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ result: { status: "proposal",
      buyerPercent: 20, reasoning: "The carton is intact." } }] },
  });
  assert.equal(v.mediation.proposal.refund, "£40");
  assert.equal(v.mediation.proposal.reasoning, "The carton is intact.");
  const settle = v.actions.find((a) => a.id === ACTIONS.SETTLE);
  assert.equal(settle.enabled, false);
  assert.equal(settle.label, "That works for me");
});

test("a split ending renders amber and carries its one supporting line", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }),
  });
  assert.equal(v.money.tone, "split");
  assert.equal(v.money.text, "£40 has come back to you.");
  assert.equal(v.note, "You both agreed. No platform, no court.");
  assert.deepEqual(v.actions, []);
});

test("the two clean endings carry no supporting line", () => {
  for (const outcome of ["paid", "returned"]) {
    const v = view({ record: record({ finalisedAt: 1, outcome, buyerPercent: outcome === "paid" ? 0 : 100 }) });
    assert.equal(v.note, null);
  }
});

test("escalation shows the file and stops offering anything", () => {
  const v = view({ record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", escalatedAt: 2 }) });
  assert.equal(v.parcel.key, "with_a_person");
  assert.equal(v.caseFile, true);
  assert.deepEqual(v.actions, []);
});

test("⭐ every string the view emits comes from BUYER_STRINGS", async () => {
  const { BUYER_STRINGS } = await import("../src/buyer-state.mjs");
  // Placeholders are filled by the time they reach here, so compare on the
  // literal segments a template is made of rather than on the template.
  const known = Object.values(BUYER_STRINGS).flatMap((s) => s.split(/\{\w+\}/).filter((p) => p.trim().length > 2));
  const v = view({ tracking: tracking({ current: "delivered", delivered: true }) });
  for (const text of [v.money.text, v.parcel.text, v.notice, ...v.actions.map((a) => a.label)]) {
    if (text == null) continue;
    assert.ok(known.some((k) => text.includes(k.trim())), `"${text}" is not built from BUYER_STRINGS`);
  }
});
```

- [ ] **Step 2: Run them and watch every one fail**

Run: `npm test -- test/buyer-view.test.mjs`
Expected: FAIL — `Cannot find module '../src/buyer-view.mjs'`.

- [ ] **Step 3: Implement**

Create `src/buyer-view.mjs`:

```js
// src/buyer-view.mjs
// One exchange, as the buyer reads it.
//
// ⭐ Pure. It performs no I/O and reads no clock — the server gathers, this
// decides, the client draws. That is what makes every state a table row in a
// test rather than a browser session.
//
// It emits no copy of its own. Every string is resolved through BUYER_STRINGS,
// which is what lets one test hold the vocabulary rule over the whole surface.

import { BUYER_STRINGS, fill, moneyLine, parcelLine } from "./buyer-state.mjs";

export const ACTIONS = Object.freeze({
  COMPLETE: "complete",
  RAISE: "raise",
  PHOTO: "photo",
  SETTLE: "settle",
  DECLINE: "decline",
});

export function viewFor({ record, tracking, caseRecord = null, listing, events = [], photos = 0, allowConfirm = false }) {
  const priceText = listing?.priceText ?? null;
  const currency = listing?.currency ?? "£";

  const money = moneyLine(record, { priceText, currency });
  const parcel = parcelLine({ tracking, record });

  const disputed = record.disputeRaisedAt != null;
  const settled = record.finalisedAt != null;
  const latest = lastRound(caseRecord);

  return {
    exchangeId: String(record.exchangeId),
    item: {
      title: listing?.title ?? "",
      price: priceText == null ? "" : fill(BUYER_STRINGS.from_a_stranger, { price: `${currency}${priceText}` }),
    },
    money: { ...money, tone: money.key },
    parcel,
    note: money.key === "split" ? BUYER_STRINGS.split_note : null,
    // The timeline answers "where is it"; once a dispute exists the question is
    // "what happens now", and the two are never on screen together.
    timeline: disputed || settled ? null : timelineFrom(events),
    notice: offersCompletion(tracking, record) ? deadlineNotice(record) : null,
    mediation: disputed && !settled ? mediationFrom(latest, priceText, currency, photos) : null,
    actions: actionsFor({ tracking, record, latest, allowConfirm }),
    caseFile: record.escalatedAt != null,
  };
}

function offersCompletion(tracking, record) {
  return Boolean(tracking?.delivered) && record.disputeRaisedAt == null && record.finalisedAt == null;
}

function deadlineNotice(record) {
  const at = new Date(record.redeemedAt + record.disputePeriodMs);
  const date = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return fill(BUYER_STRINGS.deadline_notice, { date });
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// ⚠️ occurrenceDatetime, never datetime: the two disagree by the UTC offset and
// the second is local time labelled as UTC.
function timelineFrom(events) {
  if (!events?.length) return null;
  return events
    .map((e) => ({ at: e.occurrenceDatetime ?? e.datetime ?? null, text: e.status ?? "" }))
    .filter((e) => e.at != null && e.text !== "")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function lastRound(caseRecord) {
  const rounds = caseRecord?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1]?.result ?? null : null;
}

function mediationFrom(latest, priceText, currency, photos) {
  if (!latest) return { question: null, photos, proposal: null };
  if (latest.status === "proposal") {
    return {
      question: null,
      photos,
      proposal: {
        refund: priceText == null
          ? `${latest.buyerPercent}%`
          : `${currency}${amount((Number(priceText) * latest.buyerPercent) / 100)}`,
        reasoning: latest.reasoning ?? "",
      },
    };
  }
  const ask = (latest.requests ?? []).find((r) => r.to === "buyer");
  return { question: ask?.asks ?? null, photos, proposal: null };
}

const amount = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

function actionsFor({ tracking, record, latest, allowConfirm }) {
  if (record.finalisedAt != null || record.escalatedAt != null) return [];

  if (offersCompletion(tracking, record)) {
    return [
      {
        id: ACTIONS.COMPLETE,
        label: BUYER_STRINGS.arrived_all_good,
        primary: true,
        enabled: allowConfirm,
        reason: allowConfirm ? null : "BUYER_UI_ALLOW_CONFIRM is not set",
      },
      { id: ACTIONS.RAISE, label: BUYER_STRINGS.something_wrong, primary: false, enabled: true, reason: null },
    ];
  }

  if (record.disputeRaisedAt == null || latest == null) return [];

  if (latest.status === "proposal") {
    return [
      // ⚠️ Disabled and truthful. resolveDispute is not implemented, and an
      // action that appears to succeed while nothing settled is the one failure
      // this system exists to prevent.
      { id: ACTIONS.SETTLE, label: BUYER_STRINGS.accept_proposal, primary: true,
        enabled: false, reason: BUYER_STRINGS.settle_unavailable },
      { id: ACTIONS.DECLINE, label: BUYER_STRINGS.decline_proposal, primary: false, enabled: true, reason: null },
    ];
  }

  const asked = (latest.requests ?? []).some((r) => r.to === "buyer");
  return asked
    ? [{ id: ACTIONS.PHOTO, label: BUYER_STRINGS.add_photo, primary: true, enabled: true, reason: null }]
    : [];
}
```

- [ ] **Step 4: Run and confirm every test passes**

Run: `npm test -- test/buyer-view.test.mjs && npm run lint`
Expected: PASS, no unused-variable warnings.

- [ ] **Step 5: Commit**

```bash
git add src/buyer-view.mjs test/buyer-view.test.mjs
git commit -m "Add the buyer's view model: every state, decided in one pure place"
```

---

### Task 4: Completing, extracted

**Files:**
- Create: `src/completion.mjs`
- Modify: `scripts/confirm-receipt.mjs`
- Test: `test/completion.test.mjs`

**Interfaces:**
- Consumes: `connect`, `waitForState` from `src/chain.mjs`; `createExchangeStore`; `createAuthorisationStore`
- Produces: `complete({ exchangeId, exchanges, authorisations, chain, execute })` → `{ planned, finalisedAt, paid }`

**Context:** This mirrors exactly what the buyer-initiated raise branch did for disputes — the logic
moves to `src/`, the script becomes a thin caller, and the `--execute` plan-and-stop behaviour is
preserved in the module rather than the script. Read `src/disputes.mjs` first and follow its shape:
same ordering, same discard-the-authorisation discipline, same read-back on an unconfirmed relay.

- [ ] **Step 1: Write the failing test**

Create `test/completion.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../src/completion.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";

const store = () => createExchangeStore(mkdtempSync(join(tmpdir(), "held-")));

const seeded = (exchanges, over = {}) => {
  exchanges.put({ exchangeId: "241", redeemedAt: 1, disputePeriodMs: 100, resolutionPeriodMs: 100,
    disputeRaisedAt: null, disputeRaisedBy: null, disputeTimeoutAt: null, escalatedAt: null,
    finalisedAt: null, outcome: null, buyerPercent: null, authorisations: [], ...over });
  return exchanges;
};

test("without execute nothing is signed and the record is untouched", async () => {
  const exchanges = seeded(store());
  const chain = { complete: () => assert.fail("must not reach the chain") };
  const result = await complete({ exchangeId: "241", exchanges, chain, execute: false });
  assert.equal(result.planned, true);
  assert.equal(exchanges.get("241").finalisedAt, null);
});

test("a finalised exchange refuses rather than paying twice", async () => {
  const exchanges = seeded(store(), { finalisedAt: 5, outcome: "paid", buyerPercent: 0 });
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, chain: {}, execute: true }),
    /already finalised/
  );
});

test("a disputed exchange refuses: completing would end a dispute in progress", async () => {
  const exchanges = seeded(store(), { disputeRaisedAt: 9, disputeRaisedBy: "buyer" });
  await assert.rejects(
    () => complete({ exchangeId: "241", exchanges, chain: {}, execute: true }),
    /dispute/
  );
});

test("executing records the outcome the protocol reported", async () => {
  const exchanges = seeded(store());
  const chain = { complete: async () => ({ finalisedAt: 1234, paid: "0.2" }) };
  const result = await complete({ exchangeId: "241", exchanges, chain, execute: true });
  assert.equal(result.finalisedAt, 1234);
  const record = exchanges.get("241");
  assert.equal(record.outcome, "paid");
  assert.equal(record.buyerPercent, 0);
  assert.deepEqual(record.authorisations, []);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- test/completion.test.mjs`
Expected: FAIL — `Cannot find module '../src/completion.mjs'`.

- [ ] **Step 3: Implement `src/completion.mjs`**

```js
// src/completion.mjs
// The buyer completes, and the seller is paid.
//
// ⭐ Optional by design. If nobody calls this the dispute period elapses and
// the seller is paid anyway — completing only makes it sooner. Nothing here may
// be presented to a buyer as an obligation.
//
// ⚠️ It is still irreversible, and it forfeits the right to dispute. It plans
// and stops unless `execute` is true, which is what `--execute` means everywhere
// else in this repository.

export class AlreadyFinalisedError extends Error {
  constructor(exchangeId) {
    super(`exchange ${exchangeId} is already finalised`);
    this.name = "AlreadyFinalisedError";
  }
}

export class DisputedError extends Error {
  constructor(exchangeId) {
    super(`exchange ${exchangeId} has a dispute open; completing it now would end that dispute`);
    this.name = "DisputedError";
  }
}

export async function complete({ exchangeId, exchanges, chain, execute = false }) {
  const record = exchanges.get(exchangeId);
  if (!record) throw new Error(`unknown exchange ${exchangeId}`);
  if (record.finalisedAt != null) throw new AlreadyFinalisedError(exchangeId);
  if (record.disputeRaisedAt != null) throw new DisputedError(exchangeId);

  if (!execute) return { planned: true, finalisedAt: null, paid: null };

  const { finalisedAt, paid } = await chain.complete({ exchangeId, record });

  // Completing pays the seller in full, so the outcome is not derived from a
  // dispute — there was none.
  exchanges.update(exchangeId, { finalisedAt, outcome: "paid", buyerPercent: 0, authorisations: [] });
  return { planned: false, finalisedAt, paid };
}
```

- [ ] **Step 4: Rewrite `scripts/confirm-receipt.mjs` to call it**

Keep the script's argument parsing, its `--execute` flag, its printing and its exit codes exactly as
they are. The chain work it already performs moves behind one object, and the record update leaves
the script entirely:

```js
// The chain half stays in the script, because it is the half that needs a
// signer, a provider and the ABI. The module keeps the rules.
const chain = {
  async complete({ exchangeId }) {
    const contract = new Contract(config.protocolDiamond, abis.IBosonExchangeHandlerABI, buyer.signer);
    const tx = await contract.completeExchange(exchangeId);
    await tx.wait();
    const finalised = await waitForState(
      () => contract.getExchange(exchangeId),
      { what: `exchange ${exchangeId} to finalise` }
    );
    return { finalisedAt: Number(finalised.exchange.finalizedDate) * MS, paid: priceText };
  },
};

const result = await complete({ exchangeId, exchanges, chain, execute });
if (result.planned) info("nothing was signed; re-run with --execute to complete this exchange");
```

Then run the script's own plan path against a real store to confirm the output is unchanged:

Run: `node scripts/confirm-receipt.mjs 241`
Expected: the same plan output as before the change, and nothing signed.

- [ ] **Step 5: Run the suite and commit**

```bash
npm test && npm run lint
git add src/completion.mjs scripts/confirm-receipt.mjs test/completion.test.mjs
git commit -m "Extract completing, so something other than a terminal can call it"
```

---

### Task 5: The settlement seam

**Files:**
- Create: `src/resolution.mjs`
- Test: `test/resolution.test.mjs`

**Interfaces:**
- Produces: `settle({ exchangeId, buyerPercent })` → never returns; `NotBuiltError`

- [ ] **Step 1: Write the failing test**

Create `test/resolution.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, NotBuiltError } from "../src/resolution.mjs";

test("settling is not implemented, and says so rather than appearing to work", async () => {
  await assert.rejects(() => settle({ exchangeId: "241", buyerPercent: 20 }), NotBuiltError);
});

test("the error names what is missing, so a caller can render something true", async () => {
  await assert.rejects(() => settle({ exchangeId: "241", buyerPercent: 20 }), /resolveDispute/);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- test/resolution.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/resolution.mjs
// Settling a proposal — the interface, ahead of the implementation.
//
// ⭐ `resolveDispute` is not implemented anywhere in this repository. This file
// exists so that the shape of the call is fixed now and nothing else has to
// change when it arrives: the view already renders both endings it produces,
// and the server already routes to it.
//
// ⚠️ It throws rather than resolving. An action that appears to succeed while
// nothing settled is the one failure this whole system exists to prevent, so
// the absence is loud at every layer above.
//
// Implementing it means: the counterparty signs an EIP-712 resolution, this
// side submits it. `test/authorisations.test.mjs` deliberately forbids
// automated code from holding a `resolveDispute` authorisation — that is a
// design decision, not an oversight, so a human signature is required here.

export class NotBuiltError extends Error {
  constructor() {
    super("resolveDispute is not implemented: a proposal cannot be settled yet");
    this.name = "NotBuiltError";
  }
}

// eslint-disable-next-line no-unused-vars
export async function settle({ exchangeId, buyerPercent }) {
  throw new NotBuiltError();
}
```

- [ ] **Step 4: Run and commit**

```bash
npm test && npm run lint
git add src/resolution.mjs test/resolution.test.mjs
git commit -m "Fix the shape of settling, so its absence is loud rather than silent"
```

---

### Task 6: The server

**Files:**
- Create: `src/buyer-server.mjs`
- Test: `test/buyer-server.test.mjs`
- Modify: `package.json` (add `"buyer": "node src/buyer-server.mjs"` to `scripts`)

**Interfaces:**
- Consumes: `viewFor`, `ACTIONS`; `createExchangeStore`, `createStore`, `createCaseStore`; `complete`; `raise` from `src/disputes.mjs`; `settle`; `loadEnv`
- Produces: `createApp({ exchanges, trackers, cases, listings, actions, allowConfirm })` → `(req, res) => void`, exported separately from the listening server so tests need no port

**Routes:** exactly as spec §8. `GET /` and `/held.css`, `/held.js` serve `public/`. Everything else is `404`.

- [ ] **Step 1: Write the failing tests**

Create `test/buyer-server.test.mjs`. Use `createApp` directly with fake stores — no sockets:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/buyer-server.mjs";

const listing = { title: "Four retired sets", priceText: "200", currency: "£" };

const record = { exchangeId: "241", redeemedAt: 0, disputePeriodMs: 17 * 86_400_000,
  resolutionPeriodMs: 7 * 86_400_000, disputeRaisedAt: null, disputeRaisedBy: null,
  disputeTimeoutAt: null, escalatedAt: null, finalisedAt: null, outcome: null,
  buyerPercent: null, authorisations: [] };

const app = (over = {}) => createApp({
  exchanges: { get: () => record, all: () => [record] },
  trackers: { read: () => ({ state: { current: "delivered", delivered: true }, events: [] }) },
  cases: { read: () => null },
  listings: { read: () => listing },
  actions: { complete: async () => ({}), raise: async () => ({}), settle: async () => ({}) },
  allowConfirm: false,
  ...over,
});

const call = (handler, method, url, body = null) =>
  new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) { if (chunk) chunks.push(chunk); resolve({ status: this.statusCode, body: chunks.join("") }); },
      write(chunk) { chunks.push(chunk); },
    };
    const req = { method, url, on(event, fn) { if (event === "end") fn(); if (event === "data" && body) fn(body); } };
    handler(req, res);
  });

test("a purchase renders as a view model, not as a record", async () => {
  const res = await call(app(), "GET", "/api/purchases/241");
  assert.equal(res.status, 200);
  const view = JSON.parse(res.body);
  assert.equal(view.parcel.text, "It arrived");
  assert.equal(view.money.text, "Your money is held.");
  assert.ok(!("authorisations" in view), "the view must never carry record internals");
});

test("an unknown purchase is 404, not an empty view", async () => {
  const res = await call(app({ exchanges: { get: () => null, all: () => [] } }), "GET", "/api/purchases/999");
  assert.equal(res.status, 404);
});

test("completing is refused when the operator has not armed it", async () => {
  const res = await call(app(), "POST", "/api/purchases/241/complete");
  assert.equal(res.status, 403);
  assert.match(res.body, /BUYER_UI_ALLOW_CONFIRM/);
});

test("completing is allowed when it is armed", async () => {
  let called = false;
  const res = await call(
    app({ allowConfirm: true, actions: { complete: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/complete"
  );
  assert.equal(res.status, 200);
  assert.equal(called, true);
});

test("settling reports 501 and never a success", async () => {
  const { NotBuiltError } = await import("../src/resolution.mjs");
  const res = await call(
    app({ actions: { settle: async () => { throw new NotBuiltError(); } } }),
    "POST", "/api/purchases/241/settle"
  );
  assert.equal(res.status, 501);
});

test("an unreadable record does not blank the list", async () => {
  const res = await call(
    app({ exchanges: { get: () => record, all: () => { throw new Error("corrupt"); } } }),
    "GET", "/api/purchases"
  );
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), []);
});

test("anything else is 404", async () => {
  assert.equal((await call(app(), "GET", "/api/nope")).status, 404);
  assert.equal((await call(app(), "POST", "/api/purchases/241/pay")).status, 404);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -- test/buyer-server.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/buyer-server.mjs`**

```js
// src/buyer-server.mjs
// Serves the buyer's view. It gathers, routes and guards; it decides nothing.
//
// ⭐ Unlike the receiver, this holds chain credentials — which is acceptable
// only because it binds to loopback and is never deployed. That ordering is
// load-bearing: if it ever listens on a public interface, this comment is wrong
// and so is the design.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { viewFor } from "./buyer-view.mjs";
import { NotBuiltError } from "./resolution.mjs";
import { loadEnv, ROOT } from "./env.mjs";

const HOST = "127.0.0.1";

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/held.css": ["held.css", "text/css; charset=utf-8"],
  "/held.js": ["held.js", "text/javascript; charset=utf-8"],
};

export function createApp({ exchanges, trackers, cases, listings, actions, allowConfirm }) {
  const send = (res, status, body, type = "application/json") => {
    res.statusCode = status;
    res.setHeader("content-type", type);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  function modelFor(id) {
    const record = exchanges.get(id);
    if (!record) return null;
    const input = listings.read(id);
    // Omitted rather than half-drawn: a purchase with no listing has no title
    // and no price, and a blank card on screen looks like a bug in the product
    // rather than a missing file.
    if (!input?.listing) {
      console.error(`no listing for ${id} — omitted from the view`);
      return null;
    }
    const snapshot = record.trackerId ? trackers.read(record.trackerId) : null;
    return viewFor({
      record,
      tracking: snapshot?.state ?? null,
      caseRecord: cases.read(id),
      listing: input.listing,
      events: snapshot?.events ?? [],
      photos: input.photos?.length ?? 0,
      allowConfirm,
    });
  }

  async function run(res, id, name) {
    if (name === "complete" && !allowConfirm) {
      return send(res, 403, { error: "BUYER_UI_ALLOW_CONFIRM is not set" });
    }
    try {
      await actions[name]({ exchangeId: id });
      return send(res, 200, modelFor(id) ?? {});
    } catch (err) {
      // ⚠️ 501, never 200. The client renders what it is told, and telling it
      // an unsettled proposal settled is the one failure to prevent.
      if (err instanceof NotBuiltError) return send(res, 501, { error: err.message });
      console.error(err);
      return send(res, 500, { error: err.message });
    }
  }

  // Every path wrapped, as in the receiver: a request that cannot be handled
  // fails that request alone.
  return function handle(req, res) {
    try {
      const path = new URL(req.url, "http://localhost").pathname;

      const asset = STATIC[path];
      if (req.method === "GET" && asset) {
        return send(res, 200, readFileSync(join(ROOT, "public", asset[0]), "utf8"), asset[1]);
      }

      if (req.method === "GET" && path === "/api/purchases") {
        let records = [];
        try {
          records = exchanges.all();
        } catch (err) {
          console.error(`could not list exchanges: ${err.message}`);
        }
        return send(res, 200, records.map((r) => modelFor(r.exchangeId)).filter(Boolean));
      }

      const one = /^\/api\/purchases\/(\d+)$/.exec(path);
      if (req.method === "GET" && one) {
        const model = modelFor(one[1]);
        return model ? send(res, 200, model) : send(res, 404, { error: "unknown purchase" });
      }

      const action = /^\/api\/purchases\/(\d+)\/(complete|raise|photos|settle)$/.exec(path);
      if (req.method === "POST" && action) return run(res, action[1], action[2]);

      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: "the request could not be handled" });
    }
  };
}
```

Then, below it, the entry point — started only when this module is run directly, so the tests above
need no port:

```js
const env = loadEnv({
  only: ["BUYER_UI_PORT", "BUYER_UI_ALLOW_CONFIRM", "EXCHANGES_DIR", "EVENTS_DIR"],
});

const port = Number(env.BUYER_UI_PORT ?? 3100);
```

Wire the four real stores (`createExchangeStore`, `createStore`, `createCaseStore`, and a listing
reader over `fixtures/case/<id>.json`), the three real actions (`complete` from
`src/completion.mjs`, `raise` from `src/disputes.mjs`, `settle` from `src/resolution.mjs`), and
`createServer(createApp({…})).listen(port, HOST)`.

⚠️ **`HOST` is a constant and must stay one.** There is no variable that makes this listen anywhere
else, because the credentials it holds are safe only while that is true.

- [ ] **Step 4: Run, lint, and start it once by hand**

```bash
npm test && npm run lint
npm run buyer
```
Expected: it prints the URL, `GET /api/purchases` answers, and nothing in the output is a wallet key.

- [ ] **Step 5: Commit**

```bash
git add src/buyer-server.mjs test/buyer-server.test.mjs package.json
git commit -m "Serve the buyer's view, and guard the one action that cannot be undone"
```

---

### Task 7: The screen

**Files:**
- Create: `public/index.html`, `public/held.css`, `public/held.js`

**Interfaces:**
- Consumes: `GET /api/purchases`, `GET /api/purchases/:id`, the four POSTs
- Produces: nothing another task depends on

**Design, fixed — do not reinterpret:**

- One column, **440px**, centred on `#FFFCF7`. The wordmark sits top-left in `#0F5132`; the rest of the width stays empty.
- **The money block is the largest type on the screen.** Held and the two clean endings render green (`#E7F3EC` ground, `#0F5132` ink; the endings invert to filled `#0F5132`). **`split` renders amber** — `#FDF3E3` ground, `#8A5A12` ink.
- Order down the page: wordmark · money block · item row · parcel status · then *either* the timeline *or* the mediation block, never both · then the notice · then actions.
- **The notice sits above the buttons**, not below and not per-button.
- Buttons: primary is a filled green pill; secondary is a white pill with a `#DCD3C4` border. A disabled action renders greyed with its `reason` beneath it in small type.
- System font stack. No web fonts, no icons, no images beyond the item thumbnail placeholder.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Held</title>
<link rel="stylesheet" href="/held.css">
<div class="mark">Held</div>
<main id="app"></main>
<script type="module" src="/held.js"></script>
```

No inline styles, no framework, no build step, nothing else.

- [ ] **Step 2: Write `public/held.css`**

```css
:root {
  --ground: #FFFCF7; --ink: #1A1815; --quiet: #7A7368; --edge: #EDE5D8;
  --green-ground: #E7F3EC; --green-ink: #0F5132; --green-quiet: #4A6B58;
  --amber-ground: #FDF3E3; --amber-ink: #8A5A12;
}
body {
  margin: 0; padding: 30px 40px; background: var(--ground); color: var(--ink);
  font: 16px/1.45 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}
.mark { font-size: 20px; font-weight: 700; color: var(--green-ink); margin-bottom: 26px; }
main { width: 440px; margin: 0 auto; }

/* The money block is the largest type on the screen, in every state. */
.money { background: var(--green-ground); border-radius: 20px; padding: 24px 26px; margin-bottom: 24px; }
.money b { display: block; font-size: 34px; font-weight: 650; line-height: 1.2;
           letter-spacing: -0.02em; color: var(--green-ink); }
.money span { display: block; font-size: 22px; color: var(--green-quiet); margin-top: 6px; }
.money.paid, .money.returned { background: var(--green-ink); }
.money.paid b, .money.returned b { color: #fff; }
.money.paid span, .money.returned span { color: #B7D6C4; }
/* A negotiated ending is neither clean ending, and must not be coloured as one. */
.money.split { background: var(--amber-ground); }
.money.split b, .money.split span { color: var(--amber-ink); }

.item { display: flex; gap: 18px; align-items: center; margin-bottom: 26px; }
.thumb { width: 76px; height: 76px; border-radius: 16px; background: #EFE7DA; flex: none; }
.status { font-size: 40px; font-weight: 680; letter-spacing: -0.025em; margin-bottom: 20px; }
.notice { font-size: 20px; line-height: 1.5; color: var(--quiet); margin-bottom: 20px; }
.timeline { list-style: none; margin: 0 0 24px; padding: 0; font-size: 20px; color: var(--quiet); }
.timeline li { padding: 8px 0; }
.box { background: #fff; border: 1px solid var(--edge); border-radius: 22px; padding: 26px; }
.amount { font-size: 46px; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px; }
.why { font-size: 20px; line-height: 1.5; color: var(--quiet); margin-bottom: 22px; }

button {
  display: block; width: 100%; border: 0; border-radius: 999px; padding: 16px;
  font: inherit; font-size: 21px; font-weight: 620; cursor: pointer;
  background: var(--green-ink); color: #fff; margin-bottom: 8px;
}
button.secondary { background: #fff; color: var(--ink); border: 1.5px solid #DCD3C4; }
button[disabled] { background: #E7E2D8; color: #9A938A; cursor: default; }
.reason { font-size: 16px; color: var(--quiet); text-align: center; margin: 0 0 12px; }
```

- [ ] **Step 3: Write `public/held.js`**

```js
// Draws the view model and nothing else. It computes no state, formats no
// copy and knows no protocol vocabulary — if a string is not in the response,
// it does not appear on screen.

const id = new URLSearchParams(location.search).get("purchase");

async function tick() {
  const res = await fetch(id ? `/api/purchases/${id}` : "/api/purchases");
  render(await res.json());
}

async function act(action) {
  // ⚠️ Optimistic rendering is forbidden. The button reports that it is
  // working; what replaces it comes from the next read of the store.
  setWorking(action);
  const res = await fetch(`/api/purchases/${id}/${action}`, { method: "POST" });
  if (!res.ok) return setFailed(action, await res.text());
  await tick();
}

setInterval(tick, 2000);
tick();
```

Fill in `render`, `setWorking` and `setFailed` against the view model in Task 3. `render` must treat
`timeline: null` and `mediation: null` as "do not draw that block" rather than as empty ones.

- [ ] **Step 4: Look at it**

```bash
BUYER_UI_ALLOW_CONFIRM=true npm run buyer
```

Open each state by pointing the server at a store seeded for it, and check by eye:
in transit · delivered with both buttons and the notice · watchdog raise · buyer raise with a
question · a proposal with its reasoning · a split ending in amber · escalated.
**No protocol vocabulary anywhere on screen, in any state.**

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "Draw the buyer's view"
```

---

### Task 8: Replay, listings, and the documentation

**Files:**
- Create: `scripts/replay.mjs`
- Create: `fixtures/case/<exchangeId>.json` for every exchange to be shown that has none
- Modify: `package.json` (`"replay": "node scripts/replay.mjs"`)
- Modify: `README.md`

**Interfaces:**
- Consumes: `createStore` from `src/store.mjs`
- Produces: `npm run replay -- <trackerId> --from <fixtureDir> --every <seconds>`

- [ ] **Step 1: Write `scripts/replay.mjs`**

It reads a captured snapshot's `events` array from a source directory, then writes them one at a
time into a target store through `ingest()` — the same call the receiver uses — pausing `--every`
seconds between them. It never fabricates an event and never writes a state directly.

```
node scripts/replay.mjs <trackerId> --from fixtures/events --into state/demo-events --every 3
```

Print each event as it lands, so the operator can see what the screen is about to show.

- [ ] **Step 2: Prove it against the real captured parcel**

```bash
node scripts/replay.mjs 076c427a-7418-4c36-a1b8-785ff18ece96 --from fixtures/events --into /tmp/replay --every 1
```
Expected: nine events land in order, the derived state ends `delivered`, and the source directory is
unchanged.

- [ ] **Step 3: Add a listing for every exchange the view will show**

```json
{
  "exchangeId": "239",
  "listing": { "title": "…", "body": "…", "priceText": "200", "currency": "£" }
}
```

`photos` and `messages` are omitted where no case exists. Confirm the view lists every intended
purchase and omits none silently.

- [ ] **Step 4: Document it in `README.md`**

A short section: what the view is, `npm run buyer`, `npm run replay`, the two environment variables,
and the one sentence that matters — **it binds to loopback, it is never deployed, and completing is
optional because the period elapses in the seller's favour regardless.**

- [ ] **Step 5: Full suite, then commit**

```bash
npm test && npm run lint
git add scripts/replay.mjs fixtures/case package.json README.md
git commit -m "Replay captured events into a store, so the view can be watched without a parcel"
```

---

## Verification before calling this done

- [ ] `npm test` — every test passes, and the count has grown by roughly 40
- [ ] `npm run lint` — clean
- [ ] Every state in spec §4 has been seen on screen, not merely tested
- [ ] No protocol vocabulary on any screen in any state
- [ ] `BUYER_UI_ALLOW_CONFIRM` unset ⇒ completing is visibly disabled and the endpoint is `403`
- [ ] Settling is visibly disabled and the endpoint is `501` — **it has never appeared to succeed**
- [ ] The server refuses to bind anything but `127.0.0.1`
- [ ] The split ending renders amber and states an amount, never "your money has been returned"
