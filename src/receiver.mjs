// The webhook receiver.
//
// Its whole job is to be reachable and to keep what arrives. It receives; it
// never registers a tracker, never calls the chain, and never decides anything.
// Registering is provisioning and lives in scripts/register-parcel.mjs.
//
// Parcels move whether or not anyone is at a keyboard, so this runs on a real
// host rather than a tunnel on a laptop. Zero dependencies, so it deploys
// without an install step.
//
// ⭐ It is internet-facing and expected to stay up unattended for days. Nothing
// a remote caller sends may be able to stop it: every request path is wrapped,
// and a request that cannot be handled fails that request alone.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import {
  createStore,
  isSafeTrackerId,
  InvalidPayloadError,
  CorruptSnapshotError,
} from "./store.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;

// ⭐ Only the settings this process needs. The environment also carries wallet
// keys and provider credentials, and an internet-facing service that cannot
// call the chain should not be holding them in memory either — the property is
// structural here, not a promise in a document.
export const RECEIVER_ENV_KEYS = [
  "PORT",
  "SHIP24_WEBHOOK_SECRET",
  "EVENTS_DIR",
  "PUBLIC_BASE_URL",
  "RETAIN_LOCATIONS",
  "ALLOW_INSECURE_HOOK",
  "SHIP24_TRACKER_ALLOWLIST",
  "ALLOW_ANY_TRACKER",
];

const env = loadEnv({ only: RECEIVER_ENV_KEYS });

const port = normalisePort(env.PORT);
const secret = env.SHIP24_WEBHOOK_SECRET ?? "";
const eventsDir = env.EVENTS_DIR ? resolveFromRoot(env.EVENTS_DIR) : resolveFromRoot("fixtures/events");

// An unguessable path segment is the access control. It is provider-agnostic —
// any provider can be pointed at a URL — and it is the check that works today.
//
// ⚠️ It authenticates the caller only, and only while it stays secret. It
// carries no integrity check on the body, so anyone holding it can inject
// events. That matters most for available_for_pickup, which is sticky: a forged
// one would stand the watchdog down permanently for that exchange. Signature
// verification is a prerequisite for shipping the watchdog, not an optional
// complement to this — verify it here as well, and keep the path.
const HOOK_BASE = "/hooks/ship24";
const EVENTS_BASE = "/events";
const hookPath = secret ? `${HOOK_BASE}/${secret}` : HOOK_BASE;
const eventsPath = secret ? `${EVENTS_BASE}/${secret}` : EVENTS_BASE;

// ⭐ The second half of the access control, and the half that survives the
// first leaking. The path says *someone who knows the URL* is calling; the
// allowlist says *about a parcel we actually registered*. Anything else is
// refused before a path is built or a lock is taken.
//
// ⚠️ Not hypothetical: the provider itself pushed a tracker nobody registered,
// carrying a live tracking number in state `delivered` — and `delivered` is the
// milestone that enables paying the seller.
//
// Provisioning, not runtime: registering happens on a laptop against the
// provider's API, while this runs on a host with no API key, so the list has to
// arrive as configuration. There is deliberately no endpoint to add to it —
// that would hand the power straight back to anyone holding the URL.
const allowlist = parseAllowlist(env.SHIP24_TRACKER_ALLOWLIST);

// String(), because the id arrives from an unauthenticated payload and may be
// any JSON type: a number, null, an object. None of those can match an entry in
// a set of strings, so all of them are refused.
function isAllowedTracker(trackerId) {
  if (!allowlist) return true;
  return allowlist.has(String(trackerId));
}

// Place names are redacted unless the person whose addresses these are says
// otherwise. See docs/receiver.md.
const retainPlaces = env.RETAIN_LOCATIONS === "true";
const store = createStore(eventsDir, { retainPlaces });
const startedAt = new Date();

// resolve(), not join(), so EVENTS_DIR may be given as an absolute path.
function resolveFromRoot(relative) {
  return resolve(fileURLToPath(new URL("..", import.meta.url)), relative);
}

function normalisePort(value) {
  if (value === undefined) return 3000;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT is not a valid port number: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function send(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ⚠️ Deliberately not new URL(): building one needs a host, and a malformed
// Host header — which any remote caller can send — makes it throw inside the
// request listener, which ends the process. Nothing here needs the host.
export function pathnameOf(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl === "") return "/";
  let path = requestUrl;
  // Absolute-form request targets are legal and some proxies send them.
  const schemeEnd = path.indexOf("://");
  if (schemeEnd !== -1) {
    const afterAuthority = path.indexOf("/", schemeEnd + 3);
    path = afterAuthority === -1 ? "/" : path.slice(afterAuthority);
  }
  const queryStart = path.search(/[?#]/);
  if (queryStart !== -1) path = path.slice(0, queryStart);
  return path === "" ? "/" : path;
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve_(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(Object.assign(new Error("client aborted"), { status: 400 })));
  });
}

// The provider's own fetch response nests the array under data. A push may
// arrive either nested or flat, and a single tracking object is accepted too,
// so the first real delivery cannot be lost to an envelope mismatch.
export function extractTrackings(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.trackings)) return body.trackings;
  if (Array.isArray(body?.data?.trackings)) return body.data.trackings;
  if (body.tracker || body.events) return [body];
  return [];
}

