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
  const decline = v.actions.find((a) => a.id === ACTIONS.DECLINE);
  assert.equal(decline.enabled, false);
  assert.equal(decline.reason, "Declining isn't available yet");
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
      caseRecord: { exchangeId: "241", rounds: [{ result: { status: "proposal",
        buyerPercent: 20, reasoning: "The carton is intact." } }] },
    }),
    // A split ending.
    view({ record: record({ finalisedAt: 1, outcome: "split", buyerPercent: 20 }) }),
  ];

  for (const v of states) {
    const texts = [v.money.text, v.money.meta, v.parcel.text, v.notice, ...v.actions.flatMap((a) => [a.label, a.reason])];
    for (const text of texts) {
      if (text == null) continue;
      assert.ok(known.some((k) => text.includes(k.trim())), `"${text}" is not built from BUYER_STRINGS`);
    }
  }
});
