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
import { applyPhotos, roundAdding } from "./case-fixture.mjs";

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

  function addPhoto(exchangeId, photoId) {
    // ⚠️ The allowlist, and it is neither a pattern nor a directory listing. A
    // photo id names a round, and the rounds are a table of two acceptable
    // strings held in source — so a traversal attempt is refused for naming no
    // round, with no path ever built from it and nothing read off disk to
    // decide. See isSafeTrackerId in src/store.mjs for the same reasoning
    // applied to a tracker id before it becomes a filename.
    const round = roundAdding(photoId);
    if (!round) throw new UnknownPhotoError(photoId);

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
