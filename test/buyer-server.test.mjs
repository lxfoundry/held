// test/buyer-server.test.mjs
// Request-level, as the receiver is tested: routes, guards, malformed input —
// through createApp() directly, with fake stores, so nothing here needs a
// port, a socket, or the chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/buyer-server.mjs";
import { createCaseInputStore, UnknownPhotoError } from "../src/case-input.mjs";
import { applyPhotos } from "../src/case-fixture.mjs";
import { ROOT } from "../src/env.mjs";

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
      end(chunk) {
        if (chunk) chunks.push(chunk);
        // ⚠️ Kept as bytes as well as text: the photograph route answers with
        // a Buffer, and joining those as strings would decode JPEG bytes as
        // UTF-8 and compare equal to nothing.
        const bytes = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))));
        resolve({ status: this.statusCode, body: bytes.toString("utf8"), bytes, headers: this.headers });
      },
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

// ⚠️ Settling splits the escrowed pot irreversibly, so it is armed separately
// from completing rather than riding on it: an operator may well want one and
// not the other.
test("settling is refused unless the operator armed it, and the action is never reached", async () => {
  let called = false;
  const res = await call(
    app({ actions: { settle: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/settle"
  );
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("an armed server settles and answers the view it rendered", async () => {
  let called = false;
  const res = await call(
    app({ allowSettle: true, actions: { settle: async () => { called = true; return {}; } } }),
    "POST", "/api/purchases/241/settle"
  );
  assert.equal(res.status, 200);
  assert.equal(called, true);
});

// ⭐ The one failure this whole path exists to prevent: a refusal must never
// reach the client as a success. Every way settling can refuse — no consent,
// a consent at another split, an exchange already finalised — arrives here as
// a rejected promise, and the client renders "that didn't go through".
test("a refused settlement is never reported as a success", async () => {
  const refuse = async () => { throw new Error("no consent is held for exchange 241"); };
  const res = await call(
    app({ allowSettle: true, actions: { settle: refuse } }),
    "POST", "/api/purchases/241/settle"
  );
  assert.notEqual(res.status, 200);
  assert.equal(res.status, 500);
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

test("a photos body naming no photograph runs the action, which takes the default", async () => {
  // ⭐ The ordinary press. The buyer names nothing, so the action is called
  // with nothing and src/case-input.mjs takes the first photograph the rounds
  // declare — the branch is a lookup, never a question put to the buyer.
  let named;
  const res = await call(
    app({ actions: { photos: async ({ body }) => { named = body?.photo ?? null; return {}; } } }),
    "POST", "/api/purchases/241/photos", JSON.stringify({}),
  );
  assert.equal(res.status, 200);
  assert.equal(named, null);
});

test("a photos body whose photo is present but unusable is 400, and the action is never called", async () => {
  // Absent means "take the default"; present-but-empty is a caller that meant
  // to name one and did not, and is told so rather than quietly given it.
  let called = false;
  for (const bad of [{ photo: "" }, { photo: 7 }, { photo: null }]) {
    const res = await call(
      app({ actions: { photos: async () => { called = true; return {}; } } }),
      "POST", "/api/purchases/241/photos", JSON.stringify(bad),
    );
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
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
// fake action — this is what proves the route is reachable, not just each piece
// in isolation.
//
// ⚠️ The temporary directory is seeded with case text, never with a re-serialised
// object, and fixtures/case/ itself is never written to. The store's write is a
// replacement over one region of that text, so a seed with tidied formatting
// would exercise a shape no real case input has.
const committed = readFileSync(join(ROOT, "fixtures/case/241.json"), "utf8");
const opening = applyPhotos(committed, 1);
// The same case with its outer-carton slot already filled by the other branch.
// src/case-fixture.mjs's PHOTOS table gives `carton` and `carton-crushed` the
// same id — "carton" — because the outer carton is one evidence slot and the two
// photographs are two branches competing for it. Two tests below turn on that.
const otherBranch = applyPhotos(committed, "2b");

function realPhotosApp(seed = opening) {
  const dir = mkdtempSync(join(tmpdir(), "held-buyer-photos-"));
  writeFileSync(join(dir, "241.json"), seed);
  const caseInput = createCaseInputStore(dir);
  const handler = app({
    actions: { photos: ({ exchangeId, body }) => caseInput.addPhoto(exchangeId, body.photo) },
  });
  const written = () => readFileSync(join(dir, "241.json"), "utf8");
  return { handler, caseInput, written };
}

const addPhoto = (handler, photo, id = "241") =>
  call(handler, "POST", `/api/purchases/${id}/photos`, JSON.stringify({ photo }));

test("end to end: attaching a photograph writes it and answers 200", async () => {
  const { handler, caseInput } = realPhotosApp();
  const res = await addPhoto(handler, "carton");
  assert.equal(res.status, 200);
  assert.deepEqual(caseInput.read("241").photos, [
    { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
    { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  ]);
});

// ⭐ The property the route must not break, asserted through the route itself.
// The committed file is the form a case stands in once the photograph has been
// added, so pressing this on the opening round has to reproduce it byte for byte
// — not merely the same data. A route that re-serialised the record would move
// every message and the listing too, and test/case-fixture.test.mjs's inverse
// property would stop holding the first time a buyer used it.
test("end to end: the route leaves the case in the committed form, byte for byte", async () => {
  const { handler, written } = realPhotosApp();
  const res = await addPhoto(handler, "carton");
  assert.equal(res.status, 200);
  assert.equal(written(), committed);
  // The guarantees test/case-fixture.test.mjs makes about the committed file,
  // made about the file the route produced.
  assert.equal(applyPhotos(written(), 2), written());
  assert.equal(applyPhotos(applyPhotos(written(), 1), 2), written());
});

test("end to end: attaching the same photograph twice leaves the file untouched, still 200", async () => {
  const { handler, written } = realPhotosApp();
  const first = await addPhoto(handler, "carton");
  const after = written();
  const second = await addPhoto(handler, "carton");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(written(), after);
});

// The rule a path-keyed dedup used to defend, now answered structurally and
// confirmed by the PHOTOS table above: both branches carry the id "carton", so
// treating that id as the identity of "already here" would block the intact
// carton from ever reaching a case the crushed one had filled.
test("end to end: the other branch fills the taken slot rather than being blocked by it", async () => {
  const { handler, caseInput } = realPhotosApp(otherBranch);
  const res = await addPhoto(handler, "carton");
  assert.equal(res.status, 200);
  assert.deepEqual(
    caseInput.read("241").photos.map((p) => p.path),
    ["fixtures/case/photos/inner.jpg", "fixtures/case/photos/carton.jpg"],
  );
});

// The other half of the same rule: one slot, so the branch already in it is not
// joined by its opposite. A case holding both an intact and a crushed outer
// carton is evidence that contradicts itself.
test("end to end: attaching the branch already in the slot changes nothing", async () => {
  const { handler, written } = realPhotosApp(otherBranch);
  const res = await addPhoto(handler, "carton-crushed");
  assert.equal(res.status, 200);
  assert.equal(written(), otherBranch);
});

// ⚠️ Never a 200. A photograph is added to a case that exists; a case input
// written by this action alone would hold photographs and neither the listing
// nor the message thread, and the buyer's screen would report an action that
// wrote nothing anyone reads as having gone through.
test("end to end: a purchase with no case input is refused rather than given one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "held-buyer-photos-"));
  const caseInput = createCaseInputStore(dir);
  const handler = app({
    actions: { photos: ({ exchangeId, body }) => caseInput.addPhoto(exchangeId, body.photo) },
  });
  const res = await addPhoto(handler, "carton");
  // 404, pinned: there is no case here to add to. A 500 would report a
  // broken component for a request that was about something absent.
  assert.equal(res.status, 404);
  assert.equal(caseInput.read("241"), null);
});

// ⚠️ A photo id names a round, and the rounds are a table of acceptable strings
// held in source — no path is built from the id and nothing is read off disk to
// decide, so a traversal attempt is refused for naming no round at all.
test("end to end: a traversal attempt is 404 and writes nothing", async () => {
  const { handler, written } = realPhotosApp();
  const res = await addPhoto(handler, "../../etc/passwd");
  assert.equal(res.status, 404);
  assert.equal(written(), opening);
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

// I-2: the list route already renders each record inside its own try (spec
// §11); the detail route did not, so one unreadable store answered 500 — a
// broken server — where the list answers "that purchase is not available".
test("a store that cannot be read for one purchase is a 404, not a 500", async () => {
  const res = await call(
    app({ listings: { read: () => { throw new Error("the listing file is unreadable"); } } }),
    "GET", "/api/purchases/241",
  );
  assert.equal(res.status, 404);
});

// Promoted minor 3: the client polls every 2 seconds, so a diagnostic inside
// modelFor() is written ~30 times a minute, forever, for a purchase whose
// listing is simply not there.
test("a purchase with no listing is logged once, however often it is polled", async () => {
  const handler = app({ listings: { read: () => null } });
  const written = [];
  const real = console.error;
  console.error = (...args) => written.push(args.join(" "));
  try {
    for (let i = 0; i < 3; i += 1) await call(handler, "GET", "/api/purchases/241");
  } finally {
    console.error = real;
  }
  assert.equal(written.filter((l) => l.includes("no listing for 241")).length, 1);
});

// I-3: the window between an irreversible write and the render of its result.
// modelFor() runs after the action, so a store it cannot read must not report
// the action itself as failed — a completion that paid a seller answered as a
// 500 is the worst lie this server can tell.
test("a store that cannot be rendered after a successful action is not reported as a failed action", async () => {
  let called = false;
  const res = await call(
    app({
      allowConfirm: true,
      actions: { complete: async () => { called = true; return {}; } },
      listings: { read: () => { throw new Error("the listing file is unreadable"); } },
    }),
    "POST", "/api/purchases/241/complete",
  );
  assert.equal(called, true);
  assert.equal(res.status, 200, "the action happened; only the view of it failed");
});

// I-5: which photograph to attach is the operator's choice and stays out of
// the buyer's model — but *whether* one is on offer is now an input to it,
// read from the request, so the client no longer decides on its own whether to
// draw an action the model says is enabled.
const inMediation = {
  exchanges: { get: () => ({ ...record, disputeRaisedAt: 1, disputeRaisedBy: "buyer" }), all: () => [record] },
  cases: {
    read: () => ({ exchangeId: "241", rounds: [{ status: "needs_evidence",
      requests: [{ whoCanProvide: "buyer", what: "Can you photograph the outer shipping carton?" }] }] }),
  },
};

test("the photo action is drawn enabled with no photograph named", async () => {
  // ⚠️ This used to be drawn disabled unless the operator had put a photograph
  // in the page's URL — a primary control under a question asking for
  // evidence, permanently unusable as drawn. Which photograph is attached is
  // still the operator's, but it is settled behind the action.
  const res = await call(app(inMediation), "GET", "/api/purchases/241");
  const photo = JSON.parse(res.body).actions.find((a) => a.id === "photos");
  assert.equal(photo.enabled, true);
  assert.equal(photo.reason, null);
});

test("naming a photograph changes nothing the buyer is shown", async () => {
  // The branch is the operator's and never reaches the screen, so the model
  // must be identical with and without it — byte for byte.
  const plain = await call(app(inMediation), "GET", "/api/purchases/241");
  const named = await call(app(inMediation), "GET", "/api/purchases/241?photo=carton-crushed");
  assert.equal(named.body, plain.body);
  assert.ok(!named.body.includes("carton-crushed"), "the branch choice is not the buyer's");
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

// --- photographs the buyer has already sent ---------------------------------
// ⭐ Addressed by position in the case's own list. Nothing a caller sends is
// resolved against the filesystem, so these assert an absence of ways in as
// much as they assert the happy path.

const withPhotos = (photos) => ({ listings: { read: () => ({ listing, photos }) } });
const INNER = "fixtures/case/photos/inner.jpg";

test("a photograph on the case is served by its position, as an image", async () => {
  const res = await call(app(withPhotos([{ id: "inner", path: INNER }])), "GET", "/api/purchases/241/photos/0");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.deepEqual(res.bytes, readFileSync(join(ROOT, INNER)));
});

test("a position past the end of the list is nothing, not a failure", async () => {
  const res = await call(app(withPhotos([{ id: "inner", path: INNER }])), "GET", "/api/purchases/241/photos/1");
  assert.equal(res.status, 404);
});

test("a case file naming a path outside the photographs directory is refused", async () => {
  // Not reachable from a request — the position is all a caller controls — but
  // a case file is edited by hand, and the check is what makes that safe.
  const res = await call(app(withPhotos([{ id: "x", path: "../../package.json" }])), "GET", "/api/purchases/241/photos/0");
  assert.equal(res.status, 404);
});

test("a file inside the directory that is not an image is refused", async () => {
  const res = await call(app(withPhotos([{ id: "x", path: "fixtures/case/photos/notes.txt" }])), "GET", "/api/purchases/241/photos/0");
  assert.equal(res.status, 404);
});

test("a photograph that has not moved answers 304, so a two-second poll does not refetch it", async () => {
  const handler = app(withPhotos([{ id: "inner", path: INNER }]));
  const first = await call(handler, "GET", "/api/purchases/241/photos/0");
  const etag = first.headers.etag;
  assert.ok(etag, "a served photograph must carry an entity tag");
  const again = await call(handler, "GET", "/api/purchases/241/photos/0", null, { "if-none-match": etag });
  assert.equal(again.status, 304);
  assert.equal(again.bytes.length, 0);
});

test("the model locates photographs by position and never names a path", async () => {
  const disputed = { exchanges: { get: () => ({ ...record, disputeRaisedAt: 1, disputeRaisedBy: "buyer" }), all: () => [record] } };
  const res = await call(app({ ...disputed, ...withPhotos([{ id: "inner", path: INNER }, { id: "carton", path: "fixtures/case/photos/carton.jpg" }]) }), "GET", "/api/purchases/241");
  const model = JSON.parse(res.body);
  assert.deepEqual(model.evidence.photos, ["/api/purchases/241/photos/0", "/api/purchases/241/photos/1"]);
  assert.equal(model.evidence.summary, "2 photos added");
  assert.ok(!JSON.stringify(model).includes("fixtures/"), "no path may reach the model");
});
