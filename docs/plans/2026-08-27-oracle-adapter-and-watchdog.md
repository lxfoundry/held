# Oracle adapter and watchdog — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Turn a real courier tracking stream into the protocol actions the frozen mapping
specifies — including the two the system takes unattended on the buyer's behalf — and produce one
exchange that runs end to end, from purchase to the seller being paid.

**Architecture:** A pure decision function separates *what the parcel did* from *what to do about
it*: it takes a tracking state, an exchange record and a clock, and returns one of exactly three
actions. Everything with side effects sits around it — a record store, a store of the buyer's
pre-signed authorisations, and a sweep that relays one of them when a deadline nears. The decision
function touches no network, no chain and no filesystem, so the whole mapping is tested without
either.

**Tech Stack:** Node 22 ESM, `node --test`, `@bosonprotocol/core-sdk` called directly through
`src/chain.mjs`, ethers v5. No new runtime dependencies.

**Specs:** [`../specs/tracking-state-mapping.md`](../specs/tracking-state-mapping.md) (primary — the
frozen mapping, the watchdog invariant and the thresholds) and
[`../specs/offer-model.md`](../specs/offer-model.md) (how the exchange and its authorisations come
into existence). Chain wiring, pinned versions and the traps already found are in
[`../chain.md`](../chain.md); the receiver is in [`../receiver.md`](../receiver.md).

## Global Constraints

Every task's requirements implicitly include these. Values are copied from the specs verbatim.

- **Node >= 22**, ESM (`.mjs`), tests under `test/` with `node --test`. No test framework.
- **No new dependencies.** `src/receiver.mjs` stays dependency-free and must never import
  `src/chain.mjs`, directly or transitively — nothing in this plan changes that.
- **Pinned:** `@bosonprotocol/core-sdk@1.48.1-alpha.2`, `ethers@5.7.2`. ethers v5 API
  (`utils.parseUnits`, `constants.AddressZero`, BigNumber `.toString()`), not v6.
- **Only two protocol writes are ever automatic:** `raiseDispute` and `escalateDispute`. Never
  `completeExchange`, `resolveDispute` or `retractDispute` from automated code.
- **The mapping keys on `statusMilestone`.** Reading `statusCode` in the adapter is a defect.
- **An exchange is resolved by `trackerId`, never by tracking number.** The same tracking number can
  exist under more than one tracker id, and one observed live carried `delivered` for a parcel still
  in transit. `delivered` enables the action that pays the seller.
- **Event times come from `occurrenceDatetime`.** The provider's `datetime` field repeats the local
  wall clock with a `Z` appended and parses an hour early under BST.
- **The watchdog is driven by a clock, never by an event.**
- **Sticky stand-down:** once `available_for_pickup` has ever been observed for an exchange, no
  dispute is raised for it automatically, whatever the milestone later becomes.
- **Both offer periods are >= 7 days** — the protocol floor, read live with `getMinDisputePeriod()`
  and `getMinResolutionPeriod()`. Offers below either are rejected at creation. Windows cannot be
  shortened for testing; **calibrate the lead, not the window.**
- **Each lead must be materially smaller than the period it guards.** Express as
  `max(fraction * period, floor)`. `DISPUTE_RAISE_LEAD` = 48h, `ESCALATION_LEAD` = 24h.
- **Pre-signed authorisations are bearer instruments.** They are secrets: never in a fixture, a log,
  a committed file or an error message, and discarded once spent.
- **No protocol vocabulary in anything the buyer sees** — no voucher, rNFT, redeem, commit,
  exchange, escrow, wallet or on-chain in a user-visible string, error messages included.
- **After any relayed transaction, read state back with `waitForState`, never directly.** The
  relayer resolves on mining and the shipped RPC is a pool, so an immediate read can be answered by
  a node one block behind and report a successful transaction as a failed one.
- **Scrub tracking data at capture time**, by pattern over the whole payload as well as by field
  name. The existing store already does this; nothing here may bypass it.

---

## File structure

| File | Responsibility |
|---|---|
| `src/adapter.mjs` | **New.** The decision: tracking state + exchange record + clock, to one of three actions. Pure — no I/O, no chain, no ambient time. The whole of the mapping's protocol-action column lives here and nowhere else |
| `src/buyer-state.mjs` | **New.** The mapping's buyer-facing column: the two lines a buyer reads. Pure, and the only place user-visible copy is written |
| `src/exchanges.mjs` | **New.** The exchange record store — `exchangeId` to `trackerId`, periods, timestamps. Holds no signature material, and refuses to |
| `src/authorisations.mjs` | **New.** The buyer's pre-signed meta-transactions. Secrets: restricted directory, mode 0600, discard on use |
| `src/watchdog.mjs` | **New.** The sweep: refresh from the protocol, decide, relay, discard. Every side effect is injected, so it is tested without a chain |
| `scripts/seed-exchange.mjs` | **New.** Seller signs the offer, buyer relays create-commit-redeem, `exchangeId` is read from the logs, the two authorisations are captured, the record is written |
| `scripts/confirm-receipt.mjs` | **New.** The buyer confirms; the seller is paid. Gasless, and deliberately a manual command — this action is never automatic |
| `scripts/watchdog.mjs` | **New.** Wires the real stores, chain reads and relayer into `src/watchdog.mjs`. `--once`, or a loop |
| `src/store.mjs` | Unchanged. `deriveState` already provides `delivered` and `everAvailableForPickup` as sticky, never-regressing flags. The adapter consumes those and never reads a raw event |
| `package.json` | Add `seed`, `confirm`, `watchdog` scripts |
| `.gitignore`, `.env.example` | Add `state/` and the new settings |

**Sequencing.** Tasks 1–4 are pure or local and need no chain. Task 5 creates a live exchange and
must run after 3 and 4, because it writes into both stores. Task 6 completes that exchange. Task 7
needs an exchange with authorisations captured, so it needs 5 — but its tests need nothing at all.

---

### Task 1: The decision function

**Files:**
- Create: `src/adapter.mjs`
- Test: `test/adapter.test.mjs`

**Interfaces:**
- Consumes: the `state` object produced by `deriveState` in `src/store.mjs` —
  `{ current, delivered, everAvailableForPickup, observed, eventCount, lastEventAt }`, or `null`
  when no tracker snapshot exists yet.
- Produces:
  - `ACTIONS` — `{ NONE: "none", RAISE: "raiseDispute", ESCALATE: "escalateDispute" }`
  - `RAISE_LEAD` / `ESCALATE_LEAD` — `{ fraction: number, floorMs: number }`
  - `leadMs(periodMs, lead) -> number`
  - `assertLeadSane(periodMs, ms, name) -> string[]` (warnings; throws on an impossible lead)
  - `decide({ tracking, record, now, leads }) -> { action, reason, dueAt }`, where `leads` is
    `{ raiseMs, escalateMs }` and `record` is the shape Task 3 defines.

- [ ] **Step 1: Write the failing test**

