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
            events: [], allowConfirm: true, allowPhoto: true, allowSettle: true, ...over });

test("ACTIONS.PHOTO is the literal route segment the client posts to", () => {
  // Pinned as a literal, not compared against itself: every other test refers
  // to ACTIONS.PHOTO symbolically, so a regression to "photo" — the original,
  // 404-causing value — would pass the whole suite except this one line.
  assert.equal(ACTIONS.PHOTO, "photos");
});

test("item carries the listing's title and price, and a priceless listing states no price", () => {
  const withPrice = view();
  assert.equal(withPrice.item.title, "Four retired sets");
  assert.equal(withPrice.item.price, "£200 · from a stranger");

  const noPrice = view({ listing: { title: "Four retired sets", priceText: null, currency: "£" } });
  assert.equal(noPrice.item.title, "Four retired sets");
  assert.equal(noPrice.item.price, "");
});

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
  assert.equal(complete.reason, "This isn't available right now");
});

// I-4: a raw machine timestamp used to reach the screen verbatim —
// "2026-08-30T09:13:31+01:00 · Out for Delivery", on the same screen as "The
// seller is paid on 19 September". Every date the buyer reads goes through the
// one formatter, and the join between the two halves is copy like any other.
test("a timeline entry states its date the way every other date on the screen does", () => {
  const v = view({ events: [
    { occurrenceDatetime: "2026-08-29T18:02:00+01:00", status: "Shipment Received" },
    { occurrenceDatetime: "2026-08-30T09:13:31+01:00", status: "Out for Delivery" },
  ] });
  assert.deepEqual(v.timeline, [
    "30 August, 09:13 · Out for Delivery",
    "29 August, 18:02 · Shipment Received",
  ]);
});

test("an event carrying only the UTC-labelled local datetime is not shown at all", () => {
  // `datetime` is local time labelled as UTC, so reading it would state a time
  // that is wrong by the offset. Nothing here falls back to it.
  const v = view({ events: [{ datetime: "2026-08-30T09:13:31.000Z", status: "Out for Delivery" }] });
  assert.equal(v.timeline, null);
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

// I-5: the client used to drop the photo action whenever the operator had not
// named a photograph, while the model said it was enabled — so a buyer reading
// "Can you photograph the outer shipping carton?" saw a question and no way to
// answer it. Whether a photograph is on offer is an input to the model, like
// the operator's arming of completion, and the client draws what it is told.
test("with no photograph on offer the action is still drawn, disabled and truthful", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ result: { status: "needs_evidence",
      requests: [{ to: "buyer", asks: "Can you photograph the outer shipping carton?" }] } }] },
    allowPhoto: false,
  });
  const photo = v.actions.find((a) => a.id === ACTIONS.PHOTO);
  assert.equal(photo.enabled, false);
  assert.equal(photo.reason, "Adding a photo isn't available right now");
});

test("mediation carries nothing the screen does not draw", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ result: { status: "needs_evidence",
      requests: [{ to: "buyer", asks: "Can you photograph the outer shipping carton?" }] } }] },
  });
  assert.deepEqual(Object.keys(v.mediation).sort(), ["proposal", "question"]);
});

const proposal = (over = {}) => ({
  tracking: tracking({ current: "delivered", delivered: true }),
  record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
  caseRecord: { exchangeId: "241", rounds: [{ result: { status: "proposal",
    buyerPercent: 20, reasoning: "The carton is intact." } }] },
  ...over,
});

test("a proposal renders its amount and its reasoning, and accepting is offered", () => {
  const v = view(proposal());
  assert.equal(v.mediation.proposal.refund, "£40");
  assert.equal(v.mediation.proposal.reasoning, "The carton is intact.");
  const settle = v.actions.find((a) => a.id === ACTIONS.SETTLE);
  assert.equal(settle.enabled, true);
  assert.equal(settle.label, "That works for me");
  assert.equal(settle.reason, null);
});

// The operator's arming, exactly as completing renders it: an action the
// operator has not armed is drawn disabled with a neutral reason, never hidden
// and never a name the buyer has to understand.
test("an unarmed operator leaves accepting disabled, and says so neutrally", () => {
  const settle = view(proposal({ allowSettle: false })).actions.find((a) => a.id === ACTIONS.SETTLE);
  assert.equal(settle.enabled, false);
  assert.equal(settle.reason, "Accepting isn't available right now");
  assert.ok(!settle.reason.includes("BUYER_UI"));
});

// ⭐ Declining is not a chain call and is deliberately not a button. The
// proposal is inert: it settles only if the buyer accepts, and if they do not,
// the resolution window runs down and a person takes the case. The reason says
// that, rather than promising a control that is coming.
test("declining stays disabled, and its reason states what happens instead", () => {
  for (const armed of [true, false]) {
    const decline = view(proposal({ allowSettle: armed })).actions.find((a) => a.id === ACTIONS.DECLINE);
    assert.equal(decline.enabled, false);
    assert.equal(decline.reason, "If this isn't right, don't accept — a person will look at it.");
  }
});

