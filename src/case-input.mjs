// src/case-input.mjs
// The case input for one exchange: the listing block, the message thread and
// the photographs the mediator reads — fixtures/case/<exchangeId>.json in
// production (scripts/mediate.mjs reads the same file), exercised here on
// whatever directory a caller points it at.
//
// addPhoto is the only writer, and it never uploads or writes image bytes: it
// appends a reference to a photograph that already exists under
// <dir>/photos/, in the shape already used there — { id, path, media_type }.
// `path` is always repo-root-relative (fixtures/case/photos/<id>.jpg) because
// that is what scripts/mediate.mjs resolves it against, never against this
// store's own directory — which a test deliberately points elsewhere so the
// committed fixtures are never touched.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JPEG_EXT = ".jpg";

// Thrown for a photo id that names nothing under <dir>/photos/ — including a
// traversal attempt, which is simply another id that is not on the list.
export class UnknownPhotoError extends Error {
  constructor(id) {
    super(`no such photograph: ${JSON.stringify(id)}`);
    this.name = "UnknownPhotoError";
  }
}

export function createCaseInputStore(dir) {
  mkdirSync(dir, { recursive: true });
  const photosDir = join(dir, "photos");

  // Sanitised, as src/cases.mjs already does for the same identifier: an
  // exchange id reaches here only after the server's own route regex has
  // already constrained it to digits, so this is a second, cheap floor rather
  // than the only one.
  const pathFor = (exchangeId) => join(dir, `${String(exchangeId).replace(/[^0-9A-Za-z_-]/g, "")}.json`);

  function read(exchangeId) {
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  // ⚠️ The whitelist, not a pattern. A photo id becomes a path, so it is
  // validated against photographs that actually exist on disk rather than
  // sanitised — a sanitised traversal attempt is still an attempt to read
  // something outside <dir>/photos/, and the right answer to that is refusal,
  // not a best-effort fix-up. See isSafeTrackerId in src/store.mjs for the
  // same reasoning applied to a tracker id before it becomes a filename.
  function knownPhotoIds() {
    let names;
    try {
      names = readdirSync(photosDir);
    } catch (err) {
      if (err.code === "ENOENT") return new Set();
      throw err;
    }
    return new Set(
      names.filter((name) => name.endsWith(JPEG_EXT)).map((name) => name.slice(0, -JPEG_EXT.length)),
    );
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
    if (!knownPhotoIds().has(photoId)) throw new UnknownPhotoError(photoId);

    const existing = read(exchangeId) ?? { exchangeId: String(exchangeId), photos: [] };
    const photos = existing.photos ?? [];
    const path = `fixtures/case/photos/${photoId}${JPEG_EXT}`;

    // ⚠️ Fix round 1, item 1: keyed on `path`, never on `id`. `id` is a
    // logical slot ("the outer carton photograph"), not a filename stem — the
    // committed fixtures show the same id ("carton") pointing at carton.jpg in
    // one case and carton-crushed.jpg in another, because the two are two
    // branches of the same scenario. `path` is what scripts/mediate.mjs
    // actually keys evidence on (read the bytes from, hash, and label the
    // model's attachment by) — nothing downstream reads this store's own `id`
    // field at all — so path is the only identity "already here" can mean.
    // Deduping on id instead would both let two different photographs share
    // one id as if they were the same evidence, and block a genuinely new
    // photograph from ever being attached because some other branch already
    // used its id for a different file.
    if (photos.some((p) => p.path === path)) return existing;

    const record = {
      ...existing,
      exchangeId: existing.exchangeId ?? String(exchangeId),
      photos: [...photos, { id: photoId, path, media_type: "image/jpeg" }],
    };

    writeAtomic(pathFor(exchangeId), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  return { read, addPhoto };
}