async function handleWebhook(req, res) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err) {
    const status = err.status ?? 400;
    log(`✗ rejected ${status}: ${err.message}`);
    send(res, status, { ok: false, error: "unreadable body" });
    return;
  }

  const trackings = extractTrackings(parsed);
  if (trackings.length === 0) {
    // A ping or a keep-alive. Acknowledge it: a non-2xx here would put the
    // provider into a retry loop over nothing.
    log("· received a payload with no trackings — acknowledged");
    send(res, 200, { ok: true, trackings: 0, added: 0, rejected: 0 });
    return;
  }

  let added = 0;
  let rejected = 0;

  for (const tracking of trackings) {
    // Ahead of ingest deliberately: a refused tracker must leave nothing on the
    // volume, not a snapshot, not an event log and not a lock file.
    if (!isAllowedTracker(tracking?.tracker?.trackerId)) {
      // 200, not a retry code, for the same reason a malformed payload gets
      // one: a tracker that is not on the list will never be on it by being
      // sent again, and a provider retrying forever wedges its queue.
      rejected += 1;
      log(
        `✗ refusing an event for a tracker that was never registered: ` +
          `${JSON.stringify(tracking?.tracker?.trackerId)}`,
      );
      continue;
    }
    try {
      const result = store.ingest(tracking);
      added += result.added;
      const ref = result.shipmentReference ? ` (${result.shipmentReference})` : "";
      log(
        `✓ ${result.trackingNumber}${ref} +${result.added} new, ${result.duplicates} dup,` +
          ` ${result.total} total · milestone ${result.state.current}` +
          (result.report.postcodes ? ` · scrubbed ${result.report.postcodes} postcode(s)` : "") +
          (result.report.places ? ` · redacted ${result.report.places} location(s)` : ""),
      );
    } catch (err) {
      // ⭐ A permanent failure must not be answered with a retry code. Redelivery
      // cannot fix a malformed payload, and a provider that keeps retrying one
      // wedges its queue behind a message that will never succeed.
      if (err instanceof InvalidPayloadError) {
        rejected += 1;
        log(`✗ rejecting a malformed tracking entry, it will not be retried: ${err.message}`);
        continue;
      }
      // A corrupt snapshot is an operator problem, not a delivery problem, and
      // it is the case that silently loses the sticky flags. Say so loudly, and
      // do not ask for the push again.
      if (err instanceof CorruptSnapshotError) {
        rejected += 1;
        log(`✗ CORRUPT SNAPSHOT — move it aside and re-fetch this tracker: ${err.message}`);
        continue;
      }
      // Anything else — a full disk, a lock timeout — may well succeed next
      // time, so ask for the redelivery.
      log(`✗ ingest failed, asking for redelivery: ${err.stack ?? err.message}`);
      send(res, 500, { ok: false, error: "ingest failed" });
      return;
    }
  }

  send(res, 200, { ok: true, trackings: trackings.length, added, rejected });
}

function route(req, res) {
  const pathname = pathnameOf(req.url);

  // Open, because a platform liveness probe has no way to hold a secret. It
  // counts files rather than parsing them, so probing it every few seconds
  // costs nothing.
  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, {
      ok: true,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      trackers: store.count(),
    });
    return;
  }

  // Behind the same secret. It carries no location data, but it does list
  // tracking numbers and the shipment reference that links a parcel to an
  // exchange, and it reads every snapshot to build the answer.
  if (req.method === "GET" && pathname === eventsPath) {
    send(res, 200, { ok: true, trackers: store.summary() });
    return;
  }

  if (req.method === "POST" && pathname === hookPath) {
    handleWebhook(req, res).catch((err) => {
      log(`✗ unhandled failure while handling a push: ${err.stack ?? err.message}`);
      send(res, 500, { ok: false, error: "internal error" });
    });
    return;
  }

  // Anything else, including a hook or events path with a wrong or missing
  // secret, is indistinguishable from a path that does not exist.
  send(res, 404, { ok: false });
}

const server = createServer((req, res) => {
  try {
    route(req, res);
  } catch (err) {
    // One bad request must never be able to take the service down.
    log(`✗ request failed: ${err.stack ?? err.message}`);
    try {
      send(res, 500, { ok: false, error: "internal error" });
    } catch {
      res.destroy();
    }
  }
});

// Importable without binding a port, so the routing and envelope handling can
// be exercised in tests.
export { server, store, hookPath, eventsPath };

