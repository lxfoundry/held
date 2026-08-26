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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = "https://api.ship24.com/public/v1";

function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    fail(".env not found. Copy .env.example to .env and fill it in.");
  }
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [trackingNumber, courierArg] = args.filter((a) => !a.startsWith("--"));

if (!trackingNumber) {
  fail("usage: node scripts/register-parcel.mjs <trackingNumber> [courierCode] [--dry-run]");
}

const courierCode = courierArg || "gb-post";
const { SHIP24_API_KEY: apiKey } = loadEnv();
if (!apiKey) fail("SHIP24_API_KEY is not set in .env");

const body = { trackingNumber, courierCode: [courierCode] };

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
