// HTTP-level tests. The receiver is internet-facing and expected to stay up
// unattended for days, so the cases that matter most here are the ones a remote
// caller can reach: routing, the secret, malformed input, and whether anything
// a stranger sends can end the process.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const eventsDir = mkdtempSync(join(tmpdir(), "held-receiver-"));
const SECRET = "test-secret";

process.env.EVENTS_DIR = eventsDir;
process.env.SHIP24_WEBHOOK_SECRET = SECRET;
process.env.RETAIN_LOCATIONS = "false";

const {
  server,
  store,
  hookPath,
  eventsPath,
  pathnameOf,
  extractTrackings,
  secretRequirementError,
  startupWarnings,
  parseAllowlist,
  allowlistRequirementError,
} = await import("../src/receiver.mjs");

let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(eventsDir, { recursive: true, force: true });
});

function tracking(trackerId, events, extra = {}) {
  return {
    tracker: { trackerId, trackingNumber: "MZ544750899GB", shipmentReference: "parcel A", ...extra },
    shipment: { statusMilestone: "in_transit", recipient: {} },
    events,
    statistics: { timestamps: {} },
  };
}

const event = (id, milestone = "in_transit") => ({
  eventId: id,
  trackingNumber: "MZ544750899GB",
  datetime: "2026-08-26T15:21:01.000Z",
  statusMilestone: milestone,
  location: "<Town> Post Office [AB12 3CD]",
});

function post(path, body) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Sends a raw request so headers that a well-behaved client would never
// produce can be put on the wire.
function rawRequest(lines) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.address().port, "127.0.0.1", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(data);
    });
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", (err) => (data ? resolve(data) : reject(err)));
  });
}

test("pathnameOf never throws, whatever the request target is", () => {
  assert.equal(pathnameOf("/health"), "/health");
  assert.equal(pathnameOf("/events?x=1"), "/events");
  assert.equal(pathnameOf("/events#frag"), "/events");
  assert.equal(pathnameOf("http://example.test/hooks/ship24/s"), "/hooks/ship24/s");
  assert.equal(pathnameOf("http://example.test"), "/");
  assert.equal(pathnameOf(""), "/");
  assert.equal(pathnameOf(undefined), "/");
});

// Regression: building a URL from the Host header made a malformed one throw
// inside the request listener, which ended the process. Any remote caller could
// send it, and the service exists to stay up unattended.
test("a malformed Host header does not kill the process", async () => {
  const response = await rawRequest(["GET /health HTTP/1.1", "Host: a b c", "Connection: close"]);
  assert.match(response, /HTTP\/1\.1 (200|400)/);

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200, "the receiver stopped serving after a malformed Host header");
});

test("an empty Host header does not kill the process", async () => {
  await rawRequest(["GET /health HTTP/1.1", "Host:", "Connection: close"]);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});

test("health is open and reports the tracker count", async () => {
  const res = await fetch(`${origin}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.trackers, "number");
});

test("the hook path is 404 without the secret", async () => {
  assert.equal((await post("/hooks/ship24", tracking("t-404", []))).status, 404);
  assert.equal((await post("/hooks/ship24/wrong", tracking("t-404", []))).status, 404);
});

test("the summary path is 404 without the secret", async () => {
  assert.equal((await fetch(`${origin}/events`)).status, 404);
  assert.equal((await fetch(`${origin}/events/wrong`)).status, 404);
});

test("a push is stored, and an identical redelivery adds nothing", async () => {
  const payload = { data: { trackings: [tracking("t-store", [event("e1")])] } };

  const first = await (await post(hookPath, payload)).json();
  assert.deepEqual({ ok: first.ok, added: first.added }, { ok: true, added: 1 });

  const second = await (await post(hookPath, payload)).json();
  assert.equal(second.added, 0, "a duplicate push produced a second write");
});

test("the summary lists the tracker and carries no location data", async () => {
  const res = await fetch(`${origin}${eventsPath}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!/Post Office|AB12/i.test(body), "the summary leaked location data");
  assert.match(body, /MZ544750899GB/);
});

// Regression: the tracker id is used to build a filename, and join() normalises
// "..", so an unvalidated id was an arbitrary file write.
test("a tracker id that escapes the store is rejected, not written", async () => {
  const before = readdirSync(eventsDir).length;
  const res = await post(hookPath, {
    trackings: [tracking("../escaped", [event("e-escape")])],
  });

  assert.equal(res.status, 200, "a malformed payload must not ask for a retry");
  const body = await res.json();
  assert.equal(body.rejected, 1);
  assert.equal(body.added, 0);
  assert.equal(readdirSync(eventsDir).length, before, "a file was written for a rejected id");
});

test("a non-string tracker id is rejected", async () => {
  const res = await post(hookPath, { trackings: [tracking({ nested: true }, [event("e-obj")])] });
  assert.equal((await res.json()).rejected, 1);
});

