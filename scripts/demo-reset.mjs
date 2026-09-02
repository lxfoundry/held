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
import { DEFAULT_MAX_ROUNDS, deadlineFor, shouldMediate } from "../src/mediator.mjs";
import { applyPhotos, photoPathsFor, PHOTOS, ROUNDS } from "../src/case-fixture.mjs";
import { STATUS } from "../src/proposal.mjs";

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const warn = (line) => console.log(`⚠ ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

// The evidence each round holds, and the edit that moves the fixture between
// them, live in src/case-fixture.mjs — a pure function with a test that asserts
// the two rounds are exact inverses over the real fixture. That property is
// what keeps a reset off the bundle hash, so it is worth more as something
// tested than as something inline.

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const VALUED = ["round", "exchange"];
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

// ⚠️ Everything is a named flag here, and scripts/mediate.mjs takes the same
// exchange id positionally. So `npm run demo-reset -- 241` is the natural thing
// to type and, unguarded, silently resets the default exchange instead of the
// one named — a wrong case reset without a word on screen. Anything that is
// neither a known flag nor a known flag's value is refused rather than ignored,
// which also catches `--round` with its value left off.
const known = new Set(["--execute", ...VALUED.map((name) => `--${name}`)]);
const consumed = new Set();
for (const name of VALUED) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) continue;
  // ⚠️ A valued flag with its value left off is the other way to reset the
  // wrong thing quietly: `--round --execute` and a trailing `--round` both fall
  // back to round 1, which is a real round and reports as one. The flag helper
  // declines to read the next flag as a value; this says so out loud.
  if (args[i + 1] === undefined || args[i + 1].startsWith("--")) {
    console.error(`✗ --${name} needs a value`);
    console.error("  usage: node scripts/demo-reset.mjs [--round 1|2] [--exchange <id>] [--execute]");
    process.exit(1);
  }
  consumed.add(i + 1);
}
const stray = args.filter((value, i) => !consumed.has(i) && !known.has(value));
if (stray.length > 0) {
  console.error(`✗ unrecognised argument${stray.length === 1 ? "" : "s"}: ${stray.join(" ")}`);
  console.error("  usage: node scripts/demo-reset.mjs [--round 1|2] [--exchange <id>] [--execute]");
  console.error("  the exchange is named with --exchange, not positionally as scripts/mediate.mjs takes it");
  process.exit(1);
}

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

// ⚠️ ESCALATION_LEAD_MS belongs on this list because the mediator's `final` is
// the deadline *or* the cap, and a report that models only the cap is wrong in
// the silent direction — see where `final` is computed below. ANTHROPIC_API_KEY
// is deliberately absent: this script never calls the model, so `only` keeps it
// unable to hold the key rather than merely unlikely to send it.
const settings = loadEnv({
  only: ["EXCHANGES_DIR", "EVENTS_DIR", "MEDIATOR_MAX_ROUNDS", "ESCALATION_LEAD_MS"],
});
// Anchored to the repository rather than to wherever this was launched from,
// for the reason scripts/mediate.mjs gives: a store built somewhere else reads
// as empty, which is indistinguishable from an exchange that has no case.
const under = (value, fallback) => resolve(ROOT, value || fallback);
const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"));
const cases = createCaseStore(join(ROOT, "state/cases"));
const recordings = createRecordingStore(join(ROOT, "fixtures/case/recordings"));
const maxRounds = settings.MEDIATOR_MAX_ROUNDS ? Number(settings.MEDIATOR_MAX_ROUNDS) : DEFAULT_MAX_ROUNDS;
const escalateLeadMs = settings.ESCALATION_LEAD_MS ? Number(settings.ESCALATION_LEAD_MS) : null;

const record = exchanges.get(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId} under ${exchanges.dir}`);
  console.error("  state/ is gitignored, so a fresh clone has none — copy it across, or seed one");
  process.exit(1);
}

// ⭐ The same gate scripts/mediate.mjs applies, applied before the report rather
// than after it. Without it a case that mediate will refuse outright still reads
// here as healthy — "recorded, replays with no API call" — because the fixture
// and the case record really are in the state that was asked for. The report
// would be true about the files and wrong about what happens next.
//
// ⚠️ And this script cannot repair it: escalatedAt and finalisedAt live on the
// exchange record under state/, which is gitignored and which nothing here
// writes. Saying so is the whole value of failing here.
if (!shouldMediate(record)) {
  const why =
    record.disputeRaisedAt == null
      ? "has no open case — nothing to mediate, so nothing to reset"
      : record.escalatedAt != null
        ? "is escalated: a person has the case now, and mediate will refuse it"
        : "is finalised";
  console.error(`✗ exchange ${exchangeId} ${why}`);
  console.error(`  the reset cannot undo that — it is on the exchange record, which this script never writes`);
  process.exit(1);
}

