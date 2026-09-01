# Evidence assembly, the mediator and the case clerk — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Make a disputed exchange produce a settlement proposal a person can accept — evidence
assembled from real sources, a model that proposes a percentage and shows its reasoning, bounds that
make the action space a property of the code, and a buyer action that makes the whole case reachable
in the first place.

**Architecture:** One deterministic, hashed evidence bundle is the only thing any model-driven code
reads. Around it sit pure functions — schema and bounds, projection for display — and one module
that talks to the API. The mediator is a loop over successively larger bundles; the clerk is the same
bundle with the proposal absent. Every model call is recorded against its bundle hash, so tests and a
degraded network both replay instead of calling.

**Tech Stack:** Node 22 ESM, `node --test`, `@anthropic-ai/sdk` (new), `@bosonprotocol/core-sdk`
through `src/chain.mjs`, ethers v5.

**Spec:** [`../specs/evidence-and-mediation.md`](../specs/evidence-and-mediation.md) — read it
first; this plan argues from it throughout. Supporting:
[`../specs/tracking-state-mapping.md`](../specs/tracking-state-mapping.md) (what the watchdog does
and does not raise), [`../specs/offer-model.md`](../specs/offer-model.md) (how the exchange and its
authorisations exist), [`../chain.md`](../chain.md) (wiring and traps).

## Global Constraints

Every task's requirements implicitly include these. Values are copied from the specs verbatim.

- **Node >= 22**, ESM (`.mjs`), tests under `test/` with `node --test`. No test framework.
- **`src/receiver.mjs` stays dependency-free** and must never import `src/chain.mjs` or anything
  added here, directly or transitively.
- **No model-driven component may hold a tool that moves funds.** The mediator and clerk requests
  carry **no `tools` field at all**. This is the architectural form of the rule — its violation is a
  visible addition, not an invisible omission.
- **The action space is one number, the buyer's share, 0–100%.** The output schema has no field for
  any other remedy.
- **`buyerPercentBasisPoints` is the buyer's share in basis points, 0–10000.** `10000` pays the
  buyer everything, `0` pays the seller everything. Offers carry `sellerDeposit: 0`, so the pot is
  exactly the item price. A refund of 40 on an item priced at 200 is **2000**.
- **No bound evaluates fairness.** Bounds cover the action space, citation grounding and consent.
  Never a materiality threshold, never a rule about what a given kind of damage is worth.
- **`wouldChange` and `provisional` are never shown to a party**, in any surface, including error
  messages and debug output.
- **The clerk cannot see a proposal** — absent from its input, not filtered from its output.
- **No protocol vocabulary in anything the buyer sees** — no voucher, rNFT, redeem, commit,
  exchange, escrow, wallet or on-chain in a user-visible string. The buyer never encounters the word
  *dispute*.
- **Only two protocol writes are ever automatic:** `raiseDispute` and `escalateDispute`. A
  buyer-initiated raise is not automatic — it is the buyer acting — but it uses the same pre-signed
  authorisation.
- **Pre-signed authorisations are bearer instruments.** Never in a fixture, a log, a committed file
  or an error message.
- **After any relayed transaction, read state back with `waitForState`**, never directly.
- **Model:** `claude-opus-5`. Structured output via `output_config: { format: … }` — **not** the
  deprecated `output_format`. `thinking: { type: "adaptive" }`.

## File structure

| Path | Responsibility | Committed |
|---|---|---|
| `src/evidence.mjs` | Item shape, ids, provenance, the bundle and its hash. Pure | yes |
| `src/proposal.mjs` | The three result variants, the bounds, basis-point conversion, the party projection. Pure | yes |
| `src/cases.mjs` | Case records and the recording store that replay reads | yes |
| `src/model.mjs` | The only module that talks to the API. Takes an injected client | yes |
| `src/mediator.mjs` | One round per call: the cap, the deadline, the terminal states | yes |
| `src/clerk.mjs` | The case file, built from a bundle with no proposal | yes |
| `src/disputes.mjs` | Raising a dispute, attributed before the relay, for either raiser | yes |
| `scripts/raise-dispute.mjs` | The buyer's "something is wrong" action | yes |
| `scripts/mediate.mjs` | The composition root — the only place the pieces are wired together | yes |
| `fixtures/case/` | Photographs, message thread, listing — the case inputs | **yes** |
| `fixtures/case/system.md` | The mediator's objective and constraints. No case-specific rules | **yes** |
| `fixtures/case/recordings/` | Recorded model responses, keyed by bundle hash | **yes** |
| `state/cases/` | Live case working state | no — `state/` is gitignored |

> ⚠️ **Two storage locations, and the split matters.** `state/` is gitignored, like the exchange
> records. But recordings are read by tests and by the replay path, so they must be committed —
> which puts them under `fixtures/`, following `fixtures/events/`.
>
> ⚠️ **A recording never embeds image bytes.** Photographs are files under `fixtures/case/photos/`
> and a bundle item references one by **path and content hash**, never by base64. Base64 enters the
> request only at the moment of the API call, in `src/model.mjs`. A recording that inlined images
> would put megabytes of duplicated base64 into git history on every round.

---

## Task 1: The evidence bundle

**Files:**
- Create: `src/evidence.mjs`
- Test: `test/evidence.test.mjs`

**Interfaces:**
- Consumes: nothing — this is the base of the whole plan.
- Produces:
  - `PROVENANCE` — frozen array `["carrier", "buyer", "seller", "listing", "chain"]`
  - `assembleBundle({ exchangeId, tracking, offerTerms, photos, messages, listing, viewer })`
    → `{ exchangeId, items, hash }`
  - `bundleHash(items)` → `string` (hex)
  - each item: `{ id, kind, provenance, visibility, authored, content }`; a photo's content is
    `{ path, sha256 }`, never bytes

- [ ] **Step 1: Write the failing test**

```js
// test/evidence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBundle, bundleHash, PROVENANCE } from "../src/evidence.mjs";

const sources = (over = {}) => ({
  exchangeId: "241",
  tracking: { events: [
    { milestone: "in_transit", at: 1, description: "Accepted" },
    { milestone: "delivered",  at: 2, description: "Delivered" },
  ] },
  offerTerms: { price: "200", currency: "USDC", disputePeriodMs: 604800000 },
  photos: [{ path: "fixtures/case/photos/inner.jpg", sha256: "aa" }],
  messages: [{ from: "seller", at: 3, text: "Posted today" }],
  listing: { title: "Four sets", body: "Used, like new", priceText: "200" },
  viewer: "mediator",
  ...over,
});

test("the same sources produce the same ids and the same hash", () => {
  const a = assembleBundle(sources());
  const b = assembleBundle(sources());
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
  assert.equal(a.hash, b.hash);
});

test("adding one photograph changes the hash", () => {
  const before = assembleBundle(sources());
  const after = assembleBundle(sources({
    photos: [
      { path: "fixtures/case/photos/inner.jpg", sha256: "aa" },
      { path: "fixtures/case/photos/carton.jpg", sha256: "bb" },
    ],
  }));
  assert.notEqual(before.hash, after.hash);
});

test("every item carries a known provenance and a visibility", () => {
  for (const item of assembleBundle(sources()).items) {
    assert.ok(PROVENANCE.includes(item.provenance), `unknown provenance ${item.provenance}`);
    assert.equal(item.visibility, "shared");
  }
});

test("authored items stay marked", () => {
  const { items } = assembleBundle(sources());
  const byKind = (k) => items.find((i) => i.kind === k);
  assert.equal(byKind("message").authored, true);
  assert.equal(byKind("listing").authored, true);
  assert.equal(byKind("tracking_event").authored, false);
  assert.equal(byKind("offer_terms").authored, false);
});

test("a photograph is referenced, never inlined", () => {
  const photo = assembleBundle(sources()).items.find((i) => i.kind === "photo");
  assert.deepEqual(Object.keys(photo.content).sort(), ["path", "sha256"]);
});

test("ids are stable across a reordering of the same sources", () => {
  const forward = assembleBundle(sources());
  const reversed = assembleBundle(sources({
    messages: [{ from: "seller", at: 3, text: "Posted today" }].reverse(),
  }));
  assert.equal(forward.hash, reversed.hash);
});

test("hash is over content, not over object key order", () => {
  const a = bundleHash([{ id: "x", kind: "k", provenance: "chain", visibility: "shared", authored: false, content: { a: 1, b: 2 } }]);
  const b = bundleHash([{ content: { b: 2, a: 1 }, authored: false, visibility: "shared", provenance: "chain", kind: "k", id: "x" }]);
  assert.equal(a, b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/evidence.test.mjs`
