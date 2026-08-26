#!/usr/bin/env node
// Pull a parcel's complete event history into the store.
//
//   node scripts/fetch-parcel.mjs <trackerId>
//   node scripts/fetch-parcel.mjs <trackingNumber>
//   node scripts/fetch-parcel.mjs --all
//
// Carrier event lists are cumulative: a fetch returns everything to date. That
// makes this both the way to capture a finished parcel as a fixture, and the
// recovery path if the receiver was ever down — nothing is lost by not having
// been listening, only the record of when each event arrived.
//
// Events are scrubbed on the way in, by the store, exactly as pushed ones are.

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createStore } from "../src/store.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const env = loadEnv({ required: ["SHIP24_API_KEY"] });
const apiBase = (env.SHIP24_API_BASE ?? "https://api.ship24.com/public/v1").replace(/\/$/, "");
const eventsDir = env.EVENTS_DIR ? join(ROOT, env.EVENTS_DIR) : join(ROOT, "fixtures/events");
const store = createStore(eventsDir, { retainPlaces: env.RETAIN_LOCATIONS === "true" });

const argv = process.argv.slice(2);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function fetchResults(target) {
  const url = UUID.test(target)
    ? `${apiBase}/trackers/${target}/results`
    : `${apiBase}/trackers/search/${encodeURIComponent(target)}/results`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SHIP24_API_KEY}` } });
  const text = await res.text();

  if (!res.ok) {
    // 422 no_active_subscription is a plan-scope error, not an auth failure.
    fail(`HTTP ${res.status} for ${target}\n${text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`unparseable response for ${target}`);
  }

  const trackings = parsed?.data?.trackings ?? parsed?.trackings ?? [];
  if (trackings.length === 0) fail(`no tracking data returned for ${target}`);
  return trackings;
}

// --all re-fetches every tracker already in the store, which is the recovery
// case: point it at the store after any period the receiver was not running.
function targetsFromStore() {
  return readdirSync(eventsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => f.replace(/\.json$/, ""));
}

const targets = argv.includes("--all") ? targetsFromStore() : argv.filter((a) => !a.startsWith("--"));

if (targets.length === 0) {
  fail("usage: node scripts/fetch-parcel.mjs <trackerId|trackingNumber> | --all");
}

for (const target of targets) {
  const trackings = await fetchResults(target);
  for (const tracking of trackings) {
    const r = store.ingest(tracking);
    const ref = r.shipmentReference ? ` (${r.shipmentReference})` : "";
    console.log(
      `✓ ${r.trackingNumber}${ref} — ${r.total} event(s), ${r.added} new, milestone ${r.state.current}`,
    );
    if (r.report.postcodes) console.log(`  scrubbed ${r.report.postcodes} postcode(s)`);
    if (r.report.places) console.log(`  redacted ${r.report.places} location(s)`);
    if (r.report.fields.length) console.log(`  nulled ${r.report.fields.join(", ")}`);
    for (const place of r.report.locations) console.log(`  location retained: ${place}`);
    console.log(`  → ${join(eventsDir, `${r.trackerId}.json`)}`);
  }
}
