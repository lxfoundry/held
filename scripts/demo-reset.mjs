#!/usr/bin/env node
// Put a mediated case back at its first round, and say whether it will replay.
//
//   node scripts/demo-reset.mjs                       # report, change nothing
//   node scripts/demo-reset.mjs --execute             # back to round 1
//   node scripts/demo-reset.mjs --round 2 --execute   # the buyer has added the carton
//
// ⭐ Two things degrade a demonstration run silently, and this is the only
// place that checks both.
//
// The round counter lives in state/cases/<id>.json and scripts/mediate.mjs
// derives the round from it. Replaying round 1 against a record that already
// holds two rounds numbers it round 3, which reaches the cap, which returns the
// recording through the conclude path — the model's own argument replaced by
// "Nothing further was provided in time". Same recording, generic answer, and
// nothing on screen says so.
//
// And a recording is keyed on the bundle hash, so anything that moves the hash
// turns a free replay into a live call: a re-shot photograph, an edited message,
// or a plain watchdog sweep, which merges disputeRaisedAt back from chain at
// second precision over the millisecond value scripts/raise-dispute.mjs wrote.
//
// ⚠️ So the verdict is the point and the reset is the side effect. A run
// reporting the hash is recorded is a promise that the round costs nothing and
// needs no network; a run reporting it is not is a warning that the demo will
// call the API, on whatever wifi the room has.
//
// ⭐ It plans and stops by default — the same meaning --execute carries in
// scripts/seed-exchange.mjs, confirm-receipt.mjs, raise-dispute.mjs and
// mediate.mjs. Nothing here touches the chain or spends money either way; what
// --execute guards is a committed fixture and a case record.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv, ROOT } from "../src/env.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createStore } from "../src/store.mjs";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";
import { DEFAULT_MAX_ROUNDS } from "../src/mediator.mjs";
import { STATUS } from "../src/proposal.mjs";

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const warn = (line) => console.log(`⚠ ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

// The photographs the case moves between, held here rather than read off the
// fixture: at round 1 the fixture does not mention the carton, so a script that
// learned the evidence from the file could never put it back.
//
// ⚠️ carton-crushed.jpg is deliberately absent. It is branch B of the
// controlled comparison and has no committed recording, so offering it as a
// demo state would be offering a live API call as a demo state.
const PHOTOS = {
  inner: { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
  carton: { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
};

// The case in full, as evidence: the mediator asks for the outer carton, the
// buyer adds it, the number moves. Round 2 is round 1 plus one photograph, and
// that one photograph is the entire difference between the two bundle hashes.
const ROUNDS = { 1: ["inner"], 2: ["inner", "carton"] };

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  // ⚠️ The next token is a value only if it does not itself look like a flag —
  // the same guard scripts/seed-exchange.mjs gives its reasons for. Here
  // `--exchange --execute` would otherwise name exchange "--execute", which
  // reads back as a missing record rather than as the typo it is.
  return value === undefined || value.startsWith("--") ? fallback : value;
};

const round = flag("round", "1");
const requested = flag("exchange", "241");
if (!ROUNDS[round]) {
  console.error(`✗ --round takes ${Object.keys(ROUNDS).join(" or ")}, not ${JSON.stringify(round)}`);
  process.exit(1);
}
if (!/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested))) {
  console.error(`✗ --exchange expects a whole exchange id, not ${JSON.stringify(requested)}`);
  process.exit(1);
}
const exchangeId = String(Number(requested));

const settings = loadEnv({ only: ["EXCHANGES_DIR", "EVENTS_DIR", "MEDIATOR_MAX_ROUNDS"] });
// Anchored to the repository rather than to wherever this was launched from,
// for the reason scripts/mediate.mjs gives: a store built somewhere else reads
// as empty, which is indistinguishable from an exchange that has no case.
const under = (value, fallback) => resolve(ROOT, value || fallback);
const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"));
const cases = createCaseStore(join(ROOT, "state/cases"));
const recordings = createRecordingStore(join(ROOT, "fixtures/case/recordings"));
const maxRounds = settings.MEDIATOR_MAX_ROUNDS ? Number(settings.MEDIATOR_MAX_ROUNDS) : DEFAULT_MAX_ROUNDS;

const record = exchanges.get(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId} under ${exchanges.dir}`);
  console.error("  state/ is gitignored, so a fresh clone has none — copy it across, or seed one");
  process.exit(1);
}

const fixturePath = join(ROOT, `fixtures/case/${exchangeId}.json`);
if (!existsSync(fixturePath)) {
  console.error(`✗ no case definition at fixtures/case/${exchangeId}.json`);
  process.exit(1);
}
const before = readFileSync(fixturePath, "utf8");

// ⭐ A text replacement over the photographs alone, not a re-serialisation of
// the file. JSON.stringify would reformat the messages and the listing too,
// turning every reset into a large diff on a committed fixture — and whichever
// round the demo happened to end on would be the one that got committed.
// Replacing the one region means round 2 restores the file byte for byte.
const PHOTOS_BLOCK = /"photos":\s*\[[^\]]*\]/;
const rendered = ROUNDS[round]
  .map((name) => {
    const p = PHOTOS[name];
    return `    { "id": "${p.id}", "path": "${p.path}", "media_type": "${p.media_type}" }`;
  })
  .join(",\n");