Expected: FAIL — `Cannot find module '../src/evidence.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/evidence.mjs
// What the mediator and the clerk read, and the only thing they read.
//
// The bundle is deterministic and hashed so a case is reproducible: a proposal
// is recorded against the bundle that produced it, and adding one photograph
// produces a different hash — which is the whole mechanism behind a second
// round.

import { createHash } from "node:crypto";

export const PROVENANCE = Object.freeze(["carrier", "buyer", "seller", "listing", "chain"]);

// Ids are short because the model cites them repeatedly and a UUID per item is
// tokens spent on nothing. The prefix makes a citation readable in a case file.
const PREFIX = {
  tracking_event: "trk",
  photo: "pho",
  message: "msg",
  listing: "lst",
  offer_terms: "off",
};

// Stable key order, so a hash is over content rather than over whatever order
// an object literal happened to be written in.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, k) => {
      out[k] = canonical(value[k]);
      return out;
    }, {});
  }
  return value;
}

export function bundleHash(items) {
  return createHash("sha256").update(JSON.stringify(canonical(items))).digest("hex");
}

function item(kind, provenance, authored, content, n) {
  return { id: `${PREFIX[kind]}-${n}`, kind, provenance, visibility: "shared", authored, content };
}

export function assembleBundle({
  exchangeId,
  tracking = { events: [] },
  offerTerms = null,
  photos = [],
  messages = [],
  listing = null,
  viewer = "mediator",
} = {}) {
  const items = [];

  // Assembly order is fixed, and sorting inside each kind is what makes an id
  // stable when a caller hands the same evidence over in a different order.
  const events = [...(tracking.events ?? [])].sort((a, b) => a.at - b.at);
  events.forEach((e, i) => items.push(item("tracking_event", "carrier", false, e, i + 1)));

  if (offerTerms) items.push(item("offer_terms", "chain", false, offerTerms, 1));

  [...photos]
    .sort((a, b) => a.path.localeCompare(b.path))
    // ⚠️ Referenced, never inlined. Base64 enters only at the API call; a
    // recording that embedded it would put megabytes into git on every round.
    .forEach((p, i) => items.push(item("photo", "buyer", false, { path: p.path, sha256: p.sha256 }, i + 1)));

  [...messages]
    .sort((a, b) => a.at - b.at)
    .forEach((m, i) => items.push(item("message", m.from === "seller" ? "seller" : "buyer", true, m, i + 1)));

  if (listing) items.push(item("listing", "listing", true, listing, 1));

  // The viewer selects what that viewer may see. Today every item is shared and
  // every caller passes the mediator, so this selects everything — see the
  // spec's note that a field never exercised will be wrong the first time it is.
  const visible = items.filter((i) => i.visibility === "shared" || viewer === "mediator");

  return { exchangeId, items: visible, hash: bundleHash(visible) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/evidence.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/evidence.mjs test/evidence.test.mjs
git commit -m "add the evidence bundle: deterministic items, provenance and a content hash"
```

---

## Task 2: The proposal schema, the bounds and the party projection

**Files:**
- Create: `src/proposal.mjs`
- Test: `test/proposal.test.mjs`

**Interfaces:**
- Consumes: bundle items from Task 1 (needs only `items[].id`)
- Produces:
  - `STATUS` — `{ NEEDS_EVIDENCE: "needs_evidence", PROPOSAL: "proposal", CANNOT_SETTLE: "cannot_settle" }`
  - `checkProposal(result, bundle)` → `{ ok: true } | { ok: false, reason: string }`
  - `toBasisPoints(buyerPercent)` → `number`
  - `forParty(result)` → the same result with `wouldChange` and `provisional` removed
  - `BoundError` — thrown by nothing here; `checkProposal` returns rather than throws

- [ ] **Step 1: Write the failing test**

```js
// test/proposal.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProposal, toBasisPoints, forParty, STATUS } from "../src/proposal.mjs";

const bundle = { items: [{ id: "pho-1" }, { id: "lst-1" }] };

const proposal = (over = {}) => ({
  status: STATUS.PROPOSAL,
  buyerPercent: 20,
  reasoning: "The outer carton is intact, so the damage predates postage.",
  findings: [{ statement: "carton intact", evidenceIds: ["pho-1"] }],
  ...over,
});

const needsEvidence = (over = {}) => ({
  status: STATUS.NEEDS_EVIDENCE,
  requests: [{
    what: "a photograph of the outer shipping carton",
    whyItMatters: "It distinguishes damage in transit from damage before postage.",
    whoCanProvide: "buyer",
    wouldChange: [
      { answer: "intact", implies: "pre-existing", split: 20 },
      { answer: "crushed", implies: "in transit", split: 8 },
    ],
  }],
  provisional: { buyerPercent: 14, reasoning: "Split the difference pending the carton." },
  findings: [{ statement: "inner box crushed", evidenceIds: ["pho-1"] }],
  ...over,
});

// --- the action space ---

test("a percentage outside 0-100 is rejected", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: 101 }), bundle).ok, false);
  assert.equal(checkProposal(proposal({ buyerPercent: -1 }), bundle).ok, false);
});

test("a non-numeric percentage is rejected", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: "20" }), bundle).ok, false);
});

test("both endpoints are accepted", () => {
  assert.equal(checkProposal(proposal({ buyerPercent: 0 }), bundle).ok, true);
  assert.equal(checkProposal(proposal({ buyerPercent: 100 }), bundle).ok, true);
});

test("a remedy field that is not a percentage is rejected", () => {
  const r = checkProposal(proposal({ replacement: true }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown field/);
});

// --- grounding ---

test("a citation to an absent id is rejected", () => {
  const r = checkProposal(proposal({
    findings: [{ statement: "x", evidenceIds: ["pho-9"] }],
  }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /pho-9/);
});

test("grounding is checked on needs_evidence too", () => {
  const r = checkProposal(needsEvidence({
    findings: [{ statement: "x", evidenceIds: ["nope-1"] }],
  }), bundle);
  assert.equal(r.ok, false);
});

// --- the three variants ---

test("needs_evidence must carry a provisional split", () => {
  const r = checkProposal(needsEvidence({ provisional: undefined }), bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /provisional/);
});

test("cannot_settle must not carry a provisional split", () => {
  const r = checkProposal({
    status: STATUS.CANNOT_SETTLE,
    reasoning: "The accounts cannot both be true and nothing obtainable separates them.",
    findings: [{ statement: "x", evidenceIds: ["pho-1"] }],
    provisional: { buyerPercent: 50, reasoning: "…" },
  }, bundle);
  assert.equal(r.ok, false);
});

test("every request names at least two branches that do not all agree", () => {
  const same = needsEvidence({
    requests: [{
      what: "x", whyItMatters: "y", whoCanProvide: "buyer",
      wouldChange: [
        { answer: "a", implies: "p", split: 20 },
        { answer: "b", implies: "q", split: 20 },
      ],
    }],
  });
  const r = checkProposal(same, bundle);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same split/);
});

// --- basis points: direction as well as scale ---

test("basis points carry the buyer's share, in the buyer's direction", () => {
  assert.equal(toBasisPoints(0), 0);
  assert.equal(toBasisPoints(100), 10000);
  // A refund of 40 on an item priced at 200 is a buyer share of 20%.
  assert.equal(toBasisPoints(20), 2000);
});

test("basis points reject anything outside the action space", () => {
  assert.throws(() => toBasisPoints(101));
  assert.throws(() => toBasisPoints(-1));
});

// --- display isolation ---

test("nothing shown to a party carries wouldChange or provisional", () => {
  const shown = JSON.stringify(forParty(needsEvidence()));
  assert.ok(!shown.includes("wouldChange"), "wouldChange leaked");
  assert.ok(!shown.includes("provisional"), "provisional leaked");
  assert.ok(!shown.includes("14"), "the provisional split leaked");
  // whyItMatters is the shown field and must survive.
  assert.match(shown, /distinguishes damage in transit/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/proposal.test.mjs`
