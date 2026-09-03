#!/usr/bin/env node
// Give an exchange the case file it does not have.
//
//   node scripts/new-case.mjs <exchangeId>
//   node scripts/new-case.mjs <exchangeId> --title "Teak bench" --price 75
//   node scripts/new-case.mjs <exchangeId> --photos --messages --execute
//
// ⭐ The evidence a case carries divides in two. The tracking comes from the
// carrier and the offer terms come from the chain, so both arrive on their own
// for any exchange that exists. The listing, the message thread and the
// photographs came from people, and nothing can derive them — which is why a
// freshly seeded exchange has no case file, and why scripts/mediate.mjs, which
// reads one unconditionally, stops on an exchange that has never had one.
//
// This writes the smallest file that is still a case: a listing, and whichever
// of the other two are asked for.
//
// ⚠️ `--photos` and `--messages` take no value. They are the demonstrated case's
// own opening evidence — the photograph of the damaged item, and the buyer
// saying it arrived that way — not arbitrary content. Anything else is a text
// editor's job, and the file is small enough to be one.
//
// ⭐ It plans and stops by default, the same meaning --execute carries in
// scripts/demo-states.mjs, which writes this same kind of file into this same
// committed directory.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { buildCaseInput } from "../src/case-fixture.mjs";

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);

const USAGE =
  "  usage: node scripts/new-case.mjs <exchangeId> [--title T] [--body B] [--price N] [--photos] [--messages] [--execute]";

const args = process.argv.slice(2);
const BOOLEAN = new Set(["--photos", "--messages", "--execute"]);
const VALUED = new Set(["--title", "--body", "--price"]);

// ⚠️ A valued flag with its value left off would otherwise swallow the next
// flag as its value — `--title --execute` would title the case "--execute" and
// silently not execute. Reading the value only when it is not itself a flag is
// what turns that into a refusal.
const values = new Map();
const consumed = new Set();
for (const [i, arg] of args.entries()) {
  if (!VALUED.has(arg)) continue;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`✗ ${arg} needs a value`);
    console.error(USAGE);
    process.exit(1);
  }
  values.set(arg, value);
  consumed.add(i + 1);
}

const positional = args.filter((arg, i) => !consumed.has(i) && !arg.startsWith("--"));
const stray = args.filter((arg, i) => !consumed.has(i) && arg.startsWith("--") && !BOOLEAN.has(arg) && !VALUED.has(arg));
if (stray.length > 0) {
  console.error(`✗ unrecognised argument${stray.length === 1 ? "" : "s"}: ${stray.join(" ")}`);
  console.error(USAGE);
  process.exit(1);
}

// The same shape scripts/mediate.mjs accepts, and normalised the same way, so a
// file this writes is a file that script can find. An id it would reject is one
// this would name a file nothing ever reads.
const [requested, ...extra] = positional;
if (!requested || !/^\d+$/.test(requested) || extra.length > 0) {
  console.error("✗ one exchange id is required, and it is digits");
  console.error(USAGE);
  process.exit(1);
}
const exchangeId = String(Number(requested));

const price = values.get("--price");
if (price !== undefined && !/^\d+(\.\d+)?$/.test(price)) {
  console.error(`✗ --price takes a number, not ${JSON.stringify(price)}`);
  process.exit(1);
}

const text = buildCaseInput({
  exchangeId,
  title: values.get("--title") ?? null,
  body: values.get("--body") ?? null,
  price: price ?? 200,
  photos: args.includes("--photos"),
  messages: args.includes("--messages"),
});

const target = join(ROOT, `fixtures/case/${exchangeId}.json`);
const relative = `fixtures/case/${exchangeId}.json`;

// ⚠️ Refused rather than merged or backed up. This directory holds the
// demonstrated case, and the cost of a mistyped id is overwriting the evidence
// a recorded round is keyed on — at which point the bundle hash moves and a
// replay becomes a live call, with nothing on screen saying so.
if (existsSync(target)) {
  console.error(`✗ ${relative} already exists`);
  console.error("  delete it first if you mean to replace it — this never overwrites a case");
  process.exit(1);
}

console.log(`\n▶ exchange ${exchangeId} — a new case at ${relative}\n`);
console.log(text);

if (!args.includes("--execute")) {
  console.log("nothing was written. Apply it with:");
  // ⚠️ Quoted on the way back out. A title is the one argument here that
  // ordinarily holds spaces, and a hint that drops the quotes is a command that
  // reads the second word as the next argument — offered by the tool itself,
  // which is the worst place to learn that.
  const asTyped = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
  info(`npm run new-case -- ${asTyped} --execute`);
  process.exit(0);
}

writeFileSync(target, text);
ok(`${relative} written`);
info(`open the case with: npm run raise -- ${exchangeId} --execute`);
info(`then run a round with: npm run mediate -- ${exchangeId} --execute`);
