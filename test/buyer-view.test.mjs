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
            events: [], allowConfirm: true, ...over });

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
    caseRecord: { exchangeId: "241", rounds: [{ status: "needs_evidence",
      requests: [{ whoCanProvide: "buyer", what: "Can you photograph the outer shipping carton?" }] }] },
  });
  assert.equal(v.mediation.question, "Can you photograph the outer shipping carton?");
  assert.equal(v.actions.find((a) => a.id === ACTIONS.PHOTO).enabled, true);
});

// ⚠️ This action takes no operator setting at all, and that is the fix to two
// bugs in a row. First the client dropped it whenever no photograph was named,
// so a buyer reading "Can you photograph the outer shipping carton?" saw a
// question and no way to answer it. Then it was drawn disabled instead — still
// a question with no usable answer, now with an excuse under it. Which
// photograph is attached is a lookup in the rounds table and never a reason to
// refuse the press.
test("the photo action is enabled with no operator setting of any kind", () => {
  const v = viewFor({
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    tracking: tracking({ current: "delivered", delivered: true }),
    caseRecord: { exchangeId: "241", rounds: [{ status: "needs_evidence",
      requests: [{ whoCanProvide: "buyer", what: "Can you photograph the outer shipping carton?" }] }] },
    listing,
    events: [],
  });
  const photo = v.actions.find((a) => a.id === ACTIONS.PHOTO);
  assert.equal(photo.enabled, true);
  assert.equal(photo.reason, null);
});

test("mediation carries nothing the screen does not draw", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ status: "needs_evidence",
      requests: [{ whoCanProvide: "buyer", what: "Can you photograph the outer shipping carton?" }] }] },
  });
  assert.deepEqual(Object.keys(v.mediation).sort(), ["proposal", "question"]);
});

test("a proposal renders its amount and its reasoning, and settling is not yet available", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
    caseRecord: { exchangeId: "241", rounds: [{ status: "proposal",
      buyerPercent: 20, reasoning: "The carton is intact." }] },
  });
  assert.equal(v.mediation.proposal.refund, "£40");
  assert.equal(v.mediation.proposal.reasoning, "The carton is intact.");
  const settle = v.actions.find((a) => a.id === ACTIONS.SETTLE);
  assert.equal(settle.enabled, false);
  assert.equal(settle.label, "That works for me");
  const decline = v.actions.find((a) => a.id === ACTIONS.DECLINE);
  assert.equal(decline.enabled, false);
  assert.equal(decline.reason, "Declining isn't available yet");
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
    caseRecord: { exchangeId: "241", rounds: [{ status: "proposal",
      buyerPercent: 33.3, reasoning: "The carton is crushed." }] },
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
    // A proposal: exercises the settle/decline `reason` strings too.
    view({
      tracking: tracking({ current: "delivered", delivered: true }),
      record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }),
      caseRecord: { exchangeId: "241", rounds: [{ status: "proposal",
        buyerPercent: 20, reasoning: "The carton is intact." }] },
    }),
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

// --- the evidence the buyer has already sent --------------------------------
// ⭐ This block exists because "Add a photo" wrote a file nothing on screen
// drew: the press answered 200, the store changed, and the model that came
// back was identical to the one already rendered. These pin the field that
// makes the press visible.

const inDispute = { disputeRaisedAt: 1, disputeRaisedBy: "buyer" };
const withPhotos = (photos, over = {}) =>
  view({ record: record(inDispute), photos, ...over });

test("one photograph reads as one, and more than one is counted", () => {
  assert.equal(withPhotos([{ id: "inner" }]).evidence.summary, "1 photo added");
  assert.equal(withPhotos([{ id: "inner" }, { id: "carton" }]).evidence.summary, "2 photos added");
});

test("each photograph is located by its position, and nothing else about it reaches the model", () => {
  const evidence = withPhotos([{ id: "inner", path: "fixtures/case/photos/inner.jpg" }]).evidence;
  assert.deepEqual(evidence.photos, ["/api/purchases/241/photos/0"]);
  assert.equal(evidence.alt, "A photo you added");
  assert.deepEqual(Object.keys(evidence).sort(), ["alt", "photos", "summary"]);
  assert.ok(!JSON.stringify(evidence).includes("inner.jpg"), "a path must not reach the model");
});