Expected: FAIL — `Cannot find module '../src/proposal.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/proposal.mjs
// The bounds on what the model may return.
//
// ⚠️ None of these evaluates whether the number is fair. They cover the action
// space, whether citations resolve, and what may be shown to a party. Fairness
// is the model's whole job: the proposal is inert until a person accepts it and
// either party may decline, so a fairness rule here would be this system's own
// policy wearing the model's clothes — and wrong the first time a case did not
// match the rule it was written for.

export const STATUS = Object.freeze({
  NEEDS_EVIDENCE: "needs_evidence",
  PROPOSAL: "proposal",
  CANNOT_SETTLE: "cannot_settle",
});

// The settlement-bearing surface. Listed rather than inferred so that a field
// nobody planned for is a rejection instead of a silently wider action space.
const FIELDS = {
  [STATUS.NEEDS_EVIDENCE]: ["status", "requests", "provisional", "findings"],
  [STATUS.PROPOSAL]: ["status", "buyerPercent", "reasoning", "findings"],
  [STATUS.CANNOT_SETTLE]: ["status", "reasoning", "findings"],
};

const INTERNAL = ["wouldChange", "provisional"];

const fail = (reason) => ({ ok: false, reason });

function checkPercent(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) return `${label} must be a number`;
  if (value < 0 || value > 100) return `${label} must be within 0-100, got ${value}`;
  return null;
}

export function checkProposal(result, bundle) {
  const allowed = FIELDS[result?.status];
  if (!allowed) return fail(`unknown status ${result?.status}`);

  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) return fail(`unknown field "${key}" for ${result.status}`);
  }

  if (result.status === STATUS.PROPOSAL) {
    const bad = checkPercent(result.buyerPercent, "buyerPercent");
    if (bad) return fail(bad);
  }

  if (result.status === STATUS.NEEDS_EVIDENCE) {
    if (!result.provisional) return fail("needs_evidence must carry a provisional split");
    const bad = checkPercent(result.provisional.buyerPercent, "provisional.buyerPercent");
    if (bad) return fail(bad);
    if (!Array.isArray(result.requests) || result.requests.length === 0) {
      return fail("needs_evidence must carry at least one request");
    }
    for (const req of result.requests) {
      const branches = req.wouldChange ?? [];
      if (branches.length < 2) return fail("a request must name at least two branches");
      // A request whose branches agree is a question whose answer changes
      // nothing, and it spends a party's effort to look diligent.
      if (new Set(branches.map((b) => b.split)).size === 1) {
        return fail("every branch of a request implies the same split");
      }
    }
  }

  // ⚠️ Grounding, not fairness. This says nothing about whether a finding is
  // correct — only that what it cites was actually in front of the model.
  const ids = new Set((bundle?.items ?? []).map((i) => i.id));
  for (const finding of result.findings ?? []) {
    for (const id of finding.evidenceIds ?? []) {
      if (!ids.has(id)) return fail(`finding cites ${id}, which is not in the bundle`);
    }
  }

  return { ok: true };
}

// The protocol takes the buyer's share in basis points. Direction and scale are
// both easy to invert and inverting either pays the wrong party in full.
export function toBasisPoints(buyerPercent) {
  const bad = checkPercent(buyerPercent, "buyerPercent");
  if (bad) throw new RangeError(bad);
  return Math.round(buyerPercent * 100);
}

// ⚠️ Everything a party sees goes through here. A party who can see which
// answer raises their share has been handed a multiple-choice question with the
// marks printed on it.
export function forParty(result) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.entries(value)
        .filter(([k]) => !INTERNAL.includes(k))
        .reduce((out, [k, v]) => { out[k] = strip(v); return out; }, {});
    }
    return value;
  };
  return strip(result);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/proposal.test.mjs`
Expected: PASS, 12 tests

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/proposal.mjs test/proposal.test.mjs
git commit -m "bound the model's output: action space, citation grounding, party projection"
```

---

## Task 3: The case store and the recording store

**Files:**
- Create: `src/cases.mjs`
- Test: `test/cases.test.mjs`
- Modify: `.gitignore` (no change needed — verify `state/` already covers the working store)

**Interfaces:**
- Consumes: `bundleHash` from Task 1
- Produces:
  - `createCaseStore(dir)` → `{ read(exchangeId), write(record), list() }`
  - `createRecordingStore(dir)` → `{ find(bundleHash), save(bundleHash, { model, response }) }`
  - a case record: `{ exchangeId, rounds: [], model, closedAt, outcome }`

- [ ] **Step 1: Write the failing test**

```js
// test/cases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "held-cases-"));

test("a case round-trips", () => {
  const store = createCaseStore(dir());
  store.write({ exchangeId: "241", rounds: [], model: "claude-opus-5", closedAt: null, outcome: null });
  assert.equal(store.read("241").exchangeId, "241");
});

test("a missing case reads as null rather than throwing", () => {
  assert.equal(createCaseStore(dir()).read("999"), null);
});

test("a recording is found by its bundle hash", () => {
  const store = createRecordingStore(dir());
  store.save("abc123", { model: "claude-opus-5", response: { status: "proposal", buyerPercent: 20 } });
  assert.equal(store.find("abc123").response.buyerPercent, 20);
  assert.equal(store.find("nothing"), null);
});

test("a recording never contains base64 image data", () => {
  const d = dir();
  const store = createRecordingStore(d);
  store.save("abc123", {
    model: "claude-opus-5",
    response: { status: "proposal", buyerPercent: 20 },
  });
  const written = readFileSync(join(d, readdirSync(d)[0]), "utf8");
  assert.ok(!/[A-Za-z0-9+/]{512,}={0,2}/.test(written), "something that looks like base64 was written");
});

test("a hash that is not a hex digest is refused as a filename", () => {
  const store = createRecordingStore(dir());
  assert.throws(() => store.save("../escape", { model: "m", response: {} }), /hash/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/cases.test.mjs`
Expected: FAIL — `Cannot find module '../src/cases.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/cases.mjs
// Two stores with different lifetimes, deliberately separate.
//
// A case is live working state and lives under state/, which is gitignored, on
// the same footing as the exchange records. A recording is read by tests and by
// the replay path, so it is committed and lives under fixtures/.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEX = /^[0-9a-f]{16,64}$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function createCaseStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = (id) => join(dir, `${String(id).replace(/[^0-9A-Za-z_-]/g, "")}.json`);
  return {
    read: (exchangeId) => readJson(path(exchangeId)),
    write: (record) => writeFileSync(path(record.exchangeId), JSON.stringify(record, null, 2)),
    list: () => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))),
  };
}