```js
// test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, decide, leadMs, assertLeadSane, RAISE_LEAD, ESCALATE_LEAD } from "../src/adapter.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 7 * DAY;
const leads = { raiseMs: 48 * HOUR, escalateMs: 24 * HOUR };

// Purchase at 0, so `now` reads as time since purchase.
const record = (over = {}) => ({
  exchangeId: "1",
  redeemedAt: 0,
  disputePeriodMs: PERIOD,
  resolutionPeriodMs: PERIOD,
  disputeRaisedAt: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  ...over,
});

const tracking = (over = {}) => ({
  current: "in_transit",
  delivered: false,
  everAvailableForPickup: false,
  observed: ["in_transit"],
  eventCount: 1,
  lastEventAt: null,
  ...over,
});

const HEALTHY = 3 * DAY;        // well inside a 7-day window
const NEARING = PERIOD - HOUR;  // inside the 48h lead

test("a parcel in transit inside its window needs nothing", () => {
  const { action } = decide({ tracking: tracking(), record: record(), now: HEALTHY, leads });
  assert.equal(action, ACTIONS.NONE);
});

test("a window nearing expiry with no delivery raises a dispute", () => {
  const { action } = decide({ tracking: tracking(), record: record(), now: NEARING, leads });
  assert.equal(action, ACTIONS.RAISE);
});

test("idle is not healthy: a tracker that has produced nothing still raises", () => {
  // The case the watchdog exists for — a deadline cannot be driven by the
  // arrival of a message that never comes.
  const { action } = decide({ tracking: null, record: record(), now: NEARING, leads });
  assert.equal(action, ACTIONS.RAISE);
});

test("an exception inside the window does not raise early", () => {
  // Raising forfeits the remaining window, and exceptions are frequently transient.
  const { action } = decide({
    tracking: tracking({ current: "exception", observed: ["in_transit", "exception"] }),
    record: record(),
    now: HEALTHY,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("an exception at the deadline raises, like any other non-delivery", () => {
  const { action } = decide({
    tracking: tracking({ current: "exception", observed: ["in_transit", "exception"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.RAISE);
});

test("a failed attempt still raises: nothing was made available to anyone", () => {
  const { action } = decide({
    tracking: tracking({ current: "failed_attempt", observed: ["in_transit", "failed_attempt"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.RAISE);
});

test("delivered takes no action, whatever the clock says", () => {
  // Tracking proves arrival, not condition. Confirming belongs to the buyer.
  const { action } = decide({
    tracking: tracking({ current: "delivered", delivered: true, observed: ["in_transit", "delivered"] }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a parcel made available for collection stands the watchdog down", () => {
  const { action, reason } = decide({
    tracking: tracking({
      current: "available_for_pickup",
      everAvailableForPickup: true,
      observed: ["in_transit", "available_for_pickup"],
    }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
  assert.match(reason, /performed/);
});

test("the stand-down is sticky: a later return to sender does not revive it", () => {
  // A naive reading of the current milestone would raise at exactly the moment
  // the buyer's own non-collection caused the return.
  const { action } = decide({
    tracking: tracking({
      current: "exception",
      everAvailableForPickup: true,
      observed: ["available_for_pickup", "exception"],
    }),
    record: record(),
    now: NEARING,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("an open dispute inside its resolution window needs nothing", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0 }),
    now: HEALTHY,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a resolution window nearing expiry escalates", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0 }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.ESCALATE);
});

test("the protocol's own timeout wins over the computed one", () => {
  const { action, dueAt } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0, disputeTimeoutAt: 30 * DAY }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
  assert.equal(dueAt, 30 * DAY);
});

test("an escalated dispute is left to the person deciding it", () => {
  const { action } = decide({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 0, escalatedAt: DAY }),
    now: PERIOD - HOUR,
    leads,
  });
  assert.equal(action, ACTIONS.NONE);
});

test("a finalised exchange is never acted on", () => {
  const { action } = decide({ tracking: null, record: record({ finalisedAt: DAY }), now: NEARING, leads });
  assert.equal(action, ACTIONS.NONE);
});

test("statusCode is not read: a hostile one changes nothing", () => {
  for (const statusCode of ["delivered", "transit_handover", "", null]) {
    const { action } = decide({
      tracking: tracking({ statusCode }),
      record: record(),
      now: NEARING,
      leads,
    });
    assert.equal(action, ACTIONS.RAISE);
  }
});

test("no milestone can produce an action outside the permitted three", () => {
  const milestones = [
    "pending", "info_received", "in_transit", "out_for_delivery", "failed_attempt",
    "available_for_pickup", "delivered", "exception", "something_new",
  ];
  const permitted = new Set(Object.values(ACTIONS));
  for (const current of milestones) {
    for (const now of [0, HEALTHY, NEARING, PERIOD * 2]) {
      const { action } = decide({ tracking: tracking({ current }), record: record(), now, leads });
      assert.ok(permitted.has(action), `${current} at ${now} produced ${action}`);
    }
  }
});

test("the lead is a fraction of the period with a floor under it", () => {
  assert.equal(leadMs(PERIOD, RAISE_LEAD), 48 * HOUR);
  assert.equal(leadMs(21 * DAY, RAISE_LEAD), 6 * DAY);
  assert.equal(leadMs(PERIOD, ESCALATE_LEAD), 24 * HOUR);
});

test("a lead at or beyond its period is impossible and throws", () => {
  assert.throws(() => assertLeadSane(PERIOD, PERIOD, "DISPUTE_RAISE_LEAD"), /must be shorter/);
});

test("a lead over half its period is allowed but warns", () => {
  const warnings = assertLeadSane(PERIOD, PERIOD - 60_000, "DISPUTE_RAISE_LEAD");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /demonstration/i);
  assert.equal(assertLeadSane(PERIOD, 48 * HOUR, "DISPUTE_RAISE_LEAD").length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/adapter.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/adapter.mjs
// Tracking state in, protocol action out.
//
// This is the whole of the mapping's protocol-action column, and it is
// deliberately pure: no chain, no filesystem, no ambient clock. Everything it
// needs arrives as an argument, so every row of the mapping is tested in
// milliseconds and none of it depends on a parcel or a network.
//
// It reads no raw event and no statusCode. What it consumes are the derived,
// sticky, never-regressing flags that src/store.mjs computes from the full
// event list — which is what makes out-of-order and duplicate pushes a
// non-issue here rather than a special case.

export const ACTIONS = {
  NONE: "none",
  RAISE: "raiseDispute",
  ESCALATE: "escalateDispute",
};

const HOUR = 3_600_000;

// Expressed as a fraction with a floor under it, so the relationship to the
// period holds if a period is ever configured longer than the protocol minimum.
// At the 7-day floor both resolve to the stated values: 48h and 24h.
export const RAISE_LEAD = { fraction: 2 / 7, floorMs: 48 * HOUR };
export const ESCALATE_LEAD = { fraction: 1 / 7, floorMs: 24 * HOUR };

export function leadMs(periodMs, { fraction, floorMs }) {
  return Math.max(Math.round(fraction * periodMs), floorMs);
}

// A lead approaching its period raises before a parcel could plausibly arrive,
// or escalates the instant a dispute is raised — so the parties never get the
// chance to settle between themselves and the cheapest path stops existing.
// A lead at or beyond the period is not a configuration, it is a mistake.
export function assertLeadSane(periodMs, ms, name) {
  if (!(ms > 0)) throw new Error(`${name} must be a positive number of milliseconds`);
  if (ms >= periodMs) {
    throw new Error(`${name} is ${ms}ms and must be shorter than the ${periodMs}ms period it guards`);
  }
  if (ms > periodMs / 2) {
    return [
      `${name} is ${ms}ms against a ${periodMs}ms period. That is a demonstration ` +
        "configuration and must not ship: say so wherever it is shown.",
    ];
  }
  return [];
}

export function decide({ tracking, record, now, leads }) {
  // ⚠️ Compared against null, not truthiness. These are timestamps, and a
  // timestamp of 0 is a real one — treating it as absent would silently ignore
  // a dispute in exactly the tests that pin this behaviour down.
  if (record.finalisedAt != null) {
    return { action: ACTIONS.NONE, reason: "the exchange is finalised", dueAt: null };
  }
  if (record.escalatedAt != null) {
    return { action: ACTIONS.NONE, reason: "already escalated; a person is deciding it", dueAt: null };
  }

  // One level down, the same asymmetry: a resolution period that lapses pays
  // the seller. Prefer the protocol's own timeout to anything computed here.
  if (record.disputeRaisedAt != null) {
    const dueAt = record.disputeTimeoutAt ?? record.disputeRaisedAt + record.resolutionPeriodMs;
    if (now >= dueAt - leads.escalateMs) {
      return { action: ACTIONS.ESCALATE, reason: "the resolution window is nearing expiry", dueAt };
    }
    return { action: ACTIONS.NONE, reason: "a dispute is open and its window is healthy", dueAt };
  }

  const dueAt = record.redeemedAt + record.disputePeriodMs;

  // Tracking proves arrival, not condition — it cannot see a crushed box. So a
  // delivery scan only enables confirmation, and confirmation is the buyer's.
  if (tracking?.delivered) {
    return { action: ACTIONS.NONE, reason: "delivered; confirming belongs to the buyer", dueAt };
  }

  // The seller sent it, it arrived, and it was made available. Raising here
  // would accuse a seller who performed, on evidence that shows they did — and
  // would make non-collection a free option for the buyer. Sticky, so a later
  // return to sender does not revive it.
  if (tracking?.everAvailableForPickup) {
    return { action: ACTIONS.NONE, reason: "made available for collection; the seller performed", dueAt };
  }

  // No tracking at all falls through to the same branch as any other
  // non-delivery, and that is the point: a parcel that stops producing events
  // entirely is exactly what this exists for.
  if (now >= dueAt - leads.raiseMs) {
    return { action: ACTIONS.RAISE, reason: "the window is nearing expiry and nothing was delivered", dueAt };
  }
  return { action: ACTIONS.NONE, reason: "the window is healthy", dueAt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — every test in `test/adapter.test.mjs`

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/adapter.mjs test/adapter.test.mjs
git commit -m "map tracking state to protocol actions"
```

---

### Task 2: The buyer-facing state

**Files:**
- Create: `src/buyer-state.mjs`
- Test: `test/buyer-state.test.mjs`

