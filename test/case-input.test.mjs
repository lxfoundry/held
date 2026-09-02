// test/case-input.test.mjs
// The case input store: the listing/photos/messages file the mediator reads
// (fixtures/case/<exchangeId>.json in production) and the one the "Add a photo"
// action rewrites.
//
// ⚠️ Nothing here writes into fixtures/case/. Every test builds a fresh
// temporary directory and seeds it, so the committed files stay byte for byte
// unchanged whatever a test does.
//
// ⭐ The committed fixture's *text* is read, and only read. The property under
// test is that the store's write is an exact inverse over that file's own
// formatting — a stand-in with tidy spacing would assert nothing, because the
// failure being guarded against is a writer that produces the same data in a
// different shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import { applyPhotos } from "../src/case-fixture.mjs";
import { createCaseInputStore, UnknownPhotoError } from "../src/case-input.mjs";

const committed = readFileSync(join(ROOT, "fixtures/case/241.json"), "utf8");
// The same case before anything has been added to it. Built with the pure
// function rather than written out by hand, so the seed carries the committed
// file's formatting rather than a tidied copy of it.
const opening = applyPhotos(committed, 1);

// ⚠️ The case with its outer-carton slot already filled by the other branch.
// src/case-fixture.mjs's PHOTOS table gives `carton` and `carton-crushed` the
// same id — "carton" — because the outer carton is one evidence slot and the two
// photographs are two branches competing for it. Two tests below turn on that,
// so it is checked here rather than described in a comment: a table that stopped
// sharing the id would fail loudly instead of leaving those tests asserting
// nothing.
const otherBranch = applyPhotos(committed, "2b");

test("the two branch photographs share one evidence slot", () => {
  const [, carton] = JSON.parse(otherBranch).photos;
  assert.equal(carton.id, "carton");
  assert.equal(carton.path, "fixtures/case/photos/carton-crushed.jpg");
});

// A fresh case directory holding one case file, seeded as text so the store is
// exercised on the formatting a real case input has. `null` seeds nothing.
function freshDir(text = opening) {
  const dir = mkdtempSync(join(tmpdir(), "held-case-input-"));
  if (text !== null) writeFileSync(join(dir, "241.json"), text);
  return dir;
}

test("read on a case with no file yet is null, not an error", () => {
  assert.equal(createCaseInputStore(freshDir(null)).read("241"), null);
});

