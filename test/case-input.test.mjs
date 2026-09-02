// test/case-input.test.mjs
// The case input store: the listing/photos/messages file the mediator reads
// (fixtures/case/<exchangeId>.json in production) and the one the buyer's
// "Add a photo" action appends to.
//
// ⚠️ Never points at fixtures/case/ itself. Every test builds a fresh
// temporary directory with its own photos/ subdirectory, so the committed
// fixtures stay byte-for-byte unchanged no matter what a test does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaseInputStore, UnknownPhotoError } from "../src/case-input.mjs";

// A fresh case directory, with a photos/ subdirectory carrying two branches of
// the same photograph — same as fixtures/case/photos/ carries carton.jpg and
// carton-crushed.jpg, which is what lets the same question produce different
// answers.
function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "held-case-input-"));
  mkdirSync(join(dir, "photos"), { recursive: true });
  writeFileSync(join(dir, "photos", "carton.jpg"), "not a real jpeg, just a fixture");
  writeFileSync(join(dir, "photos", "carton-crushed.jpg"), "not a real jpeg, just a fixture");
  return dir;
}

// A 238-shaped record: the committed fixtures/case/238.json carries exactly
// this id/path divergence — id "carton" already points at carton-crushed.jpg,
// never at a file named "carton". Never written into fixtures/case/ itself;
// this is a hand-written copy of that shape into a temporary directory.
function seed238(dir) {
  writeFileSync(
    join(dir, "238.json"),
    JSON.stringify(
      {
        exchangeId: "238",
        photos: [
          { id: "inner", path: "fixtures/case/photos/inner.jpg", media_type: "image/jpeg" },
          { id: "carton", path: "fixtures/case/photos/carton-crushed.jpg", media_type: "image/jpeg" },
        ],
      },
      null,
      2,
    ),
  );
}

test("read on a case with no file yet is null, not an error", () => {
  assert.equal(createCaseInputStore(freshDir()).read("241"), null);
});

test("a known photo id is appended in the shape scripts/mediate.mjs reads", () => {
  const store = createCaseInputStore(freshDir());
  const record = store.addPhoto("241", "carton");
  assert.deepEqual(record.photos, [
    { id: "carton", path: "fixtures/case/photos/carton.jpg", media_type: "image/jpeg" },
  ]);
  assert.deepEqual(store.read("241").photos, record.photos);
});

test("either branch photograph can be attached", () => {
  const store = createCaseInputStore(freshDir());
  const record = store.addPhoto("241", "carton-crushed");
  assert.equal(record.photos[0].id, "carton-crushed");
  assert.equal(record.photos[0].path, "fixtures/case/photos/carton-crushed.jpg");
});

test("appending an already-present photo is a no-op, not a duplicate", () => {
  const dir = freshDir();
  const store = createCaseInputStore(dir);
  store.addPhoto("241", "carton");
  const before = readFileSync(join(dir, "241.json"), "utf8");

  const record = store.addPhoto("241", "carton");

  assert.equal(record.photos.length, 1);
  assert.equal(
    readFileSync(join(dir, "241.json"), "utf8"),
    before,
    "a repeat add must not even rewrite the file",
  );
});

// Fix round 1, item 1: the committed fixtures show `id` is a logical slot,
// not a filename stem — 238.json already uses id "carton" for
// carton-crushed.jpg. Dedup must be keyed on `path`, or these two cases break.
test("attaching a branch already present under a different id does not duplicate it", () => {
  const dir = freshDir();
  seed238(dir);
  const store = createCaseInputStore(dir);

  const record = store.addPhoto("238", "carton-crushed");

  assert.equal(
    record.photos.length,
    2,
    "carton-crushed.jpg is already in the case under id \"carton\" — this must be a no-op",
  );
});

test("a different branch photograph can still be attached even though its slot id is taken", () => {
  const dir = freshDir();
  seed238(dir);
  const store = createCaseInputStore(dir);

  const record = store.addPhoto("238", "carton");

  assert.equal(
    record.photos.length,
    3,
    "carton.jpg is a different file from the one already recorded under id \"carton\" and must be attachable",
  );
  assert.ok(
    record.photos.some((p) => p.path === "fixtures/case/photos/carton.jpg"),
    "the good-branch photograph must actually be present",
  );
});

test("an unknown photo id is refused and writes nothing", () => {
  const store = createCaseInputStore(freshDir());
  assert.throws(() => store.addPhoto("241", "does-not-exist"), UnknownPhotoError);
  assert.equal(store.read("241"), null);
});

// ⚠️ The one the whole design turns on: the id becomes a path, so it is
// checked against photographs that actually exist rather than sanitised.
test("a traversal attempt is refused and writes nothing", () => {
  const store = createCaseInputStore(freshDir());
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

test("a successful add leaves no temporary file behind", () => {
  const dir = freshDir();
  createCaseInputStore(dir).addPhoto("241", "carton");
  const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftover, []);
});
