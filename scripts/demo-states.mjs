#!/usr/bin/env node
// Put one purchase on screen for every state the buyer's view can reach.
//
//   node scripts/demo-states.mjs                  # report, change nothing
//   node scripts/demo-states.mjs --execute        # write them
//   node scripts/demo-states.mjs --clean --execute  # remove them again
//
// The view is a pure read over three stores, so a state is reached by putting
// those stores in a particular arrangement. Doing that by hand means editing
// JSON and remembering which fields produce which screen; this materialises the
// whole table at once, and `npm run buyer` with no ?purchase= then lists every
// state as its own card.
//
// ⭐ The table itself is src/demo-states.mjs, and test/demo-states.test.mjs
// renders every entry through the real view and asserts the state it claims.
// So this script only writes files: what each state *is* is decided, and
// checked, elsewhere.
//
// ⚠️ These are demonstration records, not exchanges. Nothing on any chain
// corresponds to them and none carries a pre-signed authorisation, so an action
// pressed on one fails — which is itself the honest screen for "that didn't go
// through", and the only way to see it. The one exception is "Add a photo" on
// 99999907, which rewrites a local evidence file and genuinely succeeds.
//
// ⚠️ It writes into fixtures/case and fixtures/events, which are otherwise
// committed directories. Everything it writes is matched by a .gitignore rule
// on its name, so `git status` stays clean and --clean can find it all again.
//
// Provisioning, not runtime: run by hand, never imported.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createStore } from "../src/store.mjs";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";
import { applyPhotos } from "../src/case-fixture.mjs";
import { CATALOGUE, DEMO_TRACKERS, caseRecordFor, recordFor } from "../src/demo-states.mjs";

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const clean = args.includes("--clean");
const known = new Set(["--execute", "--clean"]);
const stray = args.filter((value) => !known.has(value));
if (stray.length > 0) {
  console.error(`✗ unrecognised argument${stray.length === 1 ? "" : "s"}: ${stray.join(" ")}`);
  console.error("  usage: node scripts/demo-states.mjs [--clean] [--execute]");
  process.exit(1);
}

// EXCHANGES_DIR and EVENTS_DIR only, and for one reason: whatever the buyer
// view reads is what these have to be written into. A record written somewhere
// else is a card that never appears, which reads exactly like a broken view.
const settings = loadEnv({ only: ["EXCHANGES_DIR", "EVENTS_DIR"] });
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"));
// Fixed, exactly as src/buyer-server.mjs fixes them: a configurable copy that
// disagreed with the view's would write states nothing displays.
const cases = createCaseStore(join(ROOT, "state/cases"));
const recordings = createRecordingStore(join(ROOT, "fixtures/case/recordings"));
const caseInputDir = join(ROOT, "fixtures/case");

const caseInputPath = (id) => join(caseInputDir, `${id}.json`);
const casePath = (id) => join(ROOT, "state/cases", `${id}.json`);
const exchangePath = (id) => join(exchanges.dir, `${id}.json`);
const trackerPaths = (id) => [join(trackers.dir, `${id}.json`), join(trackers.dir, `${id}.events.ndjson`)];

// --- clean ------------------------------------------------------------------

if (clean) {
  const targets = [];
  for (const entry of CATALOGUE) {
    targets.push(exchangePath(entry.id), caseInputPath(entry.id), casePath(entry.id));
  }
  for (const trackerId of Object.keys(DEMO_TRACKERS)) targets.push(...trackerPaths(trackerId));

  const present = targets.filter((path) => existsSync(path));
  step(`${present.length} demonstration file${present.length === 1 ? "" : "s"} to remove`);
  for (const path of present) info(path.slice(ROOT.length + 1).replace(/\\/g, "/"));

  if (!execute) {
    console.log("\nnothing was removed. Apply it with:");
    console.log("  npm run demo-states -- --clean --execute");
    process.exit(0);
  }
  for (const path of present) rmSync(path);
  console.log("");
  ok(`removed ${present.length} file${present.length === 1 ? "" : "s"}`);
  process.exit(0);
}

// --- write ------------------------------------------------------------------