test("a photograph is written in the shape scripts/mediate.mjs reads", () => {
  const store = createCaseInputStore(freshDir());
  const record = store.addPhoto("241", "carton");
  assert.deepEqual(record.photos, [
    { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
    { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  ]);
  assert.deepEqual(store.read("241").photos, record.photos);
});

test("either branch photograph can be attached", () => {
  const store = createCaseInputStore(freshDir());
  const record = store.addPhoto("241", "carton-crushed");
  // The slot's id, not the file's stem — see the shared-slot test above.
  assert.equal(record.photos[1].id, "carton");
  assert.equal(record.photos[1].path, "fixtures/case/photos/carton-crushed.jpg");
});

// ⭐ The property this store exists to preserve, asserted against the real
// committed file rather than a copy shaped like one: adding the photograph to
// the opening round must leave the case in exactly the committed form, byte for
// byte. A writer that re-serialised the record would produce the same data in a
// different shape — and test/case-fixture.test.mjs's inverse property, which is
// what keeps a reset off a committed file, would stop holding the first time
// this action was used.
test("adding the photograph restores the committed file byte for byte", () => {
  const dir = freshDir();
  createCaseInputStore(dir).addPhoto("241", "carton");
  assert.equal(readFileSync(join(dir, "241.json"), "utf8"), committed);
});

test("case-fixture's guarantees still hold on what the store wrote", () => {
  const dir = freshDir();
  createCaseInputStore(dir).addPhoto("241", "carton");
  const written = readFileSync(join(dir, "241.json"), "utf8");
  // The two assertions test/case-fixture.test.mjs makes about the committed
  // file, made about the file this store produced.
  assert.equal(applyPhotos(written, 2), written);
  assert.equal(applyPhotos(applyPhotos(written, 1), 2), written);
});

test("adding an already-present photograph is a no-op, not a duplicate", () => {
  const dir = freshDir();
  const store = createCaseInputStore(dir);
  store.addPhoto("241", "carton");
  const before = readFileSync(join(dir, "241.json"), "utf8");

  const record = store.addPhoto("241", "carton");

  assert.equal(record.photos.length, 2);
  assert.equal(
    readFileSync(join(dir, "241.json"), "utf8"),
    before,
    "a repeat add must not even rewrite the file",
  );
});

// The rule this replaces a path-keyed dedup with, and main's own data confirms
// the hazard it was written against: PHOTOS gives both branch photographs the id
// "carton", so treating that id as the identity of "already here" would block
// the intact carton from ever reaching a case the crushed one had filled.
// Setting the whole slot list from the round answers it structurally — the
// branch that arrives fills the slot, and neither branch can block the other.
test("the other branch fills the taken slot rather than being blocked by it", () => {
  const dir = freshDir(otherBranch);
  const record = createCaseInputStore(dir).addPhoto("241", "carton");

  assert.deepEqual(
    record.photos.map((p) => p.path),
    ["fixtures/case/photos/inner.jpg", "fixtures/case/photos/carton.jpg"],
    "the intact carton must reach a case the crushed one had filled",
  );
});

// ⚠️ The other half of the same rule. The two branches are one slot, so the
// arriving one replaces rather than joins: a case holding both an intact and a
// crushed outer carton is evidence that contradicts itself, and it would put two
// photographs where every comparison this case supports assumes one.
test("attaching the branch already in the slot changes nothing", () => {
  const dir = freshDir(otherBranch);
  const record = createCaseInputStore(dir).addPhoto("241", "carton-crushed");

  assert.equal(record.photos.length, 2);
  assert.equal(readFileSync(join(dir, "241.json"), "utf8"), otherBranch);
});

test("an unknown photo id is refused and the case is untouched", () => {
  const dir = freshDir();
  const store = createCaseInputStore(dir);
  assert.throws(() => store.addPhoto("241", "does-not-exist"), UnknownPhotoError);
  assert.equal(readFileSync(join(dir, "241.json"), "utf8"), opening);
});

// The opening round already holds it, so no round adds it — and an id that
// names no round is refused like any other.
test("the photograph the case opens with is not something that can be added", () => {
  const store = createCaseInputStore(freshDir());
  assert.throws(() => store.addPhoto("241", "inner"), UnknownPhotoError);
});

// ⚠️ The one the whole design turns on: a photo id names a round, and the rounds
// are a table of acceptable strings held in source. No path is built from the id
// and nothing is read off disk to decide, so a traversal attempt is refused for
// naming no round.
test("a traversal attempt is refused and writes nothing", () => {
  const store = createCaseInputStore(freshDir(null));
  for (const attempt of ["../../etc/passwd", "..\\..\\x", "../241", "/etc/passwd"]) {
    assert.throws(() => store.addPhoto("241", attempt), UnknownPhotoError);
  }
  assert.equal(store.read("241"), null);
});

test("a traversal attempt does not disturb an existing case input", () => {
  const dir = freshDir();
  const store = createCaseInputStore(dir);
  store.addPhoto("241", "carton");
  const before = readFileSync(join(dir, "241.json"), "utf8");

  assert.throws(() => store.addPhoto("241", "../../etc/passwd"));

  assert.equal(
    readFileSync(join(dir, "241.json"), "utf8"),
    before,
    "a refused add must leave the file untouched",
  );
});

// ⚠️ The photographs are one region of a file that also carries the listing and
// the message thread. A file written by this action alone would hold
// photographs and neither of those, which the buyer's view omits for having no
// listing — so an absent case is refused rather than invented.
test("a case input that does not exist is refused, not created", () => {
  const dir = freshDir(null);
  const store = createCaseInputStore(dir);
  assert.throws(() => store.addPhoto("241", "carton"), /never used to create one/);
  assert.equal(store.read("241"), null);
});

test("a successful add leaves no temporary file behind", () => {
  const dir = freshDir();
  createCaseInputStore(dir).addPhoto("241", "carton");
  const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftover, []);
});