export function createRecordingStore(dir) {
  mkdirSync(dir, { recursive: true });
  // The hash is a filename, so it is validated rather than trusted — the same
  // reason the event store validates a tracker id before writing one.
  const path = (hash) => {
    if (!HEX.test(hash)) throw new Error(`refusing to use "${hash}" as a recording hash`);
    return join(dir, `${hash}.json`);
  };
  return {
    find: (hash) => (HEX.test(hash) ? readJson(path(hash)) : null),
    save: (hash, { model, response }) =>
      // ⚠️ Note what is absent: the request. A recording keys on the bundle
      // hash and stores the answer. Storing the request would embed the
      // photographs, and a photograph is a file with a hash, not bytes in git.
      writeFileSync(path(hash), JSON.stringify({ bundleHash: hash, model, response }, null, 2)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/cases.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Verify the working store is ignored, then commit**

```bash
git check-ignore -v state/cases/241.json   # expect a match on the state/ rule
npm run lint
git add src/cases.mjs test/cases.test.mjs
git commit -m "add the case store and the recording store that replay reads"
```

---

## Task 4: The model call

**Files:**
- Create: `src/model.mjs`
- Test: `test/model.test.mjs`
- Modify: `package.json` (add `@anthropic-ai/sdk`), `.env.example` (add `MEDIATOR_MAX_ROUNDS`)

**Interfaces:**
- Consumes: nothing from earlier tasks — takes a bundle and returns parsed JSON
- Produces:
  - `buildRequest({ bundle, system, photos, final })` → the request object, no `tools` key
  - `callModel({ client, bundle, system, photos, final })` → parsed result object
  - `MEDIATOR_MODEL_DEFAULT = "claude-opus-5"`

- [ ] **Step 1: Add the dependency**

```bash
npm install @anthropic-ai/sdk
```

Then add to `.env.example`, under the existing AI block:

```
# How many rounds of evidence-gathering before the mediator must conclude.
MEDIATOR_MAX_ROUNDS=3
```

- [ ] **Step 2: Write the failing test**

```js
// test/model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, callModel, MEDIATOR_MODEL_DEFAULT } from "../src/model.mjs";

const bundle = { exchangeId: "241", hash: "abc", items: [{ id: "pho-1", kind: "photo", provenance: "buyer", visibility: "shared", authored: false, content: { path: "p.jpg", sha256: "aa" } }] };

test("the request carries no tools field at all", () => {
  const req = buildRequest({ bundle, system: "s", photos: [] });
  assert.equal("tools" in req, false);
});

test("the request pins the model and uses structured output", () => {
  const req = buildRequest({ bundle, system: "s", photos: [] });
  assert.equal(req.model, MEDIATOR_MODEL_DEFAULT);
  assert.ok(req.output_config?.format, "output_config.format missing");
  assert.equal("output_format" in req, false, "the deprecated parameter was used");
});

test("thinking is adaptive", () => {
  assert.deepEqual(buildRequest({ bundle, system: "s", photos: [] }).thinking, { type: "adaptive" });
});

test("photographs are attached as image blocks, base64 only at this layer", () => {
  const req = buildRequest({
    bundle, system: "s",
    photos: [{ id: "pho-1", media_type: "image/jpeg", base64: "QUJD" }],
  });
  const blocks = req.messages[0].content;
  const image = blocks.find((b) => b.type === "image");
  assert.equal(image.source.data, "QUJD");
  assert.ok(blocks.some((b) => b.type === "text" && b.text.includes("pho-1")),
    "the image is not tied to its evidence id");
});

test("a final round says so in the request", () => {
  const req = buildRequest({ bundle, system: "s", photos: [], final: true });
  const text = req.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  assert.match(text, /final round/i);
});

test("callModel parses the structured output and returns it", async () => {
  const client = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: '{"status":"proposal","buyerPercent":20}' }] }),
    },
  };
  const result = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(result.buyerPercent, 20);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/model.test.mjs`
Expected: FAIL — `Cannot find module '../src/model.mjs'`

- [ ] **Step 4: Write the implementation**

```js
// src/model.mjs
// The only module in this repository that talks to the model provider.
//
// ⭐ There is no `tools` field anywhere in this file, and that is the point.
// The rule that no model-driven component may hold a tool that can move funds
// is not a discipline someone has to maintain — it is the absence of a
// parameter, in one place, where adding it would be a visible change.

export const MEDIATOR_MODEL_DEFAULT = "claude-opus-5";

// The schema is the action space. There is no field for a remedy that is not a
// percentage, so a wider remedy is unrepresentable rather than rejected.
const FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "findings"],
    properties: {
      status: { type: "string", enum: ["needs_evidence", "proposal", "cannot_settle"] },
      buyerPercent: { type: "number", minimum: 0, maximum: 100 },
      reasoning: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["statement", "evidenceIds"],
          properties: {
            statement: { type: "string" },
            evidenceIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      provisional: {
        type: "object",
        additionalProperties: false,
        required: ["buyerPercent", "reasoning"],
        properties: {
          buyerPercent: { type: "number", minimum: 0, maximum: 100 },
          reasoning: { type: "string" },
        },
      },
      requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["what", "whyItMatters", "whoCanProvide", "wouldChange"],
          properties: {
            what: { type: "string" },
            whyItMatters: { type: "string" },
            whoCanProvide: { type: "string", enum: ["buyer", "seller"] },
            wouldChange: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["answer", "implies", "split"],
                properties: {
                  answer: { type: "string" },
                  implies: { type: "string" },
                  split: { type: "number", minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function buildRequest({ bundle, system, photos = [], final = false, model = null }) {
  const content = [
    { type: "text", text: JSON.stringify({ exchangeId: bundle.exchangeId, items: bundle.items }, null, 2) },
  ];

  // Each photograph is announced by its evidence id immediately before its
  // bytes, so a finding that cites pho-2 is citing something the model can tell
  // apart from pho-1. Without this the images are an unlabelled pile.
  for (const photo of photos) {
    content.push({ type: "text", text: `Evidence item ${photo.id}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: photo.media_type, data: photo.base64 },
    });
  }

  if (final) {
    content.push({
      type: "text",
      text: "This is the final round. Return a proposal or cannot_settle; needs_evidence is not available.",
    });
  }

  return {
    model: model ?? process.env.MEDIATOR_MODEL ?? MEDIATOR_MODEL_DEFAULT,
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: { format: FORMAT },
    messages: [{ role: "user", content }],
  };
}

