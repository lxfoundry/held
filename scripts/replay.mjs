#!/usr/bin/env node
// Replay a captured parcel's events into a store, on a timer.
//
//   node scripts/replay.mjs <trackerId> --from fixtures/events --into state/demo-events --every 3
//
// Parcels move on their own schedule, which makes the buyer view hard to
// watch — a real delivery takes days to go from dispatch to arrival. This
// script writes a captured snapshot's events into a target store one at a
// time, through ingest() — the same call the webhook receiver makes on a real
// push — so the view can be exercised without waiting on a parcel or a
// reachable network.
//
// It never fabricates an event: everything it writes came out of a captured
// snapshot read from --from, and it never writes there. It never writes a
// snapshot or a derived state directly either — deriving state from the event
// list is the store's job, and bypassing it would produce a store the real
// code could never have produced.
//
// Provisioning, not runtime: run by hand, alongside the view, never imported.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStore, isSafeTrackerId } from "../src/store.mjs";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function usage() {
  fail(
    "usage: node scripts/replay.mjs <trackerId> --from <dir> --into <dir> --every <seconds>",
  );
}

// A flag's value is whatever follows it, even if that looks like another
// flag or is absent — the alternative is a positional trackerId silently
// swallowing a flag's value when a flag is passed with nothing after it.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [trackerId] = positional;

if (!trackerId) usage();
if (!isSafeTrackerId(trackerId)) fail(`not a usable tracker id: ${JSON.stringify(trackerId)}`);
if (!flags.from) usage();
if (!flags.into) usage();
if (flags.every === undefined) usage();

const everySeconds = Number(flags.every);
if (!Number.isFinite(everySeconds) || everySeconds < 0) {
  fail(`--every must be a non-negative number of seconds, got ${JSON.stringify(flags.every)}`);
}
const everyMs = everySeconds * 1000;

const fromDir = resolve(process.cwd(), flags.from);
const intoDir = resolve(process.cwd(), flags.into);

if (fromDir === intoDir) {
  fail("--from and --into must be different directories: this script never writes its source");
}

const snapshotPath = resolve(fromDir, `${trackerId}.json`);

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
} catch (err) {
  if (err.code === "ENOENT") {
    fail(`no captured snapshot for tracker ${trackerId} at ${snapshotPath}`);
  }
  fail(`could not read captured snapshot at ${snapshotPath}: ${err.message}`);
}

if (snapshot.trackerId && snapshot.trackerId !== trackerId) {
  fail(
    `snapshot at ${snapshotPath} is captured for tracker ${snapshot.trackerId}, not ${trackerId}`,
  );
}

const events = Array.isArray(snapshot.events) ? snapshot.events : [];
if (events.length === 0) {
  fail(`captured snapshot at ${snapshotPath} has no events to replay`);
}

// Only what ingest() reads off tracker/shipment/statistics, taken straight
// from the capture — nothing here is invented, it is what the receiver would
// have received on the wire the first time.
const tracker = {
  trackerId: snapshot.trackerId ?? trackerId,
  trackingNumber: snapshot.trackingNumber ?? null,
  shipmentReference: snapshot.shipmentReference ?? null,
  courierCode: snapshot.courierCode ?? null,
};

const store = createStore(intoDir);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log(`→ replaying ${events.length} event(s) for ${trackerId}`);
console.log(`  from ${fromDir}`);
console.log(`  into ${intoDir}`);
console.log(`  every ${everySeconds}s`);

let result;
for (const [index, event] of events.entries()) {
  // One event per call, exactly as the receiver ingests one carrier push at a
  // time — never the whole array at once, which would produce a store that
  // arrived at its final state in a single write.
  result = store.ingest({
    tracker,
    shipment: snapshot.shipment ?? null,
    statistics: snapshot.statistics ?? null,
    events: [event],
  });

  const when = event.occurrenceDatetime ?? event.datetime ?? "?";
  const what = event.status ?? event.statusMilestone ?? "?";
  console.log(
    `  [${index + 1}/${events.length}] ${when} — ${what} · milestone now ${result.state.current}`,
  );

  if (index < events.length - 1 && everyMs > 0) {
    await sleep(everyMs);
  }
}

console.log(`✓ replayed ${events.length} event(s) — final milestone ${result.state.current}`);
