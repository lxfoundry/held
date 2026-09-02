#!/usr/bin/env node
// Run one round of mediation on a case.
//
//   node scripts/mediate.mjs <exchangeId>
//   node scripts/mediate.mjs <exchangeId> --execute
//
// ⭐ The composition root: the only place callModel, the recording store, the
// case store and the evidence sources are wired together. Without it Tasks 1-6
// are libraries nothing calls.
//
// ⭐ Also the only place base64 is produced. Photographs are read from disk here
// and handed to the model call, so a bundle and a recording carry a path and a
// digest and never image bytes — which is what keeps megabytes out of git on
// every round.
//
// ⚠️ Without --execute it will replay a recording but never call the model, so
// a dry run costs nothing and cannot spend a request. The same meaning
// --execute carries in scripts/seed-exchange.mjs and scripts/confirm-receipt.mjs.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, ROOT } from "../src/env.mjs";
import { assembleBundle } from "../src/evidence.mjs";
import { createExchangeStore } from "../src/exchanges.mjs";
import { createStore } from "../src/store.mjs";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";
import { callModel } from "../src/model.mjs";
import { DEFAULT_MAX_ROUNDS, isNewRound, mediate, shouldMediate } from "../src/mediator.mjs";
import { forParty } from "../src/proposal.mjs";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const requested = args.find((value) => !value.startsWith("--")) ?? null;
if (!requested || !/^\d+$/.test(requested)) {
  console.error("✗ usage: node scripts/mediate.mjs <exchangeId> [--execute]");
  console.error("  without --execute a recorded round replays and an unrecorded one stops");
  process.exit(1);
}
const exchangeId = String(Number(requested));

// ⚠️ Every setting arrives through loadEnv, including the provider key. Nothing
// in this repository reads process.env outside src/env.mjs: loadEnv parses .env
// without mutating the environment, so `new Anthropic()` with no argument would
// find nothing, and MEDIATOR_MODEL read off process.env would be dead config
// failing silently.
const settings = loadEnv({
  only: [
    "EXCHANGES_DIR",
    "EVENTS_DIR",
    "ANTHROPIC_API_KEY",
    "MEDIATOR_MODEL",
    "MEDIATOR_MAX_ROUNDS",
    "ESCALATION_LEAD_MS",
  ],
  required: execute ? ["ANTHROPIC_API_KEY"] : [],
});

// Anchored to the repository, not to wherever this was launched from — the same
// reasoning as scripts/watchdog.mjs. A store built somewhere else reads as empty
// here, which for this component looks identical to an exchange that has no case.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const trackers = createStore(under(settings.EVENTS_DIR, "fixtures/events"));
// Two stores with different lifetimes: a case is live working state under
// state/, a recording is read by the replay path and is committed.
const cases = createCaseStore(join(ROOT, "state/cases"));
const recordings = createRecordingStore(join(ROOT, "fixtures/case/recordings"));

const record = exchanges.get(exchangeId);
if (!record) {
  console.error(`✗ no record for exchange ${exchangeId} under ${exchanges.dir}`);
  process.exit(1);
}

// ⭐ The single trigger, and it is the module's own. Delivery state, evidence
// quality and which rung of the ladder the case resembles have no part in it,
// and neither does who raised the dispute.
if (!shouldMediate(record)) {
  const why =
    record.disputeRaisedAt == null
      ? "has no open case — nothing to mediate"
      : record.escalatedAt != null
        ? "is escalated: a person has the case now"
        : "is finalised";
  console.error(`✗ exchange ${exchangeId} ${why}`);
  process.exit(1);
}