if (!PHOTOS_BLOCK.test(before)) {
  console.error(`✗ could not find the photos array in fixtures/case/${exchangeId}.json`);
  console.error("  it is edited by hand as well as by this script, so it is checked rather than assumed");
  process.exit(1);
}
const after = before.replace(PHOTOS_BLOCK, `"photos": [\n${rendered}\n  ]`);

// Belt and braces over a text edit to a JSON file: what would be written must
// parse, and must hold exactly the photographs that were asked for.
let parsed;
try {
  parsed = JSON.parse(after);
} catch (err) {
  console.error(`✗ the edit would not have produced valid JSON — ${err.message}`);
  process.exit(1);
}
const wanted = ROUNDS[round].map((name) => PHOTOS[name].path);
if (JSON.stringify(parsed.photos.map((p) => p.path)) !== JSON.stringify(wanted)) {
  console.error("✗ the edit did not produce the photographs it was asked for");
  process.exit(1);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");

// Assembled exactly as scripts/mediate.mjs assembles it, offer terms included —
// which is what makes this an answer about the run that will actually happen
// rather than about a bundle that resembles it.
const bundle = assembleBundle({
  exchangeId,
  tracking: { events: trackers.read(record.trackerId)?.events ?? [] },
  offerTerms: {
    redeemedAt: record.redeemedAt,
    disputePeriodMs: record.disputePeriodMs,
    resolutionPeriodMs: record.resolutionPeriodMs,
    disputeRaisedAt: record.disputeRaisedAt,
  },
  photos: parsed.photos.map((p) => ({ path: p.path, sha256: sha256(p.path) })),
  messages: parsed.messages,
  listing: parsed.listing,
  viewer: "mediator",
});

// ⭐ Round 1 clears the case record; round 2 must not. Round 2 is only the
// second round if the first one is on file — clearing it here would number the
// step round 1 and quietly demote the payoff into the opening question.
const casePath = join(ROOT, "state/cases", `${exchangeId}.json`);
const existing = cases.read(exchangeId);
const clearing = round === "1" && existsSync(casePath);
const heldRounds = existing?.rounds?.length ?? 0;
const nextRound = (clearing ? 0 : heldRounds) + 1;
const final = nextRound >= maxRounds;
const recorded = recordings.find(bundle.hash);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

step(`exchange ${exchangeId} — case at round ${round}`);
info(`evidence      ${ROUNDS[round].map((n) => PHOTOS[n].path.split("/").pop()).join(" + ")}`);
info(`fixture       fixtures/case/${exchangeId}.json — ${after === before ? "already correct" : "would be rewritten"}`);
info(
  clearing
    ? `case record   state/cases/${exchangeId}.json holds ${plural(heldRounds, "round")} — would be deleted`
    : `case record   ${plural(heldRounds, "round")} on file, kept`
);
info(`bundle        ${bundle.hash.slice(0, 12)} — ${plural(bundle.items.length, "item")}, ${plural(parsed.photos.length, "photograph")}`);
// "round 3 of 2" is accurate and reads like a bug, so past the cap says so in
// words. It is a state an operator can reach by stepping without resetting.
const counted = nextRound > maxRounds ? `round ${nextRound}, past the cap of ${maxRounds}` : `round ${nextRound} of ${maxRounds}`;
info(`next mediate  ${counted}${final ? " — final, so the model must propose" : ""}`);

console.log("");
if (!recorded) {
  warn(`bundle ${bundle.hash.slice(0, 12)} has NO recording: mediate will stop, or call the API with --execute`);
  // The one cause that leaves no trace in the fixture, so it is named rather
  // than left to be found. Everything else that moves the hash is something an
  // operator did on purpose and can see.
  if (record.disputeRaisedAt != null && record.disputeRaisedAt % 1000 === 0) {
    warn(`disputeRaisedAt is ${record.disputeRaisedAt}, a whole second — a watchdog sweep has merged it back`);
    warn("from chain over the millisecond value, and that alone is enough to miss every recording");
  }
} else if (final && recorded.response?.status === STATUS.NEEDS_EVIDENCE) {
  warn(`bundle ${bundle.hash.slice(0, 12)} is recorded, but round ${nextRound} is final and the recording asks a`);
  warn("question — so it comes back through the conclude path: the provisional split under");
  warn('"Nothing further was provided in time", in place of the model\'s own reasoning.');
  warn(`delete fixtures/case/recordings/${bundle.hash.slice(0, 12)}….json and run mediate with --execute to`);
  warn("record a real final-round answer, or raise MEDIATOR_MAX_ROUNDS so this round may still ask.");
} else {
  ok(`bundle ${bundle.hash.slice(0, 12)} is recorded — this round replays with no API call and no network`);
}

if (!execute) {
  console.log("");
  console.log("nothing was written. Apply it with:");
  console.log(`  npm run demo-reset --${round === "1" ? "" : ` --round ${round}`} --execute`);
  process.exit(0);
}

console.log("");
if (clearing) {
  rmSync(casePath);
  ok(`state/cases/${exchangeId}.json deleted — the next round is round 1 again`);
}
if (after !== before) {
  writeFileSync(fixturePath, after);
  ok(`fixtures/case/${exchangeId}.json set to the round-${round} evidence`);
}
console.log("");
console.log(`Run it with: npm run mediate -- ${exchangeId}`);
