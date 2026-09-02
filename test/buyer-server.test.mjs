// test/buyer-server.test.mjs
// Request-level, as the receiver is tested: routes, guards, malformed input —
// through createApp() directly, with fake stores, so nothing here needs a
// port, a socket, or the chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/buyer-server.mjs";
import { createCaseInputStore, UnknownPhotoError } from "../src/case-input.mjs";

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

// ⚠️ Every request carries headers, because handle() now reads two of them
// before it routes anything: a browser always sends Host, and sends Origin on
// every cross-origin request. The default here is what this machine's own page
// sends; the guard tests below override it.
const call = (handler, method, url, body = null, headers = {}) =>
  new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) { if (chunk) chunks.push(chunk); resolve({ status: this.statusCode, body: chunks.join("") }); },
      write(chunk) { chunks.push(chunk); },
    };
    const req = {
      method, url,
      headers: { host: "127.0.0.1:3100", ...headers },
      on(event, fn) { if (event === "end") fn(); if (event === "data" && body) fn(body); },
    };
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

// Task 6c: opening the photo-evidence route. The action callables widen from
// ({ exchangeId }) to ({ exchangeId, body }), and the server itself reads and
// validates the small JSON body before an action ever sees it — an unwired or
// throwing action must never be reachable through a body the server should
// have refused first.