// ⚠️ Checked before anything is written, not discovered halfway through. A
// missing recording would leave a case with no round on it, which draws as a
// dispute with nothing to answer — a state that looks like a bug in the view
// rather than a file this script could not find.
for (const entry of CATALOGUE) {
  if (entry.recording && !recordings.find(entry.recording)) {
    console.error(`✗ ${entry.id} is seeded from recording ${entry.recording.slice(0, 12)}…, which is not on file`);
    console.error("  it is committed under fixtures/case/recordings — check the working tree is complete");
    process.exit(1);
  }
  if (entry.caseInput && !existsSync(caseInputPath(entry.caseInput.from))) {
    console.error(`✗ ${entry.id} copies its evidence from fixtures/case/${entry.caseInput.from}.json, which is missing`);
    process.exit(1);
  }
}

const now = Date.now();

step(`${CATALOGUE.length} states, ${Object.keys(DEMO_TRACKERS).length} demonstration trackers`);
for (const entry of CATALOGUE) {
  const seeded = entry.recording ? " · case seeded from a recorded round" : "";
  const evidence = entry.caseInput ? ` · evidence copied from ${entry.caseInput.from} at round ${entry.caseInput.round}` : "";
  info(`${entry.id}  ${entry.name}${seeded}${evidence}`);
}

if (!execute) {
  console.log("");
  console.log("nothing was written. Apply it with:");
  console.log("  npm run demo-states -- --execute");
  process.exit(0);
}

console.log("");

// The three demonstration trackers, built through the store's own ingest() —
// the same call the webhook receiver makes on a real push — so the milestone
// state is derived from the events rather than written directly. Ingest is
// content-addressed and skips events it already holds, so re-running this
// changes nothing.
for (const [trackerId, tracker] of Object.entries(DEMO_TRACKERS)) {
  let result;
  for (const event of tracker.events) {
    result = trackers.ingest({
      tracker: { trackerId, trackingNumber: tracker.trackingNumber, shipmentReference: null, courierCode: null },
      shipment: null,
      statistics: null,
      events: [event],
    });
  }
  ok(`${trackerId} — ${tracker.events.length} events, milestone ${result.state.current}`);
}

console.log("");

for (const entry of CATALOGUE) {
  exchanges.put(recordFor(entry, now));

  // ⭐ A text edit over the source fixture rather than a re-serialisation, for
  // the reason src/case-input.mjs gives: applyPhotos sets the photographs and
  // leaves every other byte alone, so the copy holds the committed file's own
  // formatting and the "Add a photo" action can move it between rounds exactly
  // as it moves the original.
  if (entry.caseInput) {
    const source = readFileSync(caseInputPath(entry.caseInput.from), "utf8");
    const withPhotos = applyPhotos(source, entry.caseInput.round);
    const copied = withPhotos.replace(
      `"exchangeId": "${entry.caseInput.from}"`,
      `"exchangeId": "${entry.id}"`,
    );
    if (copied === withPhotos) {
      console.error(`✗ could not find the exchangeId line in fixtures/case/${entry.caseInput.from}.json`);
      process.exit(1);
    }
    writeFileSync(caseInputPath(entry.id), copied);
  } else {
    // Listing alone. A purchase with no case still needs one, or the view omits
    // the card entirely and says so in the log — see src/buyer-server.mjs.
    writeFileSync(
      caseInputPath(entry.id),
      `${JSON.stringify({ exchangeId: entry.id, listing: entry.listing }, null, 2)}\n`,
    );
  }

  if (entry.recording) {
    cases.write(caseRecordFor(entry, recordings.find(entry.recording)));
  }

  ok(`${entry.id}  ${entry.name}`);
}

console.log("");
console.log("Now start the view and open it with no purchase named:");
console.log("  npm run buyer");
console.log("  http://127.0.0.1:3100/");
console.log("");
console.log("One card per state. 99999907 answers a question — open it with a photograph named:");
console.log("  http://127.0.0.1:3100/?purchase=99999907&photo=carton");
console.log("");
console.log("Remove them all again with:");
console.log("  npm run demo-states -- --clean --execute");