**Interfaces:**
- Consumes: the same `tracking` state and `record` shapes as Task 1.
- Produces:
  - `moneyLine(record) -> { key, text }`, key one of `held` | `paid` | `returned`
  - `parcelLine({ tracking, record }) -> { key, text }`
  - `BUYER_STRINGS` — every user-visible string in one frozen object, so one test can walk the
    whole surface.

- [ ] **Step 1: Write the failing test**

```js
// test/buyer-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { moneyLine, parcelLine, BUYER_STRINGS } from "../src/buyer-state.mjs";

const record = (over = {}) => ({
  exchangeId: "1",
  redeemedAt: 0,
  disputePeriodMs: 7 * 86_400_000,
  resolutionPeriodMs: 7 * 86_400_000,
  disputeRaisedAt: null,
  disputeRaisedBy: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  outcome: null,
  ...over,
});

const tracking = (over = {}) => ({
  current: "in_transit",
  delivered: false,
  everAvailableForPickup: false,
  observed: ["in_transit"],
  eventCount: 1,
  lastEventAt: null,
  ...over,
});

test("money is held until the exchange finalises", () => {
  assert.equal(moneyLine(record()).key, "held");
});

test("a completed exchange says the seller has been paid", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "paid" })).key, "paid");
});

test("a refunded exchange says the money has been returned", () => {
  assert.equal(moneyLine(record({ finalisedAt: 1, outcome: "returned" })).key, "returned");
});

test("a parcel with no events yet is on its way", () => {
  assert.equal(parcelLine({ tracking: null, record: record() }).key, "on_its_way");
  assert.equal(parcelLine({ tracking: tracking({ current: "pending" }), record: record() }).key, "on_its_way");
});

test("a parcel waiting at a collection point asks the buyer to act", () => {
  const line = parcelLine({
    tracking: tracking({ current: "available_for_pickup", everAvailableForPickup: true }),
    record: record(),
  });
  assert.equal(line.key, "waiting_for_collection");
});

test("a failed attempt asks the buyer to act too", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "failed_attempt" }), record: record() }).key,
    "needs_you"
  );
});

test("an exception says we are looking into it, and promises nothing", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "exception" }), record: record() }).key,
    "looking_into_it"
  );
});

test("a delivered parcel says it arrived", () => {
  assert.equal(
    parcelLine({ tracking: tracking({ current: "delivered", delivered: true }), record: record() }).key,
    "arrived"
  );
});

test("a dispute raised for the buyer says so plainly", () => {
  const line = parcelLine({
    tracking: tracking(),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "watchdog" }),
  });
  assert.equal(line.key, "raised_for_you");
  assert.match(line.text, /raised this for you/);
});

test("a dispute the buyer raised themselves reads differently", () => {
  const line = parcelLine({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
  });
  assert.equal(line.key, "sorting_out");
});

test("an escalated dispute says a person is looking at it", () => {
  const line = parcelLine({
    tracking: tracking({ delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", escalatedAt: 2 }),
  });
  assert.equal(line.key, "with_a_person");
});

test("no user-visible string contains protocol vocabulary", () => {
  // The atomic flow exists precisely so none of these words ever need to appear.
  const forbidden =
    /\b(voucher|rNFT|redeem\w*|escrow\w*|commit\w*|exchange\w*|dispute\w*|offer\w*|wallet|on-chain|onchain|blockchain|smart contract|token|gas|transaction|protocol)\b/i;
  const found = JSON.stringify(BUYER_STRINGS).match(forbidden);
  assert.equal(found, null, `forbidden vocabulary: ${found}`);
});

test("every string is present and none is empty", () => {
  for (const [key, text] of Object.entries(BUYER_STRINGS)) {
    assert.ok(typeof text === "string" && text.length > 0, `${key} is empty`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/buyer-state.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/buyer-state.mjs
// What the buyer reads.
//
// Two independent lines: what happened to their money, and what happened to
// their parcel. They change for different reasons and at different moments, so
// they are computed separately and never interleaved.
//
// This is the only module holding user-visible copy, which is what lets a
// single test assert the vocabulary rule over the entire surface.

export const BUYER_STRINGS = {
  held: "Your money is held. The seller can't touch it.",
  paid: "Seller has been paid.",
  returned: "Your money has been returned.",

  on_its_way: "On its way",
  needs_you: "The courier couldn't deliver it — it needs you",
  waiting_for_collection: "It's waiting for you to collect",
  looking_into_it: "We're looking into it",
  arrived: "It arrived",
  raised_for_you: "It hasn't arrived. We've raised this for you.",
  sorting_out: "Let's sort this out",
  with_a_person: "A person is now looking at it",
};

const line = (key) => ({ key, text: BUYER_STRINGS[key] });

export function moneyLine(record) {
  if (record.finalisedAt == null) return line("held");
  return line(record.outcome === "returned" ? "returned" : "paid");
}

export function parcelLine({ tracking, record }) {
  // Compared against null for the same reason as the decision function: these
  // are timestamps and zero is a real one.
  if (record.escalatedAt != null) return line("with_a_person");
  if (record.disputeRaisedAt != null) {
    return line(record.disputeRaisedBy === "watchdog" ? "raised_for_you" : "sorting_out");
  }

  const milestone = tracking?.current ?? "pending";
  if (tracking?.delivered) return line("arrived");

  // Both of these need the buyer to do something with the courier, and telling
  // them prominently is what earns the right to stand down rather than raise.
  if (tracking?.everAvailableForPickup || milestone === "available_for_pickup") {
    return line("waiting_for_collection");
  }
  if (milestone === "failed_attempt") return line("needs_you");

  if (milestone === "exception") return line("looking_into_it");
  return line("on_its_way");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/buyer-state.mjs test/buyer-state.test.mjs
git commit -m "write the two lines the buyer reads"
```

---

### Task 3: The exchange record store

**Files:**
- Create: `src/exchanges.mjs`
- Test: `test/exchanges.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createExchangeStore(dir) -> { put, get, update, all, byTracker, dir }`
  - `class SecretLeakError extends Error`
  - The **record shape**, which Tasks 1, 2, 5, 6 and 7 all depend on:

```js
{
  exchangeId: "42",           // string, the protocol's id
  offerId: "120",             // string
  configId: "testing-84532-0",
  trackerId: "8645991e-…",    // null until a parcel is attached
  trackingNumber: "MZ544750899GB",
  redeemedAt: 1756300000000,  // ms — voucher.redeemedDate * 1000, the protocol's own number
  disputePeriodMs: 604800000,
  resolutionPeriodMs: 604800000,
  disputeRaisedAt: null,      // ms
  disputeRaisedBy: null,      // "watchdog" | "buyer" | "seller"
  disputeTimeoutAt: null,     // ms — the protocol's own timeout, once a dispute exists
  escalatedAt: null,          // ms
  finalisedAt: null,          // ms
  outcome: null,              // "paid" | "returned"
  authorisations: ["raiseDispute", "escalateDispute"],  // names only, never signatures
}
```

- [ ] **Step 1: Write the failing test**