// Pure so the refusal can be tested without starting a process. Returns the
// message to print and exit on, or null when the configuration is acceptable.
export function secretRequirementError(configuredSecret, allowInsecure) {
  if (configuredSecret) return null;
  if (allowInsecure === "true") return null;
  return (
    "SHIP24_WEBHOOK_SECRET is not set.\n" +
    "  Without it the webhook path is a guessable public string, and anyone\n" +
    "  can inject tracking events. Generate one with:\n" +
    '    node -e "console.log(crypto.randomUUID())"\n' +
    "  To run without one anyway (local development only), set ALLOW_INSECURE_HOOK=true."
  );
}

// Configuration arrives from a shell, a secrets store or a copied-out log, so
// commas, spaces and newlines all separate and empty entries are dropped.
// Returns null — meaning no filtering — rather than an empty set, so "unset"
// and "set to nothing" cannot be confused: one is refused at startup, the other
// would silently accept everything.
export function parseAllowlist(value) {
  if (typeof value !== "string") return null;
  const ids = value.split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0) return null;
  for (const id of ids) {
    // An id that could never be stored cannot usefully be allowed either, and a
    // typo would otherwise sit in the list silently matching nothing.
    if (!isSafeTrackerId(id)) {
      throw new Error(
        `SHIP24_TRACKER_ALLOWLIST contains an entry that is not a usable tracker id: ${JSON.stringify(id)}`,
      );
    }
  }
  return new Set(ids);
}

// A missing allowlist means no filtering, so it is refused at startup for the
// same reason a missing secret is: over an unattended three-day gap, a warning
// in a log nobody reads is indistinguishable from no protection at all.
export function allowlistRequirementError(configuredAllowlist, allowAnyTracker) {
  if (configuredAllowlist) return null;
  if (allowAnyTracker === "true") return null;
  return (
    "SHIP24_TRACKER_ALLOWLIST is not set.\n" +
    "  The webhook path authenticates the caller but not the body, so anyone\n" +
    "  holding the URL can inject events for a tracker you never registered.\n" +
    "  Set it to the tracker ids you registered, comma-separated:\n" +
    "    fly secrets set SHIP24_TRACKER_ALLOWLIST=\"<id>,<id>\"\n" +
    "  To accept any tracker anyway (local development only), set ALLOW_ANY_TRACKER=true."
  );
}

// The configurations that are allowed but worth saying out loud once, printed
// under the startup banner. Pure for the same reason as the refusal above: the
// conditions are asserted directly rather than read off a running process.
export function startupWarnings(configuredSecret, retainingPlaces, allowAnyTracker) {
  const warnings = [];
  if (!configuredSecret) {
    warnings.push(
      "no webhook secret: the path is public and anyone can inject tracking events"
    );
  }
  if (retainingPlaces) {
    warnings.push("RETAIN_LOCATIONS=true: captured events keep their place names");
  }
  if (allowAnyTracker === "true") {
    warnings.push(
      "ALLOW_ANY_TRACKER=true: events are accepted for any tracker id, including ones never registered"
    );
  }
  return warnings;
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  // ⭐ Nothing a caller sends should end the process, but if something does get
  // through, staying up and serving is better than exiting silently on a host
  // nobody is watching. A supervisor is still required — see docs/receiver.md.
  process.on("uncaughtException", (err) => {
    log(`✗ uncaught exception, staying up: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(`✗ unhandled rejection, staying up: ${reason?.stack ?? reason}`);
  });

  const refusal =
    secretRequirementError(secret, env.ALLOW_INSECURE_HOOK) ??
    allowlistRequirementError(allowlist, env.ALLOW_ANY_TRACKER);
  if (refusal) {
    console.error(`✗ ${refusal}`);
    process.exit(1);
  }

  server.listen(port, () => {
    const bound = server.address()?.port ?? port;
    const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "") || `http://localhost:${bound}`;
    log(`receiver listening on port ${bound}`);
    log(`  events dir → ${eventsDir}`);
    log(`  health     → ${base}/health`);
    // ⚠️ The secret is the whole access control, so it is never written to a
    // log: startup output ends up in journald, in the platform's aggregator and
    // in screen shares. The shape is printed; the value is not.
    log(`  webhook    → ${base}${HOOK_BASE}${secret ? "/<SHIP24_WEBHOOK_SECRET>" : ""}`);
    log(`  summary    → ${base}${EVENTS_BASE}${secret ? "/<SHIP24_WEBHOOK_SECRET>" : ""}`);
    log(`  allowlist  → ${allowlist ? `${allowlist.size} registered tracker(s)` : "disabled"}`);
    for (const warning of startupWarnings(secret, retainPlaces, env.ALLOW_ANY_TRACKER)) {
      log(`  ⚠ ${warning}`);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`${signal} — closing`);
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      // Keep-alive connections that are mid-request can otherwise hold the
      // process open indefinitely.
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    });
  }
}
