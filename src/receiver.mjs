// The webhook receiver.
//
// Its whole job is to be reachable and to keep what arrives. It receives; it
// never registers a tracker, never calls the chain, and never decides anything.
// Registering is provisioning and lives in scripts/register-parcel.mjs.
//
// Parcels move whether or not anyone is at a keyboard, so this runs on a real
// host rather than a tunnel on a laptop. Zero dependencies, so it deploys
// without an install step.

import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, ROOT } from "./env.mjs";
import { createStore } from "./store.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const env = loadEnv();
const port = Number(env.PORT ?? 3000);
const secret = env.SHIP24_WEBHOOK_SECRET ?? "";
const eventsDir = env.EVENTS_DIR ? join(ROOT, env.EVENTS_DIR) : join(ROOT, "fixtures/events");

// An unguessable path segment is the access control. It is provider-agnostic:
// any provider can be pointed at a URL, whereas signature schemes differ and
// this one is not yet confirmed against a real delivery. When it is, verify the
// signature here as well and keep the path — the two are complementary.
const HOOK_BASE = "/hooks/ship24";
const hookPath = secret ? `${HOOK_BASE}/${secret}` : HOOK_BASE;

// Place names are redacted unless the person whose addresses these are says
// otherwise. See docs/receiver.md.
const retainPlaces = env.RETAIN_LOCATIONS === "true";
const store = createStore(eventsDir, { retainPlaces });
const startedAt = new Date();

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
    send(res, 200, { ok: true, trackings: 0, added: 0 });
    return;
  }

  let added = 0;
  try {
    for (const tracking of trackings) {
      const result = store.ingest(tracking);
      added += result.added;
      const ref = result.shipmentReference ? ` (${result.shipmentReference})` : "";
      log(
        `✓ ${result.trackingNumber}${ref} +${result.added} new, ${result.duplicates} dup,` +
          ` ${result.total} total · milestone ${result.state.current}` +
          (result.report.postcodes ? ` · scrubbed ${result.report.postcodes} postcode(s)` : "") +
          (result.report.places ? ` · redacted ${result.report.places} location(s)` : ""),
      );
    }
  } catch (err) {
    // 500 so the provider retries. Losing a push is recoverable — the event
    // lists are cumulative — but retrying is free and simpler than recovering.
    log(`✗ ingest failed: ${err.message}`);
    send(res, 500, { ok: false, error: "ingest failed" });
    return;
  }

  send(res, 200, { ok: true, trackings: trackings.length, added });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      trackers: store.summary().length,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    // Carries no location data by construction — safe to open from a phone.
    send(res, 200, { ok: true, trackers: store.summary() });
    return;
  }

  if (req.method === "POST" && url.pathname === hookPath) {
    handleWebhook(req, res);
    return;
  }

  // Anything else, including the hook path with a wrong or missing secret,
  // is indistinguishable from a path that does not exist.
  send(res, 404, { ok: false });
});

// Importable without binding a port, so the routing and envelope handling can
// be exercised in tests.
export { server };

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  server.listen(port, () => {
    const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "") || `http://localhost:${port}`;
    log(`receiver listening on port ${port}`);
    log(`  events   → ${eventsDir}`);
    log(`  health   → ${base}/health`);
    log(`  webhook  → ${base}${hookPath}`);
    if (!secret) {
      log(
        "  ⚠ SHIP24_WEBHOOK_SECRET is unset — the webhook path is guessable. Set it before deploying.",
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`${signal} — closing`);
      server.close(() => process.exit(0));
    });
  }
}
