import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSENTS_DIR, createConsentStore } from "../src/consents.mjs";

const store = () => createConsentStore(mkdtempSync(join(tmpdir(), "held-")));

const signature = {
  r: "0xcd6fb3a5f860d335db10271be408f40569c07950a0286b16547dc23fb0080829",
  s: "0x4c5c5885247c19014e728bd775794d615d1e4b60810631cdc8c0e3024f4368d3",
  v: 27,
};
const consent = (over = {}) => ({
  buyerPercent: 25,
  buyerPercentBasisPoints: 2500,
  signedBy: "0x541af8Fd1a80F3Cc5D87Eae6b21b25E9A395035d",
  ...signature,
  ...over,
});

// ⭐ The whole reason this store exists rather than a line in .gitignore: the
// path is fixed in source, so no setting can point it at a directory git tracks.
test("consents are kept where the repository already ignores them", () => {
  assert.equal(CONSENTS_DIR.split("/")[0], "state");
});

test("a saved consent reads back with its split and its signature", () => {
  const consents = store();
  consents.save("241", consent());
  const held = consents.read("241");
  assert.equal(held.exchangeId, "241");
  assert.equal(held.buyerPercent, 25);
  assert.equal(held.buyerPercentBasisPoints, 2500);
  assert.equal(held.r, signature.r);
  assert.equal(held.v, 27);
  assert.equal(typeof held.signedAt, "number");
});

test("an exchange nobody has consented to reads as an absence, not an error", () => {
  assert.equal(store().read("241"), null);
  assert.equal(store().has("241"), false);
});

// ⚠️ The exact failure this whole task is written around. A consent whose
// percentage disagrees with the basis points its signature covers would settle
// at a number nobody agreed to, and the record would then state the other one.
test("a consent whose basis points contradict its percentage is refused", () => {
  assert.throws(
    () => store().save("241", consent({ buyerPercentBasisPoints: 25 })),
    /basis points/
  );
});

test("a consent for a percentage outside 0-100 is refused before it reaches disk", () => {
  assert.throws(() => store().save("241", consent({ buyerPercent: 120, buyerPercentBasisPoints: 12000 })), /0-100/);
});

test("a consent needs the address that signed it", () => {
  assert.throws(() => store().save("241", consent({ signedBy: undefined })), /signed/);
});

// Spent, or superseded. Either way it is deleted rather than kept: a signature
// nobody needs is a liability with no upside.
test("a discarded consent cannot be replayed", () => {
  const consents = store();
  consents.save("241", consent());
  consents.discard("241");
  assert.equal(consents.read("241"), null);
});

test("discarding an exchange that holds no consent is not an error", () => {
  assert.doesNotThrow(() => store().discard("241"));
});

test("one live consent per exchange: a second at a new split replaces the first", () => {
  const consents = store();
  consents.save("241", consent());
  consents.save("241", consent({ buyerPercent: 30, buyerPercentBasisPoints: 3000 }));
  assert.equal(consents.read("241").buyerPercent, 30);
});

test("a consent is written readable only by its owner", { skip: process.platform === "win32" }, () => {
  const consents = store();
  consents.save("241", consent());
  assert.equal(statSync(join(consents.dir, "241.json")).mode & 0o777, 0o600);
});