export async function callModel({ client, bundle, system, photos = [], final = false, model = null }) {
  const response = await client.messages.create(buildRequest({ bundle, system, photos, final, model }));
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/model.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 6: Confirm no key is needed to test, lint and commit**

```bash
env -u ANTHROPIC_API_KEY npm test -- test/model.test.mjs   # must still pass
npm run lint
git add package.json package-lock.json .env.example src/model.mjs test/model.test.mjs
git commit -m "add the model call: structured output, adaptive thinking, no tools"
```

---

## Task 5: The mediator

**Files:**
- Create: `src/mediator.mjs`
- Test: `test/mediator.test.mjs`

**Interfaces:**
- Consumes: `assembleBundle` (1), `checkProposal`/`STATUS`/`forParty` (2), `createRecordingStore` (3),
  `callModel` (4)
- Produces:
  - `mediate({ bundle, record, now, deps, maxRounds, escalateLeadMs })` → a result plus
    `{ replayed: boolean }`
  - `deadlineFor(record, escalateLeadMs)` → `number | null`

- [ ] **Step 1: Write the failing test**

```js
// test/mediator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediate, deadlineFor } from "../src/mediator.mjs";
import { STATUS } from "../src/proposal.mjs";

const DAY = 86_400_000;
const bundle = { exchangeId: "241", hash: "a".repeat(64), items: [{ id: "pho-1" }] };
const record = (over = {}) => ({
  exchangeId: "241",
  disputeRaisedAt: 0,
  resolutionPeriodMs: 7 * DAY,
  disputeTimeoutAt: null,
  ...over,
});

const recordings = () => {
  const map = new Map();
  return { find: (h) => map.get(h) ?? null, save: (h, v) => map.set(h, v) };
};

const answering = (result) => async () => result;

const proposal = { status: STATUS.PROPOSAL, buyerPercent: 20, reasoning: "r", findings: [] };
const asking = {
  status: STATUS.NEEDS_EVIDENCE,
  requests: [{
    what: "the carton", whyItMatters: "cause", whoCanProvide: "buyer",
    wouldChange: [{ answer: "a", implies: "p", split: 20 }, { answer: "b", implies: "q", split: 8 }],
  }],
  provisional: { buyerPercent: 14, reasoning: "pending" },
  findings: [],
};

test("the deadline is the escalation instant, from the record", () => {
  assert.equal(deadlineFor(record(), DAY), 7 * DAY - DAY);
});

test("the protocol's own timeout wins over the computed one", () => {
  assert.equal(deadlineFor(record({ disputeTimeoutAt: 3 * DAY }), DAY), 2 * DAY);
});

test("a proposal comes straight back", async () => {
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: { call: answering(proposal), recordings: recordings() },
  });
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.replayed, false);
});

test("a matching hash replays and never calls the model", async () => {
  const store = recordings();
  store.save(bundle.hash, { model: "m", response: proposal });
  let called = false;
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: { call: async () => { called = true; }, recordings: store },
  });
  assert.equal(called, false);
  assert.equal(out.replayed, true);
  assert.equal(out.buyerPercent, 20);
});

test("the final round is told it is final and may not ask", async () => {
  let sawFinal = false;
  const out = await mediate({
    bundle, record: record(), now: 0, maxRounds: 1,
    deps: {
      call: async ({ final }) => { sawFinal = final; return asking; },
      recordings: recordings(),
    },
  });
  assert.equal(sawFinal, true);
  // It asked anyway; the mediator falls back to the provisional rather than
  // presenting a question nobody can answer.
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.buyerPercent, 14);
});

test("past the deadline it does not ask, it concludes", async () => {
  const out = await mediate({
    bundle, record: record(), now: 7 * DAY,
    deps: { call: answering(asking), recordings: recordings() },
  });
  assert.equal(out.status, STATUS.PROPOSAL);
  assert.equal(out.buyerPercent, 14);
});

test("an ungrounded response is retried once, then fails the case", async () => {
  let calls = 0;
  const bad = { ...proposal, findings: [{ statement: "x", evidenceIds: ["nope"] }] };
  await assert.rejects(
    mediate({
      bundle, record: record(), now: 0,
      deps: { call: async () => { calls += 1; return bad; }, recordings: recordings() },
    }),
    /not in the bundle/,
  );
  assert.equal(calls, 2);
});

test("cannot_settle is returned as it is", async () => {
  const out = await mediate({
    bundle, record: record(), now: 0,
    deps: {
      call: answering({ status: STATUS.CANNOT_SETTLE, reasoning: "r", findings: [] }),
      recordings: recordings(),
    },
  });
  assert.equal(out.status, STATUS.CANNOT_SETTLE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/mediator.test.mjs`
Expected: FAIL — `Cannot find module '../src/mediator.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/mediator.mjs
// One round is one call over one bundle. Rounds are not a conversation: each is
// independent, with its own hash and its own recording, which is why there can
// be several of them without any history to carry.

import { STATUS, checkProposal } from "./proposal.mjs";

const DEFAULT_MAX_ROUNDS = Number(process.env.MEDIATOR_MAX_ROUNDS ?? 3);

// ⚠️ The deadline is the protocol's, not this component's. A resolution period
// that lapses pays the seller, and the watchdog already escalates a lead before
// that instant — so mediation runs inside a window something else guards, and
// reads the instant rather than starting a timer of its own.
export function deadlineFor(record, escalateLeadMs) {
  if (record?.disputeRaisedAt == null) return null;
  const expiry = record.disputeTimeoutAt != null
    ? record.disputeTimeoutAt
    : record.disputeRaisedAt + record.resolutionPeriodMs;
  return expiry - escalateLeadMs;
}

// Falling back to the provisional is what makes a deadline or an exhausted cap
// produce a decision rather than an invented number: the model has already said
// what it would propose on the evidence it has.
function concludeFrom(result) {
  if (result.status !== STATUS.NEEDS_EVIDENCE) return result;
  return {
    status: STATUS.PROPOSAL,
    buyerPercent: result.provisional.buyerPercent,
    reasoning: result.provisional.reasoning,
    findings: result.findings ?? [],
  };
}

export async function mediate({
  bundle,
  record,
  now,
  deps,
  maxRounds = DEFAULT_MAX_ROUNDS,
  escalateLeadMs = 86_400_000,
  round = 1,
  system = "",
  photos = [],
}) {
  const cached = deps.recordings.find(bundle.hash);
  if (cached) return { ...cached.response, replayed: true };

  const deadline = deadlineFor(record, escalateLeadMs);
  // A round that cannot be answered before the deadline must not ask for
  // anything, so it is run as a final round and concludes on what it has.
  const outOfTime = deadline != null && now >= deadline;
  const final = outOfTime || round >= maxRounds;

  let result = await deps.call({ bundle, system, photos, final });
  let check = checkProposal(result, bundle);

  if (!check.ok) {
    // One retry, then fail the case rather than present something ungrounded.
    result = await deps.call({ bundle, system, photos, final });
    check = checkProposal(result, bundle);
    if (!check.ok) throw new Error(`the mediator returned an unusable result: ${check.reason}`);
  }

  deps.recordings.save(bundle.hash, { model: result.model ?? null, response: result });

  if (final) return { ...concludeFrom(result), replayed: false };
  return { ...result, replayed: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/mediator.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/mediator.mjs test/mediator.test.mjs
git commit -m "add the mediator: rounds, the cap, the protocol's deadline and replay"
```

---

## Task 6: The case clerk

**Files:**
- Create: `src/clerk.mjs`
- Test: `test/clerk.test.mjs`

**Interfaces:**
- Consumes: a bundle (1), a case record (3)
- Produces: `buildCaseFile({ bundle, caseRecord })` → `{ exchangeId, timeline, evidence, requests, contested }`

- [ ] **Step 1: Write the failing test**

```js
// test/clerk.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaseFile } from "../src/clerk.mjs";

const bundle = {
  exchangeId: "241",
  hash: "b".repeat(64),
  items: [
    { id: "trk-1", kind: "tracking_event", provenance: "carrier", authored: false, content: { at: 1, description: "Delivered" } },
    { id: "msg-1", kind: "message", provenance: "seller", authored: true, content: { at: 2, text: "Posted" } },
  ],
};

const caseRecord = {
  exchangeId: "241",
  rounds: [
    {
      requests: [{ what: "the carton", whyItMatters: "cause", whoCanProvide: "buyer", wouldChange: [{ answer: "a", implies: "p", split: 20 }, { answer: "b", implies: "q", split: 8 }] }],
      provisional: { buyerPercent: 14, reasoning: "pending" },
      provided: [],
    },
  ],
  proposal: { status: "proposal", buyerPercent: 20, reasoning: "settled" },
};

test("the case file carries no proposed split anywhere", () => {
  const serialised = JSON.stringify(buildCaseFile({ bundle, caseRecord }));
  assert.ok(!serialised.includes("buyerPercent"), "a split reached the case file");
  assert.ok(!serialised.includes("provisional"), "a provisional reached the case file");
  assert.ok(!serialised.includes("wouldChange"), "the branches reached the case file");
  assert.ok(!serialised.includes("settled"), "the proposal's reasoning reached the case file");
});

test("every evidence item keeps its provenance and its authored mark", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  const msg = file.evidence.find((e) => e.id === "msg-1");
  assert.equal(msg.provenance, "seller");
  assert.equal(msg.authored, true);
});

test("a request that was never answered still appears, marked unanswered", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  assert.equal(file.requests.length, 1);
  assert.equal(file.requests[0].answered, false);
  assert.equal(file.requests[0].what, "the carton");
});

test("the timeline is ordered", () => {
  const file = buildCaseFile({ bundle, caseRecord });
  assert.deepEqual(file.timeline.map((t) => t.at), [1, 2]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/clerk.test.mjs`
Expected: FAIL — `Cannot find module '../src/clerk.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// src/clerk.mjs
// The file that goes to a person.
//
// ⚠️ The clerk never sees a proposal. Not filtered on the way out — absent on
// the way in. A human decider's job is to decide without being anchored, and
// implementing that as an instruction in a prompt would make it a request
// rather than a fact about what this code can possibly know.

export function buildCaseFile({ bundle, caseRecord }) {
  const timeline = bundle.items
    .filter((i) => i.content?.at != null)
    .map((i) => ({ id: i.id, at: i.content.at, provenance: i.provenance, what: i.content.description ?? i.content.text ?? i.kind }))
    .sort((a, b) => a.at - b.at);

  const evidence = bundle.items.map((i) => ({
    id: i.id,
    kind: i.kind,
    // Provenance travels all the way here. A file that presented an
    // aggregator's tracking read and a buyer's photograph as the same kind of
    // fact would be misleading to the person who has to weigh them.
    provenance: i.provenance,
    authored: i.authored,
  }));

  const requests = (caseRecord.rounds ?? []).flatMap((round) =>
    (round.requests ?? []).map((req) => ({
      what: req.what,
      whyItMatters: req.whyItMatters,
      askedOf: req.whoCanProvide,
      // What a party was asked for and did not supply is exactly what cannot be
      // reconstructed afterwards, so it is part of the record rather than an
      // absence from it.
      answered: (round.provided ?? []).length > 0,
    })),
  );

  const contested = requests.filter((r) => !r.answered).map((r) => r.what);

  return { exchangeId: bundle.exchangeId, timeline, evidence, requests, contested };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/clerk.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/clerk.mjs test/clerk.test.mjs
git commit -m "add the case clerk: a file with provenance intact and no proposed split"
```

---

## Task 7: The buyer-initiated raise, and attribution before the relay

**Files:**
- Create: `src/disputes.mjs`, `scripts/raise-dispute.mjs`
- Modify: `src/watchdog.mjs` (make the attribution guard read fresh — see Step 5), `package.json`
- Test: `test/disputes.test.mjs`, `test/watchdog.test.mjs` (extend)

> **A judgement call to understand before you change it.** `src/watchdog.mjs`'s `step()` handles
> `raiseDispute` and `escalateDispute` through one generic path — relay, confirm, discard, update —
> and that code is live and proven against real disputes. Extracting the raise half so the buyer path
> could share it would fork that path days before a freeze. So `src/disputes.mjs` repeats the same
> four-step order for the buyer, and `step()` is changed by **moving one write**, not restructured.
> The duplication is deliberate and is the smaller risk. If you are reading this with time in hand,
> unifying them is the right cleanup.

> ✅ **The attribution finding this task was going to close is already fixed** — separately, and not
> the way the sketch below assumed. It was not solved by moving the `disputeRaisedBy` write earlier.
> `src/watchdog.mjs` now records **`disputeRaiseAttemptedAt`** before relaying and attributes the
> dispute on a later sweep, when the chain confirms a dispute exists and an attempt by this watchdog
> is on record — so `disputeRaisedBy` never claims a raise that did not land.
>
> ⚠️ **Four places below still describe the old shape** — the Files list above, the Interfaces list
> above, Step 1's grep with Step 2's test, and Step 5, which has been rewritten into the change that
> is actually still needed. **Read `step()` before following any of them.**
>
> What is left for this task is the buyer half: `raiseFor({ by })` writing `disputeRaisedBy: "buyer"`.
> That one may be written before its relay, because the buyer's line is gated on `disputeRaisedAt`,
> which `raiseFor` sets only after `confirm` returns.
>
> ⚠️ **But the two paths can still fight over one record, and Step 5 is what stops them.** The
> watchdog does defer to a `disputeRaisedBy` already present — it just reads it from the snapshot
> `sweep()` took at the top of the pass, which can be minutes stale by the time `step()` reaches this
> record, since an earlier exchange may have sat in `confirm()`'s poll. A buyer raise landing inside
> that window gets overwritten with `"watchdog"`, and `scripts/raise-dispute.mjs` is a **separate
> process**, so the in-process `sweeping` guard says nothing about it.

**Interfaces:**
- Consumes: `exchanges.update(id, patch)` and `authorisations.has/load/discard(id, action)` from the
  existing stores; `connect`, `waitForState`, `RELAY_ONLY_ENV_KEYS` from `src/chain.mjs`
- Produces:
  - `raiseFor({ exchangeId, by, exchanges, authorisations, relay, confirm, now })` → the relay receipt
  - `npm run raise -- <exchangeId> [--execute]`
  - records carry `disputeRaisedBy: "buyer" | "watchdog"` — the buyer's written before its relay,
    the watchdog's on the sweep after, read back from `disputeRaiseAttemptedAt`

- [ ] **Step 1: Confirm where attribution is written today**

```bash
grep -n "disputeRaisedBy" src/watchdog.mjs
```

Expected: one match, inside `exchanges.update(...)` **after** `await confirm(stored)`. That placement
is the defect this task fixes — a relay that lands while its confirmation is lost leaves the record
saying nobody raised it, and the buyer is then told *"Let's sort this out"* when the system in fact
raised it for them.

- [ ] **Step 2: Write the failing test**

```js
// test/disputes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseFor } from "../src/disputes.mjs";

const stores = () => {
  const patches = [];
  return {
    patches,
    exchanges: { update: (id, patch) => { patches.push({ ...patch }); return { exchangeId: id, ...patch }; } },
    authorisations: {
      has: () => true,
      load: () => ({ exchangeId: "241", action: "raiseDispute", functionName: "f", functionSignature: "s", r: "0x1", s: "0x2", v: 27, nonce: 1, userAddress: "0xabc" }),
      discarded: [],
      discard(id, action) { this.discarded.push([id, action]); },
    },
  };
};

test("attribution is written before the relay, so a lost confirmation keeps it", async () => {
  const s = stores();
  await assert.rejects(raiseFor({
    exchangeId: "241", by: "watchdog",
    exchanges: s.exchanges, authorisations: s.authorisations,
    relay: async () => { throw new Error("relay timed out"); },
    confirm: async () => {},
  }), /relay timed out/);
  assert.equal(s.patches[0].disputeRaisedBy, "watchdog",
    "attribution was not recorded before the relay was attempted");
});

test("a buyer-raised dispute is attributed to the buyer", async () => {
  const s = stores();
  await raiseFor({
    exchangeId: "241", by: "buyer",
    exchanges: s.exchanges, authorisations: s.authorisations,
    relay: async () => ({ transactionHash: "0x1" }),
    confirm: async () => {},
  });
  assert.equal(s.patches.at(-1).disputeRaisedBy, "buyer");
  assert.equal(s.patches.at(-1).disputeRaisedAt > 0, true);
});

test("the authorisation is discarded only after the protocol confirms", async () => {
  const s = stores();
  await assert.rejects(raiseFor({
    exchangeId: "241", by: "buyer",
    exchanges: s.exchanges, authorisations: s.authorisations,
    relay: async () => ({}),
    confirm: async () => { throw new Error("reverted"); },
  }), /reverted/);
  assert.deepEqual(s.authorisations.discarded, [],
    "the buyer's only signature was thrown away on a transaction that did not land");
});

test("an exchange with no stored authorisation refuses rather than pretending", async () => {
  const s = stores();
  s.authorisations.has = () => false;
  await assert.rejects(raiseFor({
    exchangeId: "241", by: "buyer",
    exchanges: s.exchanges, authorisations: s.authorisations,
    relay: async () => ({}), confirm: async () => {},
  }), /no raiseDispute authorisation/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/disputes.test.mjs`
Expected: FAIL — `Cannot find module '../src/disputes.mjs'`

- [ ] **Step 4: Write the shared raise**

```js
// src/disputes.mjs
// Raising a dispute on an exchange, for whoever is doing the raising.
//
// ⭐ One pre-signed authorisation, two possible spenders. The buyer's "something
// is wrong" spends exactly the instrument the watchdog would have spent later,
// and the watchdog then stands down on its own — the decision function moves to
// the escalation branch as soon as disputeRaisedAt is set.
//
// ⚠️ This repeats the order in src/watchdog.mjs step() rather than sharing it.
// That code is live and proven; forking it days before a freeze is the larger
// risk. The order is the part that matters and it is identical: attribute,
// relay, confirm, discard, record.

export async function raiseFor({
  exchangeId,
  by,
  exchanges,
  authorisations,
  relay,
  confirm,
  now = () => Date.now(),
}) {
  if (!authorisations.has(exchangeId, "raiseDispute")) {
    throw new Error(`no raiseDispute authorisation is held for exchange ${exchangeId}`);
  }
  const stored = authorisations.load(exchangeId, "raiseDispute");

  // ⚠️ Before the relay, not after. Attribution is buyer-visible, and the case
  // it exists for is precisely the one where the relay lands and the
  // confirmation does not: without this the record says nobody raised it, and
  // the buyer reads "Let's sort this out" for a dispute the system raised.
  exchanges.update(exchangeId, { disputeRaisedBy: by, disputeRaiseAttemptedAt: now() });

  await relay(stored);

  // The relayer resolving is not the protocol having acted. A reverted
  // meta-transaction returns through the same path as a successful one, so the
  // protocol is asked. A throw here leaves the authorisation in place and the
  // window open for another attempt.
  await confirm(stored);

  // Only once it is known to have landed. Any earlier trades the buyer's
  // protection for the appearance of success.
  authorisations.discard(exchangeId, "raiseDispute");
  exchanges.update(exchangeId, { disputeRaisedAt: now(), disputeRaisedBy: by });
  return stored;
}
```

- [ ] **Step 5: Make the watchdog's attribution read the record fresh**

⚠️ **This is not what this step used to say.** It used to say *move the attribution write to before
the relay*. That finding was closed a different and better way — `step()` already records
`disputeRaiseAttemptedAt` before relaying and attributes on the sweep after. **There is no
attribution write to move; do not add one.**

What is still needed is closing the race that `raiseFor` opens by being a second raiser. The
attribution guard tests `record.disputeRaisedBy`, and `record` is the snapshot `sweep()` took from
`exchanges.all()` at the top of the pass — stale by however long the exchanges before it took.

In `src/watchdog.mjs` `step()`, read the record again just before the guard:

```js
    // ⭐ Read again rather than trust the snapshot sweep() opened with: a buyer
    // raise comes from raise-dispute.mjs, a separate process, so the in-process
    // sweeping guard says nothing about it — and this record may have been
    // written since this sweep began.
    const before = exchanges.get(record.exchangeId) ?? record;
```

and test `before.disputeRaisedBy` and `before.disputeRaiseAttemptedAt` in place of the two
`record.…` reads. `exchanges.update` re-reads from disk on every call anyway, so this costs one
extra read and shrinks the window from a whole sweep to microseconds.

**Test it:** a record with `disputeRaisedBy: "buyer"` written to disk *after* `all()` returned must
come out of the sweep still attributed to the buyer.

- [ ] **Step 6: Write the buyer's action**

`relay` and `confirm` are wired exactly as in `scripts/watchdog.mjs` — read that file's versions
alongside this and keep them identical in shape.

```js
// scripts/raise-dispute.mjs
// The buyer's "something is wrong". Not automatic — this is the buyer acting —
// but it spends the same pre-signed authorisation the watchdog holds.
//
// ⚠️ No user-visible copy lives here. The buyer never encounters the word
// dispute; their interface says something is wrong, and this is what runs.

import { loadEnv } from "../src/env.mjs";
import { connect, waitForState, RELAY_ONLY_ENV_KEYS } from "../src/chain.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";
import { raiseFor } from "../src/disputes.mjs";

const [exchangeId, ...flags] = process.argv.slice(2);
const execute = flags.includes("--execute");

if (!exchangeId) {
  console.error("usage: npm run raise -- <exchangeId> [--execute]");
  process.exit(1);
}

// ⚠️ Two loads, deliberately — connect() narrows the environment to the chain
// keys, so this script's own settings are loaded separately.
const settings = loadEnv({ required: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR"] });
const exchanges = createExchangeStore(settings.EXCHANGES_DIR);
const authorisations = createAuthorisationStore(settings.AUTHORISATIONS_DIR);

// Relay-only keys: this process must not be able to act as the buyer or the
// seller even by accident. It relays an instruction they already signed.
const { coreSDK } = connect({ envKeys: RELAY_ONLY_ENV_KEYS });
const disputeHandler = coreSDK.contracts.disputeHandler;

const record = exchanges.read(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId}`);
  process.exit(1);
}
if (record.disputeRaisedAt != null) {
  console.error(`✗ exchange ${exchangeId} already has an open case`);
  process.exit(1);
}