```js
// test/exchanges.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExchangeStore, SecretLeakError } from "../src/exchanges.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "held-exchanges-"));

const record = (over = {}) => ({
  exchangeId: "42",
  offerId: "120",
  configId: "testing-84532-0",
  trackerId: "8645991e-538a-40a2-8618-6f9d3777a6ae",
  trackingNumber: "MZ544750899GB",
  redeemedAt: 1_756_300_000_000,
  disputePeriodMs: 604_800_000,
  resolutionPeriodMs: 604_800_000,
  disputeRaisedAt: null,
  disputeRaisedBy: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  outcome: null,
  authorisations: ["raiseDispute", "escalateDispute"],
  ...over,
});

test("a record round-trips", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  assert.equal(store.get("42").trackingNumber, "MZ544750899GB");
});

test("update merges and leaves everything else alone", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  const updated = store.update("42", { disputeRaisedAt: 5, disputeRaisedBy: "watchdog" });
  assert.equal(updated.disputeRaisedAt, 5);
  assert.equal(updated.offerId, "120");
  assert.equal(store.get("42").disputeRaisedBy, "watchdog");
});

test("update on an unknown id throws rather than creating a half record", () => {
  const store = createExchangeStore(freshDir());
  assert.throws(() => store.update("99", { finalisedAt: 1 }), /unknown/);
});

test("get on an unknown id is null, not an error", () => {
  assert.equal(createExchangeStore(freshDir()).get("99"), null);
});

test("all returns every record", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  store.put(record({ exchangeId: "43" }));
  assert.deepEqual(store.all().map((r) => r.exchangeId).sort(), ["42", "43"]);
});

test("byTracker finds the exchange a parcel belongs to", () => {
  const store = createExchangeStore(freshDir());
  store.put(record());
  assert.equal(store.byTracker("8645991e-538a-40a2-8618-6f9d3777a6ae").exchangeId, "42");
  assert.equal(store.byTracker("nothing"), null);
});

test("a record carrying signature material is refused", () => {
  // These files are ordinary state and anything may read them. A bearer
  // instrument must not be able to arrive here by accident.
  const store = createExchangeStore(freshDir());
  for (const leak of [
    { signature: "0xdead" },
    { functionSignature: "0xdead" },
    { r: "0x1" },
    { sigV: 27 },
    { privateKey: "0x1" },
    { nested: { mnemonic: "one two three" } },
  ]) {
    assert.throws(() => store.put(record(leak)), SecretLeakError);
  }
});

test("the refusal happens before anything is written", () => {
  const store = createExchangeStore(freshDir());
  assert.throws(() => store.put(record({ signature: "0xdead" })), SecretLeakError);
  assert.equal(store.get("42"), null);
});

test("authorisations are recorded by name only", () => {
  const dir = freshDir();
  const store = createExchangeStore(dir);
  store.put(record());
  const raw = readFileSync(join(dir, "42.json"), "utf8");
  assert.match(raw, /raiseDispute/);
  assert.equal(/0x[0-9a-f]{64}/i.test(raw), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/exchanges.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/exchanges.mjs
// What the system knows about an exchange, as a file per exchange.
//
// Deliberately separate from the pre-signed authorisations in
// src/authorisations.mjs, and it enforces that separation rather than assuming
// it: a record is ordinary state anything may read, an authorisation is a
// bearer instrument. Keeping both in one place would apply the weaker of the
// two rules to both.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every name a signature or a key could plausibly arrive under, matched at any
// depth — because a whole signed meta-transaction is exactly the kind of object
// that gets spread into a record in a hurry.
const SECRET_KEYS = new Set([
  "signature", "functionsignature", "sigr", "sigs", "sigv",
  "r", "s", "v", "privatekey", "mnemonic", "secret",
]);

export class SecretLeakError extends Error {
  constructor(path) {
    super(`refusing to write a record containing "${path}": that belongs in the authorisation store`);
    this.name = "SecretLeakError";
  }
}

function assertNoSecrets(value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase())) throw new SecretLeakError(here);
    assertNoSecrets(child, here);
  }
}

export function createExchangeStore(dir) {
  mkdirSync(dir, { recursive: true });

  const pathFor = (exchangeId) => join(dir, `${String(exchangeId)}.json`);

  function get(exchangeId) {
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function put(record) {
    assertNoSecrets(record);
    const target = pathFor(record.exchangeId);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, target);
    return record;
  }

  function update(exchangeId, patch) {
    const existing = get(exchangeId);
    if (!existing) throw new Error(`unknown exchange ${exchangeId}`);
    return put({ ...existing, ...patch });
  }

  function all() {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => get(f.slice(0, -".json".length)))
      .filter(Boolean);
  }

  function byTracker(trackerId) {
    return all().find((r) => r.trackerId === trackerId) ?? null;
  }

  return { put, get, update, all, byTracker, dir };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Ignore the state directory, lint and commit**

```bash
printf '\n# Live state: exchange records and the pre-signed authorisations.\nstate/\n' >> .gitignore
npm run lint
git add src/exchanges.mjs test/exchanges.test.mjs .gitignore
git commit -m "record what the system knows about an exchange"
```

---

### Task 4: The authorisation store

**Files:**
- Create: `src/authorisations.mjs`
- Test: `test/authorisations.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createAuthorisationStore(dir) -> { save, load, has, discard, list, dir }`
  - `class UnsafeAuthorisationDirError extends Error`
  - `PERMITTED_ACTIONS` — `["raiseDispute", "escalateDispute"]`
  - Stored shape: `{ exchangeId, action, functionName, functionSignature, r, s, v, nonce, createdAt }`.
    `save(exchangeId, action, signed)` takes the object `signMetaTxRaiseDispute` returns, plus the
    nonce it was signed with.

- [ ] **Step 1: Write the failing test**

```js
// test/authorisations.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import {
  createAuthorisationStore,
  UnsafeAuthorisationDirError,
  PERMITTED_ACTIONS,
} from "../src/authorisations.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "held-auth-"));

const signed = {
  functionName: "raiseDispute(uint256)",
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
};

test("only the two permitted actions can be stored", () => {
  const store = createAuthorisationStore(freshDir());
  assert.deepEqual(PERMITTED_ACTIONS, ["raiseDispute", "escalateDispute"]);
  for (const forbidden of ["completeExchange", "resolveDispute", "retractDispute"]) {
    assert.throws(() => store.save("42", forbidden, signed, 1), /not an action this system may take/);
  }
});

test("an authorisation round-trips and carries its nonce", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1_756_300_000_000);
  const loaded = store.load("42", "raiseDispute");
  assert.equal(loaded.functionSignature, "0xdeadbeef");
  assert.equal(loaded.nonce, 1_756_300_000_000);
  assert.equal(loaded.exchangeId, "42");
});

test("has answers without loading the signature", () => {
  const store = createAuthorisationStore(freshDir());
  assert.equal(store.has("42", "raiseDispute"), false);
  store.save("42", "raiseDispute", signed, 1);
  assert.equal(store.has("42", "raiseDispute"), true);
  assert.equal(store.has("42", "escalateDispute"), false);
});

test("discarding a spent authorisation removes it", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1);
  store.discard("42", "raiseDispute");
  assert.equal(store.has("42", "raiseDispute"), false);
  assert.equal(store.load("42", "raiseDispute"), null);
});

test("discarding something already gone is not an error", () => {
  const store = createAuthorisationStore(freshDir());
  store.discard("42", "raiseDispute");
});

test("list names the actions held and nothing else", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1);
  store.save("42", "escalateDispute", signed, 2);
  const listed = store.list("42");
  assert.deepEqual(listed.sort(), ["escalateDispute", "raiseDispute"]);
  assert.equal(JSON.stringify(listed).includes("0x"), false);
});

test("a directory under a committed path is refused outright", () => {
  // Fixtures are committed. A bearer instrument written there is published the
  // moment the repository is.
  for (const committed of ["fixtures", "docs", "test"]) {
    assert.throws(
      () => createAuthorisationStore(join(ROOT, committed, "authorisations")),
      UnsafeAuthorisationDirError
    );
  }
});

