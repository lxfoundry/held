// test/buyer-server.test.mjs
// Request-level, as the receiver is tested: routes, guards, malformed input —
// through createApp() directly, with fake stores, so nothing here needs a
// port, a socket, or the chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/buyer-server.mjs";

const listing = { title: "Four retired sets", priceText: "200", currency: "£" };

// ⚠️ Ruling 1: trackerId is required for the fixture to reach the delivered
// branch at all. Without it record.trackerId is falsy, trackers.read() is
// never called, tracking stays null, and the parcel line can never read
// "It arrived" — which is exactly what the tests below assert.
const record = { exchangeId: "241", trackerId: "t1", redeemedAt: 0, disputePeriodMs: 17 * 86_400_000,
  resolutionPeriodMs: 7 * 86_400_000, disputeRaisedAt: null, disputeRaisedBy: null,
  disputeTimeoutAt: null, escalatedAt: null, finalisedAt: null, outcome: null,
  buyerPercent: null, authorisations: [] };

const app = (over = {}) => createApp({
  exchanges: { get: () => record, all: () => [record] },
  trackers: { read: () => ({ state: { current: "delivered", delivered: true }, events: [] }) },
  cases: { read: () => null },
  // The real listing reader parses fixtures/case/<id>.json whole — see
  // scripts/mediate.mjs, which reads the same file and destructures
  // .listing, .photos and .messages off it. modelFor() reads `input.listing`,
  // so the fake must return that shape too, or every purchase looks like it
  // has no listing and the tests below would never reach the code they exist
  // to exercise.
  listings: { read: () => ({ listing }) },
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
  // BUYER_STRINGS.held (src/buyer-state.mjs, Task 1) is the full sentence —
  // the brief's literal here was a truncated stand-in for it.
  assert.equal(view.money.text, "Your money is held. The seller can't touch it.");
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

// Fix round 1, item 1: exchanges.all() throwing is one failure mode (covered
// above); a single record's own tracker or case read throwing is another, and
// spec §11 requires the same outcome — that purchase is omitted, the rest of
// the list survives.
test("a bad tracker snapshot for one purchase doesn't blank the whole list", async () => {
  const good = { ...record, exchangeId: "241", trackerId: "t1" };
  const bad = { ...record, exchangeId: "999", trackerId: "corrupt" };
  const res = await call(
    app({
      exchanges: { get: (id) => (id === "241" ? good : bad), all: () => [good, bad] },
      trackers: {
        read: (trackerId) => {
          if (trackerId === "corrupt") throw new Error("snapshot exists but could not be read");
          return { state: { current: "delivered", delivered: true }, events: [] };
        },
      },
    }),
    "GET", "/api/purchases"
  );
  assert.equal(res.status, 200);
  const list = JSON.parse(res.body);
  assert.equal(list.length, 1, "the one good record must still be rendered");
  assert.equal(list[0].exchangeId, "241");
});

// Fix round 1, item 2: an action nobody has wired (photos, today) must not
// look like a broken server. actions.photos is absent from the fixture, same
// as in the real entry point.
test("an unwired action answers 501, not 500", async () => {
  const res = await call(app(), "POST", "/api/purchases/241/photos");
  assert.equal(res.status, 501);
});

// Fix round 1, item 4: run()'s promise is never awaited by handle(), so a
// rejection run() cannot itself turn into a response — a non-Error thrown
// value makes `err.message` throw a second time inside the catch block —
// must still resolve the request rather than leave the poll hanging.
test("a non-error rejection from an action still answers, rather than hanging the request", async () => {
  const res = await call(
    app({ allowConfirm: true, actions: { complete: async () => { throw null; } } }),
    "POST", "/api/purchases/241/complete"
  );
  assert.equal(res.status, 500);
});

test("anything else is 404", async () => {
  assert.equal((await call(app(), "GET", "/api/nope")).status, 404);
  assert.equal((await call(app(), "POST", "/api/purchases/241/pay")).status, 404);
});