if (!execute) {
  console.log(`would raise for exchange ${exchangeId} as the buyer — re-run with --execute`);
  process.exit(0);
}

const relay = async (stored) => {
  const tx = await coreSDK.relayMetaTransaction(
    {
      functionName: stored.functionName,
      functionSignature: stored.functionSignature,
      sigR: stored.r,
      sigS: stored.s,
      sigV: stored.v,
      nonce: stored.nonce,
    },
    { userAddress: stored.userAddress }
  );
  return tx.wait();
};

const confirm = async (stored) =>
  waitForState(
    async () => {
      const dispute = await disputeHandler.getDispute(stored.exchangeId);
      if (!dispute.exists) return null;
      return dispute.disputeDates.disputed.isZero() ? null : true;
    },
    { what: `raiseDispute to be recorded for exchange ${stored.exchangeId}` }
  );

await raiseFor({ exchangeId, by: "buyer", exchanges, authorisations, relay, confirm });
console.log(`✓ raised for exchange ${exchangeId}, attributed to the buyer`);
```

- [ ] **Step 7: Register the command**

In `package.json` scripts, after `"confirm"`:

```json
"raise": "node scripts/raise-dispute.mjs"
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the whole suite, including `test/disputes.test.mjs`

- [ ] **Step 9: Run it live against a seeded exchange**