test("files are written readable by their owner only", { skip: platform() === "win32" }, () => {
  const dir = freshDir();
  const store = createAuthorisationStore(dir);
  store.save("42", "raiseDispute", signed, 1);
  const mode = statSync(join(dir, "42.raiseDispute.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/authorisations.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/authorisations.mjs
// The buyer's pre-signed meta-transactions, held so the deadline logic can act
// on their behalf without ever holding their key.
//
// ⭐ These are bearer instruments. Narrowly scoped ones — one exchange, one
// function — but anyone holding one can perform that action. They are secrets:
// never in a fixture, never in a log, never in a commit, and deleted the moment
// they are spent.
//
// ⭐ The action space is enforced here, in the only place a signature can be
// stored. The watchdog does not refrain from completing an exchange or settling
// a dispute — it cannot, because no signature authorising either can exist.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ROOT } from "./env.mjs";

// The complete list, and it is a closed one. Every entry keeps a decision open
// for a human; nothing that disposes of funds appears, and nothing may be added
// without changing the specification this implements.
export const PERMITTED_ACTIONS = ["raiseDispute", "escalateDispute"];

export class UnsafeAuthorisationDirError extends Error {
  constructor(dir) {
    super(`refusing to keep authorisations in ${dir}: that path is committed`);
    this.name = "UnsafeAuthorisationDirError";
  }
}

const COMMITTED = ["fixtures", "docs", "test", "src", "scripts", ".github"];

function assertSafeDir(dir) {
  const full = resolve(dir);
  const relative = full.startsWith(ROOT + sep) ? full.slice(ROOT.length + 1) : null;
  if (relative && COMMITTED.includes(relative.split(sep)[0])) {
    throw new UnsafeAuthorisationDirError(full);
  }
  return full;
}

export function createAuthorisationStore(dir) {
  const root = assertSafeDir(dir);
  mkdirSync(root, { recursive: true });

  function assertPermitted(action) {
    if (!PERMITTED_ACTIONS.includes(action)) {
      throw new Error(`${action} is not an action this system may take on the buyer's behalf`);
    }
  }

  const pathFor = (exchangeId, action) => join(root, `${String(exchangeId)}.${action}.json`);

  function save(exchangeId, action, signed, nonce) {
    assertPermitted(action);
    const stored = {
      exchangeId: String(exchangeId),
      action,
      functionName: signed.functionName,
      functionSignature: signed.functionSignature,
      r: signed.r,
      s: signed.s,
      v: signed.v,
      nonce,
      createdAt: Date.now(),
    };
    const target = pathFor(exchangeId, action);
    writeFileSync(target, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // `mode` applies on creation only, so a re-save over an existing file would
    // keep whatever permissions that file already had. Reassert it.
    chmodSync(target, 0o600);
    return { exchangeId: String(exchangeId), action };
  }

  function load(exchangeId, action) {
    assertPermitted(action);
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId, action), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function has(exchangeId, action) {
    try {
      statSync(pathFor(exchangeId, action));
      return true;
    } catch {
      return false;
    }
  }

  // Spent, or the exchange is over. Either way it is deleted rather than kept:
  // a signature nobody needs is a liability with no upside.
  function discard(exchangeId, action) {
    rmSync(pathFor(exchangeId, action), { force: true });
  }

  // Names only, so an operator can be told what an exchange is protected by
  // without any of it reaching a terminal or a log file.
  function list(exchangeId) {
    return PERMITTED_ACTIONS.filter((action) => has(exchangeId, action));
  }

  return { save, load, has, discard, list, dir: root };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/authorisations.mjs test/authorisations.test.mjs
git commit -m "hold the buyer's pre-signed authorisations as secrets"
```

---

### Task 5: Create an exchange and capture its authorisations

**Files:**
- Create: `scripts/seed-exchange.mjs`
- Modify: `package.json` (add `"seed": "node scripts/seed-exchange.mjs"`)
- Modify: `.env.example` (add `EXCHANGES_DIR`, `AUTHORISATIONS_DIR`, `ITEM_PRICE`,
  `DELIVERY_TIMELINE_DAYS`, `OFFER_METADATA_URI`)

**Interfaces:**
- Consumes: `connect`, `waitForState` from `src/chain.mjs`; `createExchangeStore` from Task 3;
  `createAuthorisationStore` from Task 4.
- Produces: one live exchange in state REDEEMED, a record file, and two authorisation files.
  Prints the `exchangeId` that every later task takes as an argument.

**Verification is a live run**, not a unit test — the thing being proved is that the protocol
accepts what this builds. `npm run chain-check` and `npm run provision` must both pass first.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Create one exchange, end to end, and capture what the deadline logic needs.
//
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn>
//
// The seller signs the offer off-chain and never sends a transaction. The buyer
// submits one relayed meta-transaction that creates the offer, commits to it and
// redeems it — so the offer does not exist on-chain until the moment of purchase,
// and the buyer never holds native currency.
//
// ⭐ The two authorisations are signed immediately afterwards, in this same run,
// and they cannot be signed earlier: the protocol requires raiseDispute and
// escalateDispute to come from the buyer, and the exchangeId they are scoped to
// does not exist until the purchase is mined. An exchange without them is
// unprotected and must be shown as such.

import { Contract, constants, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";

// ⚠️ `connect()` returns an environment narrowed to the chain keys — that
// `only` list is what keeps wallet keys and the tracking key out of each
// other's processes, so the settings this script needs beyond the chain are
// loaded separately rather than by widening it.
const settings = loadEnv({
  only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR", "ITEM_PRICE", "DELIVERY_TIMELINE_DAYS", "OFFER_METADATA_URI"],
});

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const MS = 1000;
const DAY_MS = 86_400 * MS;

const seller = connect({ role: "seller", required: ["DISPUTE_RESOLVER_ID"] });
const buyer = connect({ role: "buyer" });
const { env, config, provider } = seller;
const protocol = config.contracts.protocolDiamond;
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const configHandler = new Contract(protocol, abis.IBosonConfigHandlerABI, provider);

const exchanges = createExchangeStore(settings.EXCHANGES_DIR ?? "state/exchanges");
const authorisations = createAuthorisationStore(settings.AUTHORISATIONS_DIR ?? "state/authorisations");

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`seller ${seller.signer.address}`);
info(`buyer  ${buyer.signer.address}`);

// --- read everything the offer is built from -------------------------------
step("reading the resolver and the protocol floors");

// ⚠️ The exchange token comes from the resolver's own fee schedule, not from
// .env: an offer is valid only if its token is one the resolver lists.
const resolverId = env.DISPUTE_RESOLVER_ID;
const [resolverExists, , fees] = await accountHandler.getDisputeResolver(resolverId);
if (!resolverExists) {
  console.log(`✗ dispute resolver ${resolverId} does not exist on ${config.configId}`);
  process.exit(1);
}
const fee =
  fees.find(
    (f) => f.tokenAddress.toLowerCase() === env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase() && f.feeAmount.isZero()
  ) ?? fees.find((f) => f.feeAmount.isZero() && f.tokenAddress !== constants.AddressZero);
if (!fee) {
  console.log("✗ the resolver lists no usable token at zero fee");
  process.exit(1);
}
const exchangeToken = fee.tokenAddress;
ok(`exchange token ${fee.tokenName || exchangeToken}, resolver fee 0`);

const [sellerExists, sellerAccount] = await accountHandler.getSellerByAddress(seller.signer.address);
if (!sellerExists) {
  console.log(`✗ ${seller.signer.address} has no seller account — run \`npm run provision\` first`);
  process.exit(1);
}
ok(`seller account ${sellerAccount.id}`);

// ⚠️ Read the floors rather than trusting a written-down value: an offer below
// either is rejected outright, and they are protocol configuration.
const [minDispute, minResolution] = await Promise.all([
  configHandler.getMinDisputePeriod(),
  configHandler.getMinResolutionPeriod(),
]);
info(`period floors — dispute ${Number(minDispute) / 86_400}d, resolution ${Number(minResolution) / 86_400}d`);

// --- build the offer -------------------------------------------------------
step("building the offer");
const now = Date.now();
const deliveryDays = Number(settings.DELIVERY_TIMELINE_DAYS ?? 3);

// The window opens at purchase, not at delivery, so it has to cover shipping
// and inspection — and can never go below the protocol floor.
const disputePeriodMs = Math.max((deliveryDays + 14) * DAY_MS, Number(minDispute) * MS);
const resolutionPeriodMs = Number(minResolution) * MS;
info(`dispute period ${disputePeriodMs / DAY_MS}d · resolution period ${resolutionPeriodMs / DAY_MS}d`);

const price = utils.parseUnits(settings.ITEM_PRICE ?? "20", 6).toString();

const fullOfferArgsUnsigned = {
  price,
  // ⭐ Zero, and it must stay zero: any deposit obliges the seller to fund
  // escrow before the buyer can commit, which reintroduces a gas-paying step.
  sellerDeposit: 0,
  agentId: 0,
  buyerCancelPenalty: 0,
  quantityAvailable: 1,
  validFromDateInMS: now,
  validUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Must be at or before now, or the atomic redeem in the same transaction
  // reverts.
  voucherRedeemableFromDateInMS: now,
  voucherRedeemableUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Typed optional by the SDK, required in practice: its validation resolves
  // the redeemable-until date with `when("voucherValidDurationInMS", …)` and
  // throws "invalid BigNumber value" naming no field when it is absent. Exactly
  // one of the two must be non-zero; this sets the date.
  voucherValidDurationInMS: 0,
  disputePeriodDurationInMS: disputePeriodMs,
  resolutionPeriodDurationInMS: resolutionPeriodMs,
  exchangeToken,
  disputeResolverId: resolverId,
  // ⚠️ Validated locally against ipfs://, http(s):// or a CIDv0 — a bare label
  // is rejected before anything is sent.
  metadataUri: settings.OFFER_METADATA_URI ?? "https://held.invalid/offer",
  metadataHash: "held-offer",
  collectionIndex: 0,
  // ⚠️ Typed optional, but signFullOffer reads `feeLimit.toString()` unguarded
  // and throws on undefined.
  feeLimit: price,
  royaltyInfo: { recipients: [], bps: [] },
  creator: 0, // OfferCreator.Seller — the seller signs, the buyer submits
  offerCreator: seller.signer.address,
  committer: buyer.signer.address,
  sellerId: sellerAccount.id.toString(),
  buyerId: 0,
  // Unconditional: nothing gates who may commit.
  condition: {
    method: 0,
    tokenType: 0,
    tokenAddress: constants.AddressZero,
    gatingType: 0,
    minTokenId: 0,
    maxTokenId: 0,
    threshold: 0,
    maxCommits: 0,
  },
  useDepositedFunds: false,
  sellerOfferParams: {
    collectionIndex: 0,
    royaltyInfo: { recipients: [], bps: [] },
    mutualizerAddress: constants.AddressZero,
  },
  mutualizerAddress: constants.AddressZero,
};

// --- the seller signs, gaslessly -------------------------------------------
step("the seller signs the offer");
const offerSignature = await seller.coreSDK.signFullOffer({ fullOfferArgsUnsigned });
ok("signed — the seller sends no transaction and pays no gas");

// --- the buyer submits one relayed meta-transaction ------------------------
step("the buyer creates, commits and redeems in one transaction");
const offerId = (await offerHandler.getNextOfferId()).toString();
info(`offer id will be ${offerId}`);

const nonce = Date.now();
const signedTx = await buyer.coreSDK.signMetaTxCreateOfferCommitAndRedeem({
  nonce,
  createOfferAndCommitArgs: { ...fullOfferArgsUnsigned, signature: offerSignature.signature },
});

const tx = await buyer.coreSDK.relayMetaTransaction({
  functionName: signedTx.functionName,
  functionSignature: signedTx.functionSignature,
  sigR: signedTx.r,
  sigS: signedTx.s,
  sigV: signedTx.v,
  nonce,
});
const receipt = await tx.wait();
ok(`relayed — tx ${explorer(receipt.transactionHash)}`);

const exchangeId = buyer.coreSDK.getCommittedExchangeIdFromLogs(receipt.logs);
if (!exchangeId) {
  console.log("✗ the transaction mined but no exchange id appears in its logs");
  process.exit(1);
}

// ⚠️ Not read directly. The relayer resolves on mining and the shipped RPC is a
// pool, so a read here can be answered by a node that does not have the block —
// which reads exactly like a failed transaction and is not one.
const onChain = await waitForState(
  async () => {
    const result = await exchangeHandler.getExchange(exchangeId);
    return result.exists && !result.voucher.redeemedDate.isZero() ? result : null;
  },
  { what: `exchange ${exchangeId} to read as redeemed` }
);
const redeemedAt = Number(onChain.voucher.redeemedDate) * MS;
ok(`exchange ${exchangeId} is redeemed — the window is open and the seller must fulfil`);
info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);

// --- capture the two authorisations ----------------------------------------
// ⭐ The second signing step, and the reason it is here rather than earlier.
step("capturing the authorisations the deadline logic will need");
const toAuthorise = [
  ["raiseDispute", (args) => buyer.coreSDK.signMetaTxRaiseDispute(args)],
  ["escalateDispute", (args) => buyer.coreSDK.signMetaTxEscalateDispute(args)],
];
for (const [index, [action, sign]] of toAuthorise.entries()) {
  // ⚠️ Distinct nonces, so neither depends on the other having executed. The
  // handler marks nonces used rather than requiring them in sequence, so the
  // two are order-independent — but they must not collide, and two calls to
  // Date.now() in the same millisecond would.
  const actionNonce = Date.now() + index;
  const signedAction = await sign({ nonce: actionNonce, exchangeId });
  authorisations.save(exchangeId, action, signedAction, actionNonce);
  ok(`${action} authorised for exchange ${exchangeId} only`);
}

// --- write the record ------------------------------------------------------
exchanges.put({
  exchangeId: String(exchangeId),
  offerId,
  configId: config.configId,
  trackerId: arg("tracker"),
  trackingNumber: arg("tracking-number"),
  redeemedAt,
  disputePeriodMs,
  resolutionPeriodMs,
  disputeRaisedAt: null,
  disputeRaisedBy: null,
  disputeTimeoutAt: null,
  escalatedAt: null,
  finalisedAt: null,
  outcome: null,
  authorisations: authorisations.list(exchangeId),
});

console.log("");
console.log(`exchange ${exchangeId} is live and protected by ${authorisations.list(exchangeId).join(" and ")}.`);
console.log(`Confirm receipt with: npm run confirm -- ${exchangeId}`);
```

- [ ] **Step 2: Register the command**

```bash
npm pkg set scripts.seed="node scripts/seed-exchange.mjs"
npm run lint
```

- [ ] **Step 3: Verify the chain path is ready**

Run: `npm run chain-check`
Expected: every check passes, including the relayer and the dispute resolver.

- [ ] **Step 4: Run it live**

Run: `npm run seed -- --tracker <trackerId> --tracking-number <trackingNumber>`
Expected: an exchange id printed, the window's closing time printed, and both authorisations
reported as captured. If it fails while *signing*, the offer this builds is wrong — the SDK
validates locally first and those errors name no field. If it fails while *relaying*, the protocol
refused it.

- [ ] **Step 5: Confirm nothing secret was committed**

```bash
git status --short          # state/ must not appear
grep -rn "0x[0-9a-f]\{64\}" --include="*.json" fixtures/ || echo "clean"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-exchange.mjs package.json .env.example
git commit -m "create an exchange and capture its deadline authorisations"
```

---

### Task 6: Confirm receipt — the payout path

**Files:**
- Create: `scripts/confirm-receipt.mjs`
- Modify: `package.json` (add `"confirm": "node scripts/confirm-receipt.mjs"`)

**Interfaces:**
- Consumes: the record store from Task 3, `connect`/`waitForState` from `src/chain.mjs`.
- Produces: a finalised exchange, and a record updated with `finalisedAt` and `outcome: "paid"`.

**Why this is a command and never automatic:** completing an exchange pays the seller irreversibly.
Tracking proves arrival, not condition, so nothing derived from a delivery scan may take this
action. It belongs to the buyer, and here that means a person running it.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// The buyer confirms, and the seller is paid.
//
//   node scripts/confirm-receipt.mjs <exchangeId>
//
// ⚠️ This is the one irreversible action in the system, and it is deliberately
// manual. No tracking event, of any kind, may reach it.

import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";

const exchangeId = process.argv[2];
if (!exchangeId) {
  console.error("usage: node scripts/confirm-receipt.mjs <exchangeId>");
  process.exit(1);
}

// Loaded separately from the chain environment, which `connect()` narrows to
// the chain keys on purpose.
const settings = loadEnv({ only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR"] });

const { config, provider, coreSDK } = connect({ role: "buyer" });
const exchangeHandler = new Contract(config.contracts.protocolDiamond, abis.IBosonExchangeHandlerABI, provider);
const exchanges = createExchangeStore(settings.EXCHANGES_DIR ?? "state/exchanges");
const authorisations = createAuthorisationStore(settings.AUTHORISATIONS_DIR ?? "state/authorisations");
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

const nonce = Date.now();
const signed = await coreSDK.signMetaTxCompleteExchange({ nonce, exchangeId });
const tx = await coreSDK.relayMetaTransaction({
  functionName: signed.functionName,
  functionSignature: signed.functionSignature,
  sigR: signed.r,
  sigS: signed.s,
  sigV: signed.v,
  nonce,
});
const receipt = await tx.wait();

// ⚠️ Read back through waitForState: the relayer resolves on mining and the
// RPC is a pool. A finalized date is the protocol's own statement that this is
// over, and needs no enum to interpret.
const finalised = await waitForState(
  async () => {
    const result = await exchangeHandler.getExchange(exchangeId);
    return result.exists && !result.exchange.finalizedDate.isZero() ? result : null;
  },
  { what: `exchange ${exchangeId} to read as finalised` }
);

const finalisedAt = Number(finalised.exchange.finalizedDate) * 1000;
if (exchanges.get(exchangeId)) {
  exchanges.update(exchangeId, { finalisedAt, outcome: "paid", authorisations: [] });
}

// ⭐ The exchange is over, so the two pre-signed authorisations are spent: they
// are deleted here rather than left lying around. A signature nobody needs is a
// liability with no remaining upside.
for (const action of ["raiseDispute", "escalateDispute"]) {
  authorisations.discard(exchangeId, action);
}

console.log(`✓ exchange ${exchangeId} finalised at ${new Date(finalisedAt).toISOString()}`);
console.log(`  tx ${explorer(receipt.transactionHash)}`);
console.log("  authorisations discarded");
```

- [ ] **Step 2: Register the command**

```bash
npm pkg set scripts.confirm="node scripts/confirm-receipt.mjs"
npm run lint
```

- [ ] **Step 3: Run it live against the exchange from Task 5**

Run: `npm run confirm -- <exchangeId>`
Expected: a finalised date printed and a transaction link.

**This closes the circuit**: a real parcel produced real tracking events, an exchange was created
gaslessly against them, and the seller was paid — every step on a live chain.

- [ ] **Step 4: Confirm the spent authorisations are gone**

```bash
ls state/authorisations   # neither file for that exchange id remains
```

- [ ] **Step 5: Commit**

```bash
git add scripts/confirm-receipt.mjs package.json
git commit -m "let the buyer confirm receipt and finalise the exchange"
```

---

### Task 7: The watchdog

**Files:**
- Create: `src/watchdog.mjs`
- Create: `scripts/watchdog.mjs`
- Test: `test/watchdog.test.mjs`
- Modify: `package.json` (add `"watchdog": "node scripts/watchdog.mjs"`)
- Modify: `.env.example` (add `DISPUTE_RAISE_LEAD_MS`, `ESCALATION_LEAD_MS`, `WATCHDOG_INTERVAL_MS`)

**Interfaces:**
- Consumes: `decide`, `ACTIONS`, `leadMs`, `assertLeadSane`, `RAISE_LEAD`, `ESCALATE_LEAD` from
  Task 1; the record store from Task 3; the authorisation store from Task 4; `createStore` from
  `src/store.mjs`.
- Produces:
  - `createWatchdog({ exchanges, trackers, authorisations, readChainState, relay, leadsFor, now, log }) -> { sweep }`
  - `sweep() -> Promise<Array<{ exchangeId, action, reason, relayed, unprotected, error }>>`
  - `readChainState(exchangeId) -> Promise<{ finalisedAt, outcome, disputeRaisedAt, disputeRaisedBy, disputeTimeoutAt, escalatedAt }>`
    — supplied by the caller, so the module has no chain dependency at all.
  - `relay(stored) -> Promise<receipt>` — takes an authorisation as saved by Task 4.

- [ ] **Step 1: Write the failing test**

```js
// test/watchdog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchdog } from "../src/watchdog.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { ACTIONS } from "../src/adapter.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = 7 * DAY;
const leads = { raiseMs: 48 * HOUR, escalateMs: 24 * HOUR };

const signed = {
  functionName: "raiseDispute(uint256)",
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
};

function harness({ recordOver = {}, chainOver = {}, withAuthorisations = true, relayImpl } = {}) {
  const exchanges = createExchangeStore(mkdtempSync(join(tmpdir(), "held-wd-x-")));
  const authorisations = createAuthorisationStore(mkdtempSync(join(tmpdir(), "held-wd-a-")));
  exchanges.put({
    exchangeId: "42",
    offerId: "120",
    configId: "testing-84532-0",
    trackerId: "tracker-1",
    trackingNumber: "MZ544750899GB",
    redeemedAt: 0,
    disputePeriodMs: PERIOD,
    resolutionPeriodMs: PERIOD,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeTimeoutAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: [],
    ...recordOver,
  });
  if (withAuthorisations) {
    authorisations.save("42", "raiseDispute", signed, 1);
    authorisations.save("42", "escalateDispute", signed, 2);
  }

  const relayed = [];
  const trackers = { read: () => ({ state: { current: "in_transit", delivered: false, everAvailableForPickup: false } }) };
  const watchdog = createWatchdog({
    exchanges,
    trackers,
    authorisations,
    readChainState: async () => ({
      finalisedAt: null,
      outcome: null,
      disputeRaisedAt: null,
      disputeRaisedBy: null,
      disputeTimeoutAt: null,
      escalatedAt: null,
      ...chainOver,
    }),
    relay: relayImpl ?? (async (stored) => { relayed.push(stored); return { transactionHash: "0xabc" }; }),
    leadsFor: () => leads,
    now: () => PERIOD - HOUR,
  });
  return { watchdog, exchanges, authorisations, relayed };
}

test("a healthy window relays nothing", async () => {
  const { watchdog, relayed } = harness({ recordOver: { disputePeriodMs: 90 * DAY } });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.NONE);
  assert.equal(relayed.length, 0);
});

test("a window nearing expiry relays the raise authorisation exactly once", async () => {
  const { watchdog, exchanges, authorisations, relayed } = harness();
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.RAISE);
  assert.equal(results[0].relayed, true);
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].functionName, "raiseDispute(uint256)");
  // Spent, so discarded — and the record now says who raised it.
  assert.equal(authorisations.has("42", "raiseDispute"), false);
  assert.equal(exchanges.get("42").disputeRaisedBy, "watchdog");
});

test("a second sweep does not raise again", async () => {
  const { watchdog, relayed } = harness();
  await watchdog.sweep();
  await watchdog.sweep();
  assert.equal(relayed.length, 1);
});

test("an exchange with no authorisation is reported unprotected, not acted on", async () => {
  const { watchdog, relayed } = harness({ withAuthorisations: false });
  const results = await watchdog.sweep();
  assert.equal(results[0].unprotected, true);
  assert.equal(results[0].relayed, false);
  assert.equal(relayed.length, 0);
});

test("a failed relay keeps the authorisation for the next sweep", async () => {
  const { watchdog, exchanges, authorisations } = harness({
    relayImpl: async () => { throw new Error("relayer unavailable"); },
  });
  const results = await watchdog.sweep();
  assert.match(results[0].error, /relayer unavailable/);
  assert.equal(authorisations.has("42", "raiseDispute"), true);
  assert.equal(exchanges.get("42").disputeRaisedAt, null);
});

test("one exchange failing does not stop the sweep", async () => {
  const { watchdog, exchanges } = harness({
    relayImpl: async () => { throw new Error("relayer unavailable"); },
  });
  exchanges.put({ ...exchanges.get("42"), exchangeId: "43" });
  const results = await watchdog.sweep();
  assert.equal(results.length, 2);
});

test("the protocol is the authority: a dispute the buyer raised is not raised again", async () => {
  const { watchdog, exchanges, relayed } = harness({
    chainOver: { disputeRaisedAt: 1, disputeRaisedBy: "buyer", disputeTimeoutAt: 90 * DAY },
  });
  await watchdog.sweep();
  assert.equal(relayed.length, 0);
  assert.equal(exchanges.get("42").disputeRaisedBy, "buyer");
});

test("a finalised exchange is skipped", async () => {
  const { watchdog, relayed } = harness({ chainOver: { finalisedAt: 1, outcome: "paid" } });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.NONE);
  assert.equal(relayed.length, 0);
});

test("nothing but the two permitted actions is ever relayed", async () => {
  // The invariant, asserted at the only place a relay can happen.
  const { watchdog, relayed } = harness({
    chainOver: { disputeRaisedAt: 0, disputeRaisedBy: "buyer" },
  });
  await watchdog.sweep();
  for (const stored of relayed) {
    assert.ok(["raiseDispute", "escalateDispute"].includes(stored.action));
  }
});

test("a resolution window nearing expiry escalates and discards that authorisation", async () => {
  const { watchdog, exchanges, authorisations, relayed } = harness({
    chainOver: { disputeRaisedAt: 0, disputeRaisedBy: "buyer" },
  });
  const results = await watchdog.sweep();
  assert.equal(results[0].action, ACTIONS.ESCALATE);
  assert.equal(relayed.length, 1);
  assert.equal(authorisations.has("42", "escalateDispute"), false);
  assert.equal(authorisations.has("42", "raiseDispute"), true); // untouched
  assert.ok(exchanges.get("42").escalatedAt);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/watchdog.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/watchdog.mjs
// The clock, not the events.
//
// A parcel that stops producing events entirely is precisely the case this
// exists for, so nothing here is triggered by an arrival: it sweeps on a timer,
// asks the decision function what each exchange needs, and relays one of the
// buyer's own pre-signed authorisations when a deadline nears.
//
// ⭐ Every side effect is injected. The module has no chain dependency, no
// provider and no key, which is what lets the whole of its behaviour be tested
// in milliseconds without a network.

import { ACTIONS, decide } from "./adapter.mjs";

export function createWatchdog({
  exchanges,
  trackers,
  authorisations,
  readChainState,
  relay,
  leadsFor,
  now = () => Date.now(),
  log = () => {},
}) {
  async function step(record) {
    const result = { exchangeId: record.exchangeId, action: ACTIONS.NONE, reason: null, relayed: false };

    // ⭐ The protocol is the authority on what has already happened. The buyer
    // may have acted themselves, in which case the stored authorisation is
    // simply never used — and relaying it anyway would revert.
    //
    // Only facts are merged, never absences. The protocol adds and never
    // retracts — a dispute does not un-raise and an exchange does not
    // un-finalise — so a null from the reader means "not yet", and writing it
    // over what we already know would erase it once per sweep.
    const chain = await readChainState(record.exchangeId);
    const facts = Object.fromEntries(Object.entries(chain).filter(([, value]) => value != null));
    const current = exchanges.update(record.exchangeId, facts);

    const tracking = current.trackerId ? (trackers.read(current.trackerId)?.state ?? null) : null;
    const { action, reason, dueAt } = decide({
      tracking,
      record: current,
      now: now(),
      leads: leadsFor(current),
    });
    Object.assign(result, { action, reason, dueAt });

    if (action === ACTIONS.NONE) return result;

    if (!authorisations.has(current.exchangeId, action)) {
      // ⚠️ Not a warning to swallow. The promise is that the buyer need not
      // watch the deadline, and without the signature that promise cannot be
      // kept — so it is reported rather than logged and forgotten.
      log(`⚠ exchange ${current.exchangeId} needs ${action} and is unprotected: no authorisation held`);
      return { ...result, unprotected: true };
    }

    const stored = authorisations.load(current.exchangeId, action);
    await relay(stored);

    // Discarded only after the relay resolves. A failure above leaves the
    // authorisation in place and the record untouched, so the next sweep
    // retries rather than losing the protection.
    authorisations.discard(current.exchangeId, action);

    const at = now();
    exchanges.update(
      current.exchangeId,
      action === ACTIONS.RAISE
        ? { disputeRaisedAt: at, disputeRaisedBy: "watchdog" }
        : { escalatedAt: at }
    );
    log(`✓ ${action} relayed for exchange ${current.exchangeId} — ${reason}`);
    return { ...result, relayed: true };
  }

  async function sweep() {
    const results = [];
    for (const record of exchanges.all()) {
      try {
        results.push(await step(record));
      } catch (err) {
        // One exchange failing must never stop the others: the next one along
        // may be the one whose window is about to lapse.
        log(`✗ exchange ${record.exchangeId}: ${err.message}`);
        results.push({ exchangeId: record.exchangeId, action: ACTIONS.NONE, relayed: false, error: err.message });
      }
    }
    return results;
  }

  return { sweep };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Write the runner that wires the real thing in**

```js
#!/usr/bin/env node
// Run the watchdog.
//
//   node scripts/watchdog.mjs --once
//   node scripts/watchdog.mjs
//
// ⭐ Calibrate by lead, not by window. Both protocol periods have a 7-day floor
// and cannot be shortened, so exercising the deadline logic is a matter of
// setting the lead close to the period — the watchdog then fires shortly after
// purchase without the window being touched at all.
//
// ⚠️ A lead approaching its period is a demonstration configuration and must
// never ship: in production it would raise disputes before a parcel could
// plausibly arrive. It warns loudly, every sweep, for exactly that reason.

import { Contract } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect } from "../src/chain.mjs";
import { loadEnv } from "../src/env.mjs";
import { createStore } from "../src/store.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { createWatchdog } from "../src/watchdog.mjs";
import { ESCALATE_LEAD, RAISE_LEAD, assertLeadSane, leadMs } from "../src/adapter.mjs";

const MS = 1000;
const once = process.argv.includes("--once");

// ⚠️ Two loads, deliberately. `connect()` narrows the environment to the chain
// keys, which is what keeps the tracking key out of a process that can move
// funds; these are this script's own settings and are loaded beside it rather
// than by widening that list.
const settings = loadEnv({
  only: [
    "EXCHANGES_DIR",
    "AUTHORISATIONS_DIR",
    "EVENTS_DIR",
    "RETAIN_LOCATIONS",
    "DISPUTE_RAISE_LEAD_MS",
    "ESCALATION_LEAD_MS",
    "WATCHDOG_INTERVAL_MS",
  ],
});

const { config, provider, coreSDK } = connect({ role: "buyer" });
const protocol = config.contracts.protocolDiamond;
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const disputeHandler = new Contract(protocol, abis.IBosonDisputeHandlerABI, provider);

const exchanges = createExchangeStore(settings.EXCHANGES_DIR ?? "state/exchanges");
const authorisations = createAuthorisationStore(settings.AUTHORISATIONS_DIR ?? "state/authorisations");
const trackers = createStore(settings.EVENTS_DIR ?? "fixtures/events", {
  retainPlaces: settings.RETAIN_LOCATIONS === "true",
});

const override = (name) => (settings[name] ? Number(settings[name]) : null);

function leadsFor(record) {
  const raiseMs = override("DISPUTE_RAISE_LEAD_MS") ?? leadMs(record.disputePeriodMs, RAISE_LEAD);
  const escalateMs = override("ESCALATION_LEAD_MS") ?? leadMs(record.resolutionPeriodMs, ESCALATE_LEAD);
  for (const warning of [
    ...assertLeadSane(record.disputePeriodMs, raiseMs, "DISPUTE_RAISE_LEAD"),
    ...assertLeadSane(record.resolutionPeriodMs, escalateMs, "ESCALATION_LEAD"),
  ]) {
    console.log(`⚠ ${warning}`);
  }
  return { raiseMs, escalateMs };
}

async function readChainState(exchangeId) {
  const [exchange, dispute] = await Promise.all([
    exchangeHandler.getExchange(exchangeId),
    disputeHandler.getDispute(exchangeId),
  ]);

  const finalisedAt = exchange.exists && !exchange.exchange.finalizedDate.isZero()
    ? Number(exchange.exchange.finalizedDate) * MS
    : null;

  if (!dispute.exists) {
    return { finalisedAt, disputeRaisedAt: null, disputeTimeoutAt: null, escalatedAt: null };
  }
  const { disputed, escalated, timeout } = dispute.disputeDates;
  return {
    finalisedAt,
    disputeRaisedAt: disputed.isZero() ? null : Number(disputed) * MS,
    disputeTimeoutAt: timeout.isZero() ? null : Number(timeout) * MS,
    escalatedAt: escalated.isZero() ? null : Number(escalated) * MS,
  };
}

const relay = async (stored) => {
  const tx = await coreSDK.relayMetaTransaction({
    functionName: stored.functionName,
    functionSignature: stored.functionSignature,
    sigR: stored.r,
    sigS: stored.s,
    sigV: stored.v,
    nonce: stored.nonce,
  });
  return tx.wait();
};

const watchdog = createWatchdog({
  exchanges,
  trackers,
  authorisations,
  readChainState,
  relay,
  leadsFor,
  log: (line) => console.log(line),
});

const intervalMs = Number(settings.WATCHDOG_INTERVAL_MS ?? 60_000);

async function run() {
  const results = await watchdog.sweep();
  for (const r of results) {
    const suffix = r.relayed ? " → relayed" : r.unprotected ? " → UNPROTECTED" : "";
    console.log(`  exchange ${r.exchangeId}: ${r.action}${suffix} — ${r.reason ?? r.error ?? ""}`);
  }
}

await run();
if (!once) {
  console.log(`\nsweeping every ${intervalMs / 1000}s — the clock drives this, not events`);
  setInterval(() => { run().catch((err) => console.log(`✗ sweep failed: ${err.message}`)); }, intervalMs);
}
```

- [ ] **Step 6: Register the command and run one sweep against the live exchange**

```bash
npm pkg set scripts.watchdog="node scripts/watchdog.mjs"
npm run lint
npm run watchdog -- --once
```

Expected: the exchange from Task 5 reported with its action and reason, nothing relayed while its
window is healthy.

- [ ] **Step 7: Prove it fires**

Create a throwaway exchange, set the lead so the threshold is already crossed, and watch it act.

```bash
npm run seed
DISPUTE_RAISE_LEAD_MS=$((7*24*3600*1000 - 120000)) npm run watchdog -- --once
```

Expected: the demonstration-configuration warning, then `raiseDispute → relayed`, the authorisation
gone, and a second `--once` run reporting no further action.

⚠️ **A lapsed window cannot be recovered and cannot be replaced quickly** — a lapsed dispute period
pays the seller, and the 7-day floor means a replacement exchange takes a week to reach the same
state. Any test of this effectively gets one attempt per exchange, so **seed several candidates in
parallel** rather than relying on one.

- [ ] **Step 8: Commit**

```bash
git add src/watchdog.mjs scripts/watchdog.mjs test/watchdog.test.mjs package.json .env.example
git commit -m "raise and escalate before a window lapses"
```

---

## What this plan does not cover

Three subsystems are deliberately out of scope here, and each gets its own plan when its inputs
exist:

| Not here | Why, and what it waits on |
|---|---|
| **Evidence assembly, the mediator and the clerk** | One component with two thin behaviours on top of it. It depends on none of this beyond the `exchangeId`, and its own spec is not yet written |
| **The buyer interface** | Consumes `moneyLine` and `parcelLine` from Task 2 and nothing else from this plan. Its states are settled here; its rendering is not |
| **Webhook signature verification** | `src/receiver.mjs` authenticates the caller with an unguessable path and carries no integrity check on the body. Anyone holding the path can inject events, and a forged `available_for_pickup` would stand the watchdog down permanently for that exchange. **This is a prerequisite for running the watchdog against a publicly reachable receiver**, and it belongs with the receiver rather than with the adapter |
