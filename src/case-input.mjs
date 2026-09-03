// src/case-input.mjs
// The case input for one exchange: the listing block, the message thread and
// the photographs the mediator reads — fixtures/case/<exchangeId>.json in
// production (scripts/mediate.mjs reads the same file), exercised here on
// whatever directory a caller points it at.
//
// addPhoto is the only writer, and it never uploads or writes image bytes. It
// sets the photographs the case holds to the round that adds the one named,
// through src/case-fixture.mjs's applyPhotos — the same edit scripts/demo-reset.mjs
// makes, so the two paths that move a case between rounds are one function and
// one format.
//
// ⚠️ It is a text replacement over the photographs alone, never a
// re-serialisation, and that is the whole reason it goes through case-fixture
// rather than JSON.stringify. This file is committed. Re-serialising it would
// reformat the messages and the listing too — a large diff on a file nothing
// else had touched — and would leave the photographs in a shape applyPhotos no
// longer restores byte for byte. That inverse property is what
// test/case-fixture.test.mjs asserts against the real file, and a writer that
// broke it would break it on the first press rather than in a test.
//
// Photograph paths stay repo-root-relative (fixtures/case/photos/<name>.jpg)
// because that is what scripts/mediate.mjs resolves them against, never against
// this store's own directory — which a test deliberately points elsewhere so the
// committed files are never written to.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addablePhotos, applyPhotos, roundAdding, roundStoodAt } from "./case-fixture.mjs";

// Thrown for a photo id that names no photograph a case can be moved to hold —
// including a traversal attempt, which is simply another id that is not on the
// list.
export class UnknownPhotoError extends Error {
  constructor(id) {
    super(`no such photograph: ${JSON.stringify(id)}`);
    this.name = "UnknownPhotoError";
  }
}

// Thrown when the case a photograph would join does not exist. A named class
// rather than a plain Error because a caller has to be able to tell "there is
// nothing here to add to" from "this component is broken" — the same
// distinction an unwired action draws by answering 501 instead of 500.
export class NoCaseInputError extends Error {
  constructor(id) {
    super(`no case input at ${id}.json — a photograph is added to a case that exists, never used to create one`);
    this.name = "NoCaseInputError";
  }
}

// Thrown when the case exists but is not one these photographs describe. The
// rounds in src/case-fixture.mjs are the evidence of one demonstrated case, and
// applying one sets the whole list at once — so on any other case this action
// would not add a photograph, it would replace that case's evidence with
// another case's, silently, in the component the mediator reads to decide.
//
// ⭐ The refusal is the same rule NoCaseInputError states one step earlier, and
// docs/specs/buyer-view.md §8.3 states as "an absent case is refused rather than
// invented": this action attaches a photograph that already exists to a case
// that already holds its predecessors, and where either is untrue there is
// nothing here to add. A case holding no photographs at all is that — the
// opening round *is* the first photograph, so there is no move that reaches it.
export class ForeignCaseError extends Error {
  constructor(id, stood) {
    super(
      `case ${id} stands at ${stood ? `round ${stood}` : "no round these photographs define"}` +
        " — adding one here would replace its evidence rather than extend it"
    );
    this.name = "ForeignCaseError";
  }
}

export function createCaseInputStore(dir) {
  mkdirSync(dir, { recursive: true });

  // Sanitised, as src/cases.mjs already does for the same identifier: an
  // exchange id reaches here only after the server's own route regex has
  // already constrained it to digits, so this is a second, cheap floor rather
  // than the only one.
  const safeId = (exchangeId) => String(exchangeId).replace(/[^0-9A-Za-z_-]/g, "");
  const pathFor = (exchangeId) => join(dir, `${safeId(exchangeId)}.json`);

  function read(exchangeId) {
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  // Atomic, as src/exchanges.mjs's put(): a private temporary file, then a
  // rename. A half-written case input read by the mediator mid-write would be
  // worse than no write at all.
  function writeAtomic(target, contents) {
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, contents);
    renameSync(temp, target);
  }

  // ⭐ photoId is optional, and its absence is the ordinary case rather than an
  // error. The buyer presses one button; which photograph that attaches is a
  // lookup in the rounds table, not a question to put to them — the
  // photographs of the outer carton are one evidence slot holding competing
  // versions of the same fact, and which version is true is what the mediator
  // reads the evidence to find out. An operator naming one selects the branch; nobody
  // naming one takes the first the rounds declare.
  //
  // ⚠️ Not "the photograph this case does not yet hold". Applying the round a
  // case already stands in reproduces its text exactly, so a repeat is a
  // no-op that still answers 200 — which is a simpler and more honest
  // behaviour than a second rule about what is left to add.
  function addPhoto(exchangeId, photoId = null) {
    const wanted = photoId ?? addablePhotos()[0] ?? null;
    // ⚠️ The allowlist, and it is neither a pattern nor a directory listing. A
    // photo id names a round, and the rounds are a closed table of acceptable
    // strings held in source — so a traversal attempt is refused for naming no
    // round, with no path ever built from it and nothing read off disk to
    // decide. See isSafeTrackerId in src/store.mjs for the same reasoning
    // applied to a tracker id before it becomes a filename.
    const round = roundAdding(wanted);
    if (!round) throw new UnknownPhotoError(wanted);

    const target = pathFor(exchangeId);
    let before;
    try {
      before = readFileSync(target, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // ⚠️ Never created here. The photographs are one region of a file that
      // also carries the listing and the message thread, so a file written by
      // this action alone would hold photographs and neither of those — which
      // the buyer's view omits for having no listing, and the mediator reads as
      // a case with no thread. An absent case input is the operator's to fix,
      // and refusing says so where a plausible-looking file would not.
      throw new NoCaseInputError(safeId(exchangeId));
    }

    // ⚠️ Which case this is, checked before it is written. applyPhotos sets the
    // whole list of photographs at once, so on a case that is not this one it
    // does not add — it replaces that case's evidence with this one's, and
    // reports success.
    //
    // The check is "stands at a round these photographs define", and not "at
    // the round this move opens from", because the branches are alternatives
    // within one slot: a case at 2b takes the intact carton and becomes a case
    // at 2, which is the rule §8.3 states and the two tests above it pin. Any
    // round is therefore this case; no round is some other case, including a
    // case holding no photographs at all, since the opening round *is* the
    // first photograph and no move reaches it.
    const stood = roundStoodAt(JSON.parse(before));
    if (stood === undefined) throw new ForeignCaseError(safeId(exchangeId), stood);

    const after = applyPhotos(before, round);
    // Belt and braces over a text edit to a JSON file, the check
    // scripts/demo-reset.mjs makes for the same reason: what would be written
    // must parse, and it is parsed before the write rather than after, so text
    // that would not parse is never the text on disk.
    const record = JSON.parse(after);

    // ⭐ Idempotency, and it costs nothing. The same photograph in the same slot
    // renders to the same region, so a repeat leaves the file untouched instead
    // of rewriting it with its own contents — which is applyPhotos's own
    // inverse property (test/case-fixture.test.mjs asserts applyPhotos(committed, 2)
    // === committed) arriving here as behaviour.
    if (after !== before) writeAtomic(target, after);
    return record;
  }

  return { read, addPhoto };
}