```bash
npm run seed                       # note the exchangeId it prints
npm run raise -- <exchangeId>      # dry run first, no --execute
npm run raise -- <exchangeId> --execute
```

Expected: the record shows `disputeRaisedBy: "buyer"`, and the buyer-facing parcel line reads
**"Let's sort this out"** rather than "It hasn't arrived. We've raised this for you."

- [ ] **Step 10: Confirm nothing secret was committed, then commit**

```bash
git add -A
git diff --cached | grep -iE "0x[0-9a-f]{130}|mnemonic|PRIVATE_KEY" && echo "STOP" || echo "clean"
npm run lint
git commit -m "add the buyer-initiated raise and attribute disputes before relaying"
```

---

## Task 8: Run it on a real case

**Files:**
- Create: `scripts/mediate.mjs`, `fixtures/case/241.json`
- Modify: `package.json` (register `mediate`)

**Interfaces:**
- Consumes: everything above. This is the composition root — the only place where `callModel`,
  the recording store, the case store and the evidence sources are wired together.
- Produces: `npm run mediate -- <exchangeId> [--execute]`

> Without this task, Tasks 1–6 are libraries nothing calls. This is also the only place base64 is
> produced: photographs are read from disk here and handed to `callModel`, so a bundle and a
> recording never carry image bytes.

- [ ] **Step 1: Write the case fixture**

```json
{
  "exchangeId": "241",
  "photos": [
    { "id": "inner", "path": "fixtures/case/photos/inner-box.jpg", "media_type": "image/jpeg" }
  ],
  "messages": [
    { "from": "buyer",  "at": 1756300000000, "text": "Hi — is the box in good condition?" },
    { "from": "seller", "at": 1756300600000, "text": "Yes, stored in a cupboard since new." }
  ],
  "listing": {
    "title": "Four retired sets",
    "body": "Used - like new. Boxes in good condition.",
    "priceText": "200"
  }
}
```

⚠️ The message thread and the listing are **authored**, and the bundle marks them so. The
photographs and the tracking events are real. Nothing in this file may name a marketplace platform.

- [ ] **Step 2: Write the system prompt**

Create `fixtures/case/system.md`. **It carries the objective and the constraints; it carries no
case-specific rules.** A prompt that names the situation it expects has stopped being a mediator and
become a lookup table with a language model attached.