const caseInput = JSON.parse(readFileSync(join(ROOT, `fixtures/case/${exchangeId}.json`), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Read once: the bytes go to the model, the digest goes in the bundle.
const photos = caseInput.photos.map((p) => {
  const bytes = readFileSync(join(ROOT, p.path));
  return { path: p.path, media_type: p.media_type, sha256: sha256(bytes), base64: bytes.toString("base64") };
});

const bundle = assembleBundle({
  exchangeId,
  tracking: { events: trackers.read(record.trackerId)?.events ?? [] },
  // ⭐ What the protocol settled, which is the only provenance the model is told
  // is settled. The price is not among them: the action space is a percentage of
  // a pot both parties already agreed to lock, so the absolute amount changes
  // nothing about the decision and stating one the record does not hold would be
  // an invention with `chain` provenance on it.
  offerTerms: {
    redeemedAt: record.redeemedAt,
    disputePeriodMs: record.disputePeriodMs,
    resolutionPeriodMs: record.resolutionPeriodMs,
    disputeRaisedAt: record.disputeRaisedAt,
  },
  photos: photos.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
  messages: caseInput.messages,
  listing: caseInput.listing,
  viewer: "mediator",
});

// The bundle assigns the ids, so the image blocks are labelled with the same
// ids a finding will cite. Without this the photographs are an unlabelled pile.
const byPath = new Map(bundle.items.filter((i) => i.kind === "photo").map((i) => [i.content.path, i.id]));
const attachments = photos.map((p) => ({ id: byPath.get(p.path), media_type: p.media_type, base64: p.base64 }));

const system = readFileSync(join(ROOT, "fixtures/case/system.md"), "utf8");

const existing = cases.read(exchangeId) ?? { exchangeId, rounds: [], model: null, closedAt: null, outcome: null };
// ⚠️ Not rounds.length + 1 unconditionally. A re-run against a bundle nobody
// added to is the same round asked again, and numbering it as the next one
// walks the case into the cap. See isNewRound.
const opening = isNewRound(existing, bundle.hash);
const round = existing.rounds.length + (opening ? 1 : 0);

console.log(`exchange ${exchangeId} — round ${round}, bundle ${bundle.hash.slice(0, 12)}`);
console.log(`  ${bundle.items.length} evidence items, ${attachments.length} photograph${attachments.length === 1 ? "" : "s"}`);

// Before the model is reached at all, and before the dry-run branch below: the
// cost this guards against is not a request, it is a round. A dry run spent one
// too, because it exits early only when there is no recording to replay.
if (!opening) {
  console.log(`
· same bundle as round ${round} — nothing new to mediate`);
  console.log(JSON.stringify(forParty(existing.rounds.at(-1)), null, 2));
  process.exit(0);
}

if (!execute && !recordings.find(bundle.hash)) {
  console.log(`\nbundle ${bundle.hash.slice(0, 12)} has no recording — re-run with --execute to call the model`);
  process.exit(0);
}

const client = new Anthropic({ apiKey: settings.ANTHROPIC_API_KEY });
const result = await mediate({
  bundle,
  record,
  now: Date.now(),
  // ⚠️ Passed, not defaulted away. The round is derived from what has been
  // recorded, so a caller that omits this pins every call at round one and the
  // cap this component owns is never reached.
  caseRecord: existing,
  maxRounds: settings.MEDIATOR_MAX_ROUNDS ? Number(settings.MEDIATOR_MAX_ROUNDS) : DEFAULT_MAX_ROUNDS,
  // The same override the watchdog takes, so a demonstration configuration moves
  // both together or neither: mediation runs inside a window the watchdog guards.
  escalateLeadMs: settings.ESCALATION_LEAD_MS ? Number(settings.ESCALATION_LEAD_MS) : null,
  deps: {
    call: ({ bundle: b, system: s, photos: ph, final }) =>
      callModel({ client, bundle: b, system: s, photos: ph, final, model: settings.MEDIATOR_MODEL ?? null }),
    recordings,
  },
  system,
  photos: attachments,
});

// Which model produced it, taken from the recording rather than from the result:
// the result is schema-bound and has no room for it, and the case file states
// the model rather than leaving it to be inferred from a deployment date.
const model = recordings.find(bundle.hash)?.model ?? existing.model;
// The hash is kept with the round so the next run can tell whether the evidence
// moved. Without it a case file records what was answered but not what it was
// answered about, and the question above cannot be asked.
cases.write({ ...existing, model, rounds: [...existing.rounds, { ...result, bundleHash: bundle.hash }] });

console.log(result.replayed ? "\n· replayed from a recording" : `\n· called the model (${model})`);
// ⚠️ forParty, always. wouldChange, provisional and assumed never reach a
// surface a party can read, and a console is a surface.
console.log(JSON.stringify(forParty(result), null, 2));