const fixturePath = join(ROOT, `fixtures/case/${exchangeId}.json`);
if (!existsSync(fixturePath)) {
  console.error(`✗ no case definition at fixtures/case/${exchangeId}.json`);
  process.exit(1);
}
const before = readFileSync(fixturePath, "utf8");

// The edit itself is src/case-fixture.mjs — a text replacement over the
// photographs alone, not a re-serialisation, so the two rounds are inverses and
// a reset leaves no diff on a committed fixture. It throws rather than
// reporting, so how the failure reads is decided here.
let after;
try {
  after = applyPhotos(before, round);
} catch (err) {
  console.error(`✗ fixtures/case/${exchangeId}.json: ${err.message}`);
  console.error("  it is edited by hand as well as by this script, so it is checked rather than assumed");
  process.exit(1);
}

// Belt and braces over a text edit to a JSON file: what would be written must
// parse, and must hold exactly the photographs that were asked for.
let parsed;
try {
  parsed = JSON.parse(after);
} catch (err) {
  console.error(`✗ the edit would not have produced valid JSON — ${err.message}`);
  process.exit(1);
}
const wanted = photoPathsFor(round);
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

// ⭐ `final` is the deadline OR the cap, computed exactly as src/mediator.mjs
// computes it. Modelling only the cap is wrong in the silent direction: with the
// deadline passed, mediate runs round 1 *as* a final round, so a recorded
// needs_evidence comes back through the conclude path as the generic string in
// place of the model's own argument — while a cap-only report says "round 1 of
// 2" and "this round replays", both true and both beside the point. That is the
// exact failure this script exists to catch, so it is the one it must model
// correctly. The deadline is the protocol's, read from the record.
const deadline = deadlineFor(record, escalateLeadMs);
const outOfTime = deadline != null && Date.now() >= deadline;
const final = outOfTime || nextRound >= maxRounds;

// ⚠️ Round 1 enforces its precondition by clearing the record; round 2 has one
// too and can only report it. Round 2 is the second round only if the first is
// on file — with an empty record it numbers itself round 1, replays the round-1
// recording, and opens the demo on the payoff proposal with the question beat
// silently missing.
const roundTwoUnready = round === "2" && heldRounds !== 1;
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
const why = outOfTime ? " — final on the deadline, so the model must propose" : final ? " — final, so the model must propose" : "";
info(`next mediate  ${counted}${why}`);
const remaining = deadline == null ? null : deadline - Date.now();
info(
  `deadline      ${
    deadline == null
      ? "none — the record carries no resolution period"
      : `${new Date(deadline).toISOString()} — ${outOfTime ? "PASSED" : `${Math.floor(remaining / 3_600_000)}h left`}`
  }`
);

console.log("");
if (roundTwoUnready) {
  warn(`round 2 wants exactly one round on file and the record holds ${plural(heldRounds, "round")}.`);
  warn(`mediate would number this round ${nextRound}, not 2 — the opening question has not been run,`);
  warn("so the case would open on the proposal with the round the demo is about missing.");
  warn("run --round 1 --execute, then mediate, then come back to this.");
  console.log("");
}
if (!recorded) {
  warn(`bundle ${bundle.hash.slice(0, 12)} has NO recording: mediate will stop, or call the API with --execute`);
} else if (final && recorded.response?.status === STATUS.NEEDS_EVIDENCE) {
  warn(`bundle ${bundle.hash.slice(0, 12)} is recorded, but round ${nextRound} is final and the recording asks a`);
  warn("question — so it comes back through the conclude path: the provisional split under");
  warn('"Nothing further was provided in time", in place of the model\'s own reasoning.');
  warn(`delete fixtures/case/recordings/${bundle.hash.slice(0, 12)}….json and run mediate with --execute to`);
  warn("record a real final-round answer, or raise MEDIATOR_MAX_ROUNDS so this round may still ask.");
} else {
  ok(`bundle ${bundle.hash.slice(0, 12)} is recorded — this round replays with no API call and no network`);
}

// ⚠️ Reported whether or not the hash is currently recorded, because the run it
// matters on is the one that still replays. The dispute instant belongs to the
// protocol and arrives as whole seconds — scripts/watchdog.mjs reads it as
// Number(disputed) * 1000. A value carrying milliseconds is the local fallback
// in src/disputes.mjs, stamped when the read-back did not confirm in time; the
// chain's own value is a different number, and the next sweep merges it over
// this one. Every recording keyed on a bundle holding the fallback is missed at
// that moment, and nothing in the fixture shows why.
if (record.disputeRaisedAt != null && record.disputeRaisedAt % 1000 !== 0) {
  console.log("");
  warn(`disputeRaisedAt is ${record.disputeRaisedAt}, which carries milliseconds. The protocol's value is a`);
  warn("whole second, so this is the local fallback and the next watchdog sweep will overwrite it —");
  warn("moving the bundle hash and missing every recording keyed on it. Heal it before recording.");
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