```markdown
You are assessing a dispute between a buyer and a seller over a parcel bought
from a stranger through a peer-to-peer marketplace listing. Their money is held
in escrow. Your task is to propose the division of that money which is most fair
on the evidence in front of you.

## What you may propose

One number: the buyer's share of the escrowed amount, from 0 to 100 per cent.
You cannot propose any other remedy — not a replacement, not a return, not a
deadline. There is nowhere to put one.

Your proposal settles nothing by itself. Both parties must agree to it, and
either may decline. You are proposing, not deciding.

## The evidence

Each item carries a provenance, and they are not worth the same:

- `carrier` — a tracking event as reported by an aggregator. It proves the
  parcel's movement and arrival. It is not signed by the carrier, and it says
  nothing about the condition of what arrived.
- `buyer` / `seller` — submitted by a party, and unverified. A photograph shows
  what it shows; it does not establish when it was taken.
- `listing` — how the item was described before purchase. This is what an
  inaccuracy is measured against.
- `chain` — read from the protocol. The only provenance that is settled.

Cite the evidence you rely on by its id, in `evidenceIds`. Never cite an id that
is not in the bundle.

## Asking for more

You always have a proposal. Ask for evidence only when you can say what the
answer would change: name the possible answers and the split each would imply.
If every answer leads to the same split, the question is not worth a party's
effort — do not ask it.

Write `whyItMatters` for the person being asked. It must explain why the evidence
is relevant **without** telling them which answer would favour them.

## When you cannot settle it

If the accounts genuinely conflict and no obtainable evidence would separate
them, say so with `cannot_settle`, and a person will decide. Do not use it merely
because the parties disagree — disagreement is the normal condition of a dispute.

## Your reasoning

`reasoning` is addressed to the two parties. It should read as a considered
account of why this division is fair, in plain language, referring to what you
actually relied on.
```

- [ ] **Step 3: Write the script**

```js
// scripts/mediate.mjs
// The composition root: the only place the pieces are wired together.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, ROOT } from "../src/env.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createStore } from "../src/store.mjs";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";
import { callModel } from "../src/model.mjs";
import { mediate } from "../src/mediator.mjs";
import { forParty } from "../src/proposal.mjs";

const [exchangeId, ...flags] = process.argv.slice(2);
const execute = flags.includes("--execute");
if (!exchangeId) {
  console.error("usage: npm run mediate -- <exchangeId> [--execute]");
  process.exit(1);
}

const settings = loadEnv({ required: ["EXCHANGES_DIR", "EVENTS_DIR"] });
const exchanges = createExchangeStore(settings.EXCHANGES_DIR);
const trackers = createStore(settings.EVENTS_DIR);
const cases = createCaseStore(join(ROOT, "state/cases"));
const recordings = createRecordingStore(join(ROOT, "fixtures/case/recordings"));

const record = exchanges.read(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId}`);
  process.exit(1);
}
// ⭐ The single trigger. Delivery state does not enter into it: what makes a
// case mediable is that a dispute exists, whoever raised it.
if (record.disputeRaisedAt == null) {
  console.error(`✗ exchange ${exchangeId} has no open case — nothing to mediate`);
  process.exit(1);
}

const caseInput = JSON.parse(readFileSync(join(ROOT, `fixtures/case/${exchangeId}.json`), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Read once: the bytes go to the model, the hash goes in the bundle.
const photos = caseInput.photos.map((p) => {
  const bytes = readFileSync(join(ROOT, p.path));
  return { id: null, path: p.path, media_type: p.media_type, sha256: sha256(bytes), base64: bytes.toString("base64") };
});

const bundle = assembleBundle({
  exchangeId,
  tracking: { events: trackers.read(record.trackerId)?.events ?? [] },
  offerTerms: { price: record.price, disputePeriodMs: record.disputePeriodMs },
  photos: photos.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
  messages: caseInput.messages,
  listing: caseInput.listing,
  viewer: "mediator",
});

// The bundle assigns the ids, so the image blocks are labelled with the same
// ids a finding will cite.
const byPath = new Map(bundle.items.filter((i) => i.kind === "photo").map((i) => [i.content.path, i.id]));
const attachments = photos.map((p) => ({ id: byPath.get(p.path), media_type: p.media_type, base64: p.base64 }));

const system = readFileSync(join(ROOT, "fixtures/case/system.md"), "utf8");

if (!execute && !recordings.find(bundle.hash)) {
  console.log(`bundle ${bundle.hash.slice(0, 12)} has no recording — re-run with --execute to call the model`);
  process.exit(0);
}

const client = new Anthropic();
const result = await mediate({
  bundle,
  record,
  now: Date.now(),
  deps: {
    call: ({ bundle: b, system: s, photos: ph, final }) =>
      callModel({ client, bundle: b, system: s, photos: ph, final }),
    recordings,
  },
  system,
  photos: attachments,
});

const existing = cases.read(exchangeId) ?? { exchangeId, rounds: [], model: null, closedAt: null, outcome: null };
cases.write({ ...existing, rounds: [...existing.rounds, result] });

console.log(result.replayed ? "· replayed from a recording" : "· called the model");
// ⚠️ forParty, always. wouldChange and provisional never reach a surface a
// party can read, and a console is a surface.
console.log(JSON.stringify(forParty(result), null, 2));
```

- [ ] **Step 4: Register the command**

In `package.json` scripts, after `"raise"`:

```json
"mediate": "node scripts/mediate.mjs"
```

- [ ] **Step 5: Run it against the real case**

```bash
npm run seed                              # note the exchangeId
npm run raise -- <exchangeId> --execute   # the buyer says something is wrong
npm run mediate -- <exchangeId> --execute
```

Expected: a `needs_evidence` result asking for the outer carton, printed **without** any
`wouldChange` or `provisional` key.

- [ ] **Step 6: Prove the second round changes the answer**

Add the carton photograph to `fixtures/case/<exchangeId>.json`, then:

```bash
npm run mediate -- <exchangeId> --execute
```

Expected: a different bundle hash, a `proposal`, and **a different number from the provisional
recorded in round one**. If it is the same number, the question was decoration — that is the result
to investigate, not to accept.

- [ ] **Step 7: Commit**

```bash
npm run lint
git add scripts/mediate.mjs fixtures/case package.json
git commit -m "run the mediator on a real case, recording each round"
```

---

## Self-review notes

**Spec coverage.** §2 bundle → Task 1. §2.3 visibility slot → Task 1 (`viewer` parameter, one value).
§2.4 hash → Task 1. §3 assembly sources → Task 1; §3.1 listing-in-metadata is design-only and
correctly has no task. §4.1 action space → Task 2 + Task 4's schema. §4.2 grounding → Task 2, retry
in Task 5. §4.3 consent → Task 4 (no `tools`) and Task 7 (the raise is the buyer acting). §4.4 clerk
isolation → Task 6. §5 the three variants → Task 2 and Task 4's schema. §5.1 sufficiency,
`wouldChange`/`provisional` → Task 2 bounds, Task 5 fallback, Task 2 `forParty`. §5.2 reasoning as a
field → Task 4's schema. §5.3 rounds, cap, deadline → Task 5. §6 clerk → Task 6. §7 replay → Tasks 3
and 5. §8 model call → Task 4. §1.1 trigger and the buyer-raise prerequisite → Task 7.

§8 model call → Task 4, and the system prompt → Task 8 Step 2. Composition → Task 8.

**Two gaps this review found and closed.** Tasks 1–6 originally produced libraries with no
composition root — nothing wired `callModel` into the mediator's `deps.call`, so there was no way to
run any of it on a real case; that is Task 8. And Task 8's script referenced a system prompt no task
created, which is now Step 2 of that task.

**Not covered by any task, deliberately:** the buyer's on-screen affordance for *"something is
wrong"*. `npm run raise` is the mechanism; the button belongs with the interface work, where the copy
lives.

**Known ordering constraint.** Tasks 7 and 8 are independent of Tasks 1–6 in code, but Task 7 is what
makes the mediator's principal case reachable and Task 8 is what runs it. They are last so the plan
ends with a case going end to end — a raise, a question, a photograph, and a different number.