// Regression: a permanent failure answered with 500 becomes an infinite retry
// that can wedge the provider's delivery queue.
test("a payload that can never be stored is not asked for again", async () => {
  const res = await post(hookPath, { trackings: [{ tracker: {}, events: [] }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rejected, 1);
});

// Regression: read() swallowed parse errors and returned null, so a torn
// snapshot was treated as a new tracker and its history — including the sticky
// available_for_pickup flag — was silently discarded.
test("a corrupt snapshot is refused rather than silently overwritten", async () => {
  const id = "t-corrupt";
  await post(hookPath, { trackings: [tracking(id, [event("e-pickup", "available_for_pickup")])] });

  const before = store.read(id);
  assert.equal(before.state.everAvailableForPickup, true);

  writeFileSync(join(eventsDir, `${id}.json`), "{ truncated");

  const res = await post(hookPath, { trackings: [tracking(id, [event("e-later", "exception")])] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rejected, 1, "a corrupt snapshot must not be overwritten");

  const onDisk = readdirSync(eventsDir).filter((f) => f === `${id}.json`);
  assert.equal(onDisk.length, 1);
  assert.throws(() => store.read(id), /could not be read/);
});

test("a body with no trackings is acknowledged rather than retried", async () => {
  const res = await post(hookPath, { ping: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).trackings, 0);
});

test("unparseable JSON is rejected without a retry storm", async () => {
  const res = await post(hookPath, "{not json");
  assert.equal(res.status, 400);
});

test("an oversized body is rejected", async () => {
  const huge = JSON.stringify({ padding: "x".repeat(3 * 1024 * 1024) });
  const res = await post(hookPath, huge).catch((err) => err);
  // The connection may be destroyed rather than answered; either is a rejection,
  // and neither may take the process down.
  if (res instanceof Error) {
    assert.match(String(res), /fetch failed|terminated|socket/i);
  } else {
    assert.equal(res.status, 413);
  }
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});

test("the envelope is accepted in every shape the provider might send", () => {
  assert.equal(extractTrackings({ data: { trackings: [{ tracker: {} }] } }).length, 1);
  assert.equal(extractTrackings({ trackings: [{ tracker: {} }, { tracker: {} }] }).length, 2);
  assert.equal(extractTrackings({ tracker: { trackerId: "x" }, events: [] }).length, 1);
  assert.deepEqual(extractTrackings(null), []);
  assert.deepEqual(extractTrackings({}), []);
  assert.deepEqual(extractTrackings("ping"), []);
});

// Starting without a secret exposes a well-known public path that anyone can
// post events to, so it is refused rather than warned about.
test("the receiver refuses to start without a secret unless told to", () => {
  assert.match(secretRequirementError("", undefined), /SHIP24_WEBHOOK_SECRET is not set/);
  assert.match(secretRequirementError(undefined, "false"), /SHIP24_WEBHOOK_SECRET is not set/);
  assert.equal(secretRequirementError("", "true"), null, "the explicit opt-out was ignored");
  assert.equal(secretRequirementError("a-secret", undefined), null);
});

// The startup banner is the only place these two show up, and both describe a
// deployment that is running wider open than the defaults.
test("the startup banner names the insecure and the retaining configuration", () => {
  assert.deepEqual(startupWarnings("a-secret", false), []);
  assert.match(startupWarnings("", false)[0], /no webhook secret/);
  assert.match(startupWarnings("a-secret", true)[0], /RETAIN_LOCATIONS/);
  assert.equal(startupWarnings("", true).length, 2);
});

// Opting out of the allowlist is legitimate for local development and a
// liability on a public host, so it is named in the banner like the others.
test("the startup banner names a deployment running without an allowlist", () => {
  assert.deepEqual(startupWarnings("a-secret", false, undefined), []);
  assert.deepEqual(startupWarnings("a-secret", false, "false"), []);
  assert.match(startupWarnings("a-secret", false, "true")[0], /ALLOW_ANY_TRACKER/);
  assert.equal(startupWarnings("", true, "true").length, 3);
});

// The unguessable path authenticates the caller but not the body, so anyone
// holding the URL can inject events for a tracker we never registered. The
// allowlist is the cheap half of the fix: it needs nothing from the provider.
test("an unset allowlist parses to no filtering rather than to an empty one", () => {
  assert.equal(parseAllowlist(undefined), null);
  assert.equal(parseAllowlist(""), null);
  assert.equal(parseAllowlist("   "), null);
});

test("an allowlist parses to the set of ids it names", () => {
  assert.deepEqual(parseAllowlist("abc"), new Set(["abc"]));
  assert.deepEqual(parseAllowlist("abc,def"), new Set(["abc", "def"]));
});

// Configuration arrives from a shell, a secrets store or a copied-out log, so
// separators and stray whitespace are tolerated rather than turned into ids
// that can never match.
test("allowlist parsing tolerates whitespace, newlines and empty entries", () => {
  assert.deepEqual(parseAllowlist(" abc , def "), new Set(["abc", "def"]));
  assert.deepEqual(parseAllowlist(`abc
def`), new Set(["abc", "def"]));
  assert.deepEqual(parseAllowlist("abc,,def,"), new Set(["abc", "def"]));
});

// An id that could never be stored cannot usefully be allowed either, and a
// typo in configuration should be loud rather than silently unmatchable.
test("an allowlist entry that is not a usable tracker id is refused", () => {
  assert.throws(() => parseAllowlist("../../etc/passwd"), /not a usable tracker id/);
});

// Same shape as the secret check above: a missing security control refuses to
// start rather than warning into a log nobody reads over a three-day gap.
test("the receiver refuses to start without an allowlist unless told to", () => {
  assert.match(allowlistRequirementError(null, undefined), /SHIP24_TRACKER_ALLOWLIST is not set/);
  assert.match(allowlistRequirementError(null, "false"), /SHIP24_TRACKER_ALLOWLIST is not set/);
  assert.equal(allowlistRequirementError(null, "true"), null, "the explicit opt-out was ignored");
  assert.equal(allowlistRequirementError(new Set(["abc"]), undefined), null);
});