// Promoted minor 4: the proposal's amount and the settled refund are the two
// money figures a buyer sees on consecutive screens of one dispute, and they
// were formatted by two byte-identical copies of the same function. One
// function now, so they cannot drift apart.
test("a proposal's amount and the ending it settles to are formatted identically", () => {
  const disputed = { disputeRaisedAt: 1, disputeRaisedBy: "buyer" };
  const proposal = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record(disputed),
    caseRecord: { exchangeId: "241", rounds: [{ result: { status: "proposal",
      buyerPercent: 33.3, reasoning: "The carton is crushed." } }] },
  });
  const settled = view({ record: record({ finalisedAt: 1, outcome: "split", buyerPercent: 33.3 }) });
  assert.equal(proposal.mediation.proposal.refund, "£66.60");
  assert.equal(settled.money.text, "£66.60 has come back to you.");
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

test("a split settlement's screen no longer contradicts itself", () => {
  // The bug this guards: money said settled, the parcel line still invited
  // the buyer into a process that was over ("Let's sort this out").
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", finalisedAt: 2, outcome: "split", buyerPercent: 20 }),
  });
  assert.equal(v.money.text, "£40 has come back to you.");
  assert.equal(v.parcel.key, "arrived");
  assert.equal(v.parcel.text, "It arrived");
});

test("an escalated exchange that finalises stops claiming a person is still looking at it", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer", escalatedAt: 2, finalisedAt: 3, outcome: "paid", buyerPercent: 0 }),
  });
  assert.notEqual(v.parcel.key, "with_a_person");
  assert.equal(v.parcel.key, "arrived");
});

test("a watchdog-raised dispute still reads as raised for you once the exchange finalises", () => {
  const v = view({
    tracking: tracking(),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "watchdog", finalisedAt: 2, outcome: "returned", buyerPercent: 100 }),
  });
  assert.equal(v.parcel.key, "raised_for_you");
  assert.equal(v.parcel.text, "It hasn't arrived. We've raised this for you.");
});

test("each settled money state renders its second line, with the exact spec copy", () => {
  const paid = view({
    record: record({ finalisedAt: Date.parse("2026-09-19T00:00:00Z"), outcome: "paid", buyerPercent: 0 }),
  });
  assert.equal(paid.money.meta, "£200 · 19 September");

  const returned = view({ record: record({ finalisedAt: 1, outcome: "returned", buyerPercent: 100 }) });
  assert.equal(returned.money.meta, "£200 · back to you");

  const split = view({ record: record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }) });
  assert.equal(split.money.meta, "The seller has been paid the rest.");
});

test("held renders no second line", () => {
  assert.equal(view().money.meta, null);
});

// I-1: an action that fails leaves the buyer with nothing on screen — and
// "Something's wrong" is the only protection a buyer with a damaged parcel
// has, so silence there is the worst place for it. public/held.js cannot
// compose that sentence itself (no string reaches the screen except through
// BUYER_STRINGS), so the model carries it.
test("the model carries the copy for an action that did not go through", () => {
  assert.equal(view().actionFailed, "That didn't go through. Have another go.");
});

test("⭐ every string the view emits — labels and reasons alike — comes from BUYER_STRINGS", async () => {
  const { BUYER_STRINGS } = await import("../src/buyer-state.mjs");
  // Placeholders are filled by the time they reach here, so compare on the
  // literal segments a template is made of rather than on the template.
  const known = Object.values(BUYER_STRINGS).flatMap((s) => s.split(/\{\w+\}/).filter((p) => p.trim().length > 2));

  const states = [
    // Delivered, undisputed, and unarmed: this is the exact state that let a
    // raw literal reach `reason` undetected before — the earlier version of
    // this test only ever looked at `label`, never `reason`.
    view({ tracking: tracking({ current: "delivered", delivered: true }), allowConfirm: false }),
    // A proposal, armed and unarmed: exercises the settle and decline
    // `reason` strings, which is where a raw literal would hide.
    view(proposal()),
    view(proposal({ allowSettle: false })),
    // A split ending.
    view({ record: record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }) }),
  ];

  for (const v of states) {
    const texts = [v.money.text, v.money.meta, v.parcel.text, v.notice, v.actionFailed,
      ...v.actions.flatMap((a) => [a.label, a.reason])];
    for (const text of texts) {
      if (text == null) continue;
      assert.ok(known.some((k) => text.includes(k.trim())), `"${text}" is not built from BUYER_STRINGS`);
    }
  }
});
