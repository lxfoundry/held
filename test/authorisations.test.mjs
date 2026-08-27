// test/authorisations.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import {
  createAuthorisationStore,
  UnsafeAuthorisationDirError,
  PERMITTED_ACTIONS,
} from "../src/authorisations.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "held-auth-"));

const signed = {
  functionName: "raiseDispute(uint256)",
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
};

test("only the two permitted actions can be stored", () => {
  const store = createAuthorisationStore(freshDir());
  assert.deepEqual(PERMITTED_ACTIONS, ["raiseDispute", "escalateDispute"]);
  for (const forbidden of ["completeExchange", "resolveDispute", "retractDispute"]) {
    assert.throws(() => store.save("42", forbidden, signed, 1), /not an action this system may take/);
  }
});

test("an authorisation round-trips and carries its nonce", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1_756_300_000_000);
  const loaded = store.load("42", "raiseDispute");
  assert.equal(loaded.functionSignature, "0xdeadbeef");
  assert.equal(loaded.nonce, 1_756_300_000_000);
  assert.equal(loaded.exchangeId, "42");
});

test("has answers without loading the signature", () => {
  const store = createAuthorisationStore(freshDir());
  assert.equal(store.has("42", "raiseDispute"), false);
  store.save("42", "raiseDispute", signed, 1);
  assert.equal(store.has("42", "raiseDispute"), true);
  assert.equal(store.has("42", "escalateDispute"), false);
});

test("discarding a spent authorisation removes it", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1);
  store.discard("42", "raiseDispute");
  assert.equal(store.has("42", "raiseDispute"), false);
  assert.equal(store.load("42", "raiseDispute"), null);
});

test("discarding something already gone is not an error", () => {
  const store = createAuthorisationStore(freshDir());
  store.discard("42", "raiseDispute");
});

test("list names the actions held and nothing else", () => {
  const store = createAuthorisationStore(freshDir());
  store.save("42", "raiseDispute", signed, 1);
  store.save("42", "escalateDispute", signed, 2);
  const listed = store.list("42");
  assert.deepEqual(listed.sort(), ["escalateDispute", "raiseDispute"]);
  assert.equal(JSON.stringify(listed).includes("0x"), false);
});

test("a directory under a committed path is refused outright", () => {
  // Fixtures are committed. A bearer instrument written there is published the
  // moment the repository is.
  for (const committed of ["fixtures", "docs", "test"]) {
    assert.throws(
      () => createAuthorisationStore(join(ROOT, committed, "authorisations")),
      UnsafeAuthorisationDirError
    );
  }
});

test("files are written readable by their owner only", { skip: platform() === "win32" }, () => {
  const dir = freshDir();
  const store = createAuthorisationStore(dir);
  store.save("42", "raiseDispute", signed, 1);
  const mode = statSync(join(dir, "42.raiseDispute.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});