test("no case, no evidence — and an empty list is not a block with nothing in it", () => {
  assert.equal(view({ photos: [{ id: "inner" }] }).evidence, null, "not in dispute");
  assert.equal(withPhotos([]).evidence, null, "in dispute with nothing sent");
});

test("evidence does not survive settlement, because the money line is the answer by then", () => {
  const settled = view({
    record: record({ ...inDispute, finalisedAt: 1, outcome: "split", buyerPercent: 20 }),
    photos: [{ id: "inner" }],
  });
  assert.equal(settled.evidence, null);
});

// ⭐ The list of purchases draws the parcel line, and adds the money line only
// when `tone` is not "held" — because "Your money is held" is true of every
// unfinished purchase and distinguished none of them. So "held" is the tone of
// every state that has not finished, and each ending has its own: that is what
// the list branches on, and it is pinned here rather than left to the one
// assertion `split` happened to have.
test("only a finished purchase carries a tone other than held", () => {
  const open = [
    view(),
    view({ tracking: tracking({ current: "delivered", delivered: true }) }),
    view({ record: record({ disputeRaisedAt: 1, disputeRaisedBy: "buyer" }) }),
    view({ record: record({ disputeRaisedAt: 1, disputeRaisedBy: "watchdog", escalatedAt: 2 }) }),
    // An outcome the module does not recognise is not an ending either.
    view({ record: record({ outcome: "something else" }) }),
  ];
  for (const v of open) assert.equal(v.money.tone, "held");

  for (const [outcome, tone] of [["paid", "paid"], ["returned", "returned"], ["split", "split"]]) {
    const v = view({ record: record({ finalisedAt: 1, outcome, buyerPercent: 20 }) });
    assert.equal(v.money.tone, tone);
  }
});

// --- the dates the buyer reads ----------------------------------------------
// ⭐ The deadline notice is the only warning the buyer gets, and inaction pays
// the seller — so a wrong date here is the one copy error on this screen that
// costs them money. These cover both ways it used to be wrong.

test("a record with no redemption instant states no deadline rather than a wrong one", () => {
  // src/exchanges.mjs permits a null redeemedAt and does not validate what it
  // reads. `null + 17 days` is a number, not an error, so this rendered "The
  // seller is paid on 18 January" — a confident date from a record that holds
  // none.
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ redeemedAt: null }),
  });
  assert.equal(v.notice, null);
  // The actions are unaffected: the deadline is unstated, not the purchase.
  assert.deepEqual(v.actions.map((a) => a.id), [ACTIONS.COMPLETE, ACTIONS.RAISE]);
});

test("a record with no dispute period states no deadline either", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({ disputePeriodMs: null }),
  });
  assert.equal(v.notice, null);
});

// ⚠️ Read against the buyer's calendar, not UTC. This instant is 00:30 on the
// 19th in London and 23:30 on the 18th in UTC, and telling a buyer to act by
// the 18th when their own clock says the 19th is a day early on the one line
// that matters. Pinned to a fixed zone rather than the machine's, so this
// asserts the same thing wherever it runs.
test("a deadline just past midnight reads as the day the buyer's calendar shows", () => {
  const v = view({
    tracking: tracking({ current: "delivered", delivered: true }),
    record: record({
      redeemedAt: Date.parse("2026-09-01T23:30:00Z"),
      disputePeriodMs: 17 * 86_400_000,
    }),
  });
  assert.match(v.notice, /^The seller is paid on 19 September\./);
});

// ⚠️ The other side of that split, and the reason the two formatters are two.
// A carrier's stamp is shifted by its own offset so that reading it as UTC
// gives the time printed on the scan; passing it through the buyer's zone as
// well would add the offset twice — moving this entry onto the 19th while the
// clock beside it went on saying 23:30.
test("a late-evening scan keeps its own date beside its own clock", () => {
  const v = view({ events: [{ occurrenceDatetime: "2026-09-18T23:30:00+01:00", status: "Out for Delivery" }] });
  assert.deepEqual(v.timeline, ["18 September, 23:30 · Out for Delivery"]);
});
