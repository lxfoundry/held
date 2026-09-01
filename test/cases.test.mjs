import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaseStore, createRecordingStore } from "../src/cases.mjs";
import { bundleHash } from "../src/evidence.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "held-cases-"));

// A real hash from the real producer, not a literal. A recording is keyed by
// whatever src/evidence.mjs emits, so if that ever stopped being a hex digest
// the store's filename guard would start refusing every save - and this is the
// test that says so.
const HASH = bundleHash([{ id: "pho-1", content: { path: "a.jpg" } }]);

test("a case round-trips", () => {
  const store = createCaseStore(dir());
  store.write({ exchangeId: "241", rounds: [], model: "claude-opus-5", closedAt: null, outcome: null });
  assert.equal(store.read("241").exchangeId, "241");
});

test("a missing case reads as null rather than throwing", () => {
  assert.equal(createCaseStore(dir()).read("999"), null);
});

test("a recording is found by its bundle hash", () => {
  const store = createRecordingStore(dir());
  store.save(HASH, { model: "claude-opus-5", response: { status: "proposal", buyerPercent: 20 } });
  assert.equal(store.find(HASH).response.buyerPercent, 20);
  assert.equal(store.find("nothing"), null);
});

test("what bundleHash produces is accepted as a recording key", () => {
  const store = createRecordingStore(dir());
  assert.doesNotThrow(() => store.save(HASH, { model: "m", response: {} }));
});

test("a recording never contains base64 image data", () => {
  const d = dir();
  const store = createRecordingStore(d);
  store.save(HASH, {
    model: "claude-opus-5",
    response: { status: "proposal", buyerPercent: 20 },
  });
  const written = readFileSync(join(d, readdirSync(d)[0]), "utf8");
  assert.ok(!/[A-Za-z0-9+/]{512,}={0,2}/.test(written), "something that looks like base64 was written");
});

test("a hash that is not a hex digest is refused as a filename", () => {
  const store = createRecordingStore(dir());
  assert.throws(() => store.save("../escape", { model: "m", response: {} }), /hash/);
});