test("a valid photos body is read and passed to the action as { exchangeId, body }", async () => {
  let received = null;
  const res = await call(
    app({ actions: { photos: async (args) => { received = args; return {}; } } }),
    "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "carton" }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(received, { exchangeId: "241", body: { photo: "carton" } });
});

test("a non-JSON photos body is 400, and the action is never called", async () => {
  let called = false;
  const res = await call(
    app({ actions: { photos: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/photos", "not json at all",
  );
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test("a photos body missing the photo key is 400, and the action is never called", async () => {
  let called = false;
  const res = await call(
    app({ actions: { photos: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/photos", JSON.stringify({ nope: true }),
  );
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test("an oversized photos body is refused before the action runs", async () => {
  let called = false;
  const oversized = JSON.stringify({ photo: "x".repeat(10_000) });
  const res = await call(
    app({ actions: { photos: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/photos", oversized,
  );
  assert.equal(res.status, 413);
  assert.equal(called, false);
});

test("an unknown photo id raised by the action answers 404, not 500", async () => {
  const res = await call(
    app({ actions: { photos: async () => { throw new UnknownPhotoError("does-not-exist"); } } }),
    "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "does-not-exist" }),
  );
  assert.equal(res.status, 404);
});

// End to end: the real store wired exactly as the entry point wires it, not a
// fake action — this is what proves the route is reachable, not just each
// piece in isolation. `seed`, when given, is written as <dir>/<id>.json before
// the store is created — a pre-existing case input, the same as a real one.
function realPhotosApp({ seed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "held-buyer-photos-"));
  mkdirSync(join(dir, "photos"), { recursive: true });
  writeFileSync(join(dir, "photos", "carton.jpg"), "fixture");
  writeFileSync(join(dir, "photos", "carton-crushed.jpg"), "fixture");
  if (seed) writeFileSync(join(dir, `${seed.exchangeId}.json`), JSON.stringify(seed, null, 2));
  const caseInput = createCaseInputStore(dir);
  const handler = app({
    actions: { photos: ({ exchangeId, body }) => caseInput.addPhoto(exchangeId, body.photo) },
  });
  return { handler, caseInput };
}

// The 238-shaped record fixtures/case/238.json actually carries: id "carton"
// already names carton-crushed.jpg, not a file called "carton". A test that
// only ever starts from an empty photos array can never see the bug this
// causes — see fix round 1, item 2.
const seed238 = {
  exchangeId: "238",
  photos: [
    { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
    { id: "carton", path: "fixtures/case/photos/carton-crushed.jpg", media_type: "image/jpeg" },
  ],
};

test("end to end: attaching a photograph appends it and answers 200", async () => {
  const { handler, caseInput } = realPhotosApp();
  const res = await call(handler, "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "carton" }));
  assert.equal(res.status, 200);
  assert.deepEqual(caseInput.read("241").photos, [
    { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  ]);
});

test("end to end: attaching the same photograph twice leaves one entry, still 200", async () => {
  const { handler, caseInput } = realPhotosApp();
  const first = await call(handler, "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "carton" }));
  const second = await call(handler, "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "carton" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(caseInput.read("241").photos.length, 1);
});

test("end to end: attaching a branch already present under a different id does not duplicate it", async () => {
  const { handler, caseInput } = realPhotosApp({ seed: seed238 });
  const res = await call(
    handler, "POST", "/api/purchases/238/photos", JSON.stringify({ photo: "carton-crushed" }),
  );
  assert.equal(res.status, 200);
  assert.equal(caseInput.read("238").photos.length, 2);
});

test("end to end: a different branch photograph can still be attached even though its slot id is taken", async () => {
  const { handler, caseInput } = realPhotosApp({ seed: seed238 });
  const res = await call(handler, "POST", "/api/purchases/238/photos", JSON.stringify({ photo: "carton" }));
  assert.equal(res.status, 200);
  const photos = caseInput.read("238").photos;
  assert.equal(photos.length, 3);
  assert.ok(photos.some((p) => p.path === "fixtures/case/photos/carton.jpg"));
});

test("end to end: a traversal attempt is 404 and writes nothing", async () => {
  const { handler, caseInput } = realPhotosApp();
  const res = await call(
    handler, "POST", "/api/purchases/241/photos", JSON.stringify({ photo: "../../etc/passwd" }),
  );
  assert.equal(res.status, 404);
  assert.equal(caseInput.read("241"), null);
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

// --- who is calling ----------------------------------------------------------
// ⚠️ Loopback is not a security boundary: this port is reachable from every
// page in this buyer's browser, and a POST with no body and no custom header
// triggers no preflight, so CORS never intervenes — it hides the response, not
// the request. Completing pays the seller and forfeits the dispute right, so
// the one thing every guard below establishes is that the request came from
// this view's own page.

test("a POST carrying a foreign Origin is refused, and the action is never called", async () => {
  let called = false;
  const res = await call(
    app({ allowConfirm: true, actions: { complete: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/complete", null,
    { origin: "https://an-unrelated-page.example" },
  );
  assert.equal(res.status, 403);
  assert.equal(called, false, "an armed server must not pay a seller for another page");
});

test("a POST from the view's own page still completes", async () => {
  for (const origin of ["http://127.0.0.1:3100", "http://localhost:3100"]) {
    let called = false;
    const res = await call(
      app({ allowConfirm: true, actions: { complete: async () => { called = true; return {}; } } }),
      "POST", "/api/purchases/241/complete", null,
      { origin, host: origin.slice("http://".length) },
    );
    assert.equal(res.status, 200, `${origin} is this server's own page`);
    assert.equal(called, true);
  }
});

test("a sandboxed page's null Origin is a foreign origin, not an absent one", async () => {
  let called = false;
  const res = await call(
    app({ allowConfirm: true, actions: { complete: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/complete", null, { origin: "null" },
  );
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("a request whose Host is not loopback is refused, whatever it asks for", async () => {
  // DNS rebinding: a name the attacker controls resolves to 127.0.0.1, so the
  // request arrives here with their Host and no Origin at all.
  const rebound = { host: "held.attacker.example:3100" };
  assert.equal((await call(app(), "GET", "/api/purchases/241", null, rebound)).status, 403);
  assert.equal((await call(app(), "GET", "/", null, rebound)).status, 403);

  let called = false;
  const res = await call(
    app({ allowConfirm: true, actions: { complete: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/complete", null, rebound,
  );
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("a request with no Host at all is refused rather than trusted", async () => {
  const res = await call(app(), "GET", "/api/purchases/241", null, { host: undefined });
  assert.equal(res.status, 403);
});

test("the refusal says who was refused, and never buyer copy", async () => {
  const res = await call(app(), "GET", "/api/purchases/241", null, { host: "held.attacker.example" });
  const body = JSON.parse(res.body);
  assert.match(body.error, /loopback|its own page/i);
});

// Promoted minor 1: defence in depth on the one irreversible action. The entry
// point wires `complete` into `actions` only when the operator armed the
// server, so an unarmed one has no completion to reach even if the guard in
// run() were ever bypassed — it answers 501 because there is nothing there.
test("a server with no completion wired cannot complete, armed or not", async () => {
  const armed = app({ allowConfirm: true, actions: { raise: async () => ({}) } });
  assert.equal((await call(armed, "POST", "/api/purchases/241/complete")).status, 501);
});

test("anything else is 404", async () => {
  assert.equal((await call(app(), "GET", "/api/nope")).status, 404);
  assert.equal((await call(app(), "POST", "/api/purchases/241/pay")).status, 404);
});
