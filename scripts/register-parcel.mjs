#!/usr/bin/env node
// Register a parcel with the tracking provider so its events are collected.
//
//   node scripts/register-parcel.mjs <trackingNumber> [courierCode]
//   node scripts/register-parcel.mjs <trackingNumber> --dry-run
//
// Courier code defaults to gb-post (Royal Mail). Royal Mail tracking numbers
// are not self-identifying, so the code is required for them to resolve.
//
// This is provisioning, not runtime. The oracle adapter only ever receives;
// it never registers. Registering late loses no history — carrier event lists
// are cumulative and the first fetch returns everything to date.
//
// Zero dependencies: uses the global fetch built into Node 18+.

import { loadEnv } from "../src/env.mjs";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

// --ref "parcel A" labels the tracker so parcels are distinguishable later.
const refIndex = argv.indexOf("--ref");
const shipmentReference = refIndex === -1 ? null : argv[refIndex + 1];
if (refIndex !== -1 && !shipmentReference) fail("--ref needs a value");

const refValueIndex = refIndex === -1 ? -1 : refIndex + 1;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && i !== refValueIndex,
);
const [trackingNumber, courierArg] = positional;

if (!trackingNumber) {
  fail(
    "usage: node scripts/register-parcel.mjs <trackingNumber> [courierCode] [--ref <label>] [--dry-run]",
  );
}

const courierCode = courierArg || "gb-post";

let env;
try {
  env = loadEnv({ required: ["SHIP24_API_KEY"] });
} catch (err) {
  fail(err.message);
}
const apiKey = env.SHIP24_API_KEY;
const API_BASE = (env.SHIP24_API_BASE ?? "https://api.ship24.com/public/v1").replace(/\/$/, "");

const body = { trackingNumber, courierCode: [courierCode] };
if (shipmentReference) body.shipmentReference = shipmentReference;

console.log(`→ POST ${API_BASE}/trackers`);
console.log(`  ${JSON.stringify(body)}`);

if (dryRun) {
  console.log("· dry run, nothing sent");
  process.exit(0);
}

const res = await fetch(`${API_BASE}/trackers`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  /* keep the raw body */
}

console.log(`← HTTP ${res.status}`);
console.log(parsed ? JSON.stringify(parsed, null, 2) : text);

if (!res.ok) {
  // 422 no_active_subscription is a plan-scope error, not an auth failure:
  // /trackers needs the per-shipment plan, /tracking/search the per-call plan.
  fail(`registration failed for ${trackingNumber} (${courierCode})`);
}

const trackerId = parsed?.data?.tracker?.trackerId;
console.log(`\n✓ registered ${trackingNumber} (${courierCode})`);
if (trackerId) console.log(`  trackerId: ${trackerId}`);
console.log("  Record the tracking number in the repo — public tracking numbers are committable.");
console.log("  Expect no events until the parcel is accepted into the network.");
