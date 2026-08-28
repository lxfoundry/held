// test/authorisations.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/env.mjs";
import {
  createAuthorisationStore,
  UnsafeAuthorisationDirError,
  PERMITTED_ACTIONS,
} from "../src/authorisations.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "held-auth-"));

const BUYER = "0x1111111111111111111111111111111111111111";

// One per action, because what a signature authorises is now checked against
// the action it is filed under.
const signedFor = (action) => ({
  functionName: `${action}(uint256)`,
  functionSignature: "0xdeadbeef",
  r: `0x${"1".repeat(64)}`,
  s: `0x${"2".repeat(64)}`,
  v: 27,
});

const signed = signedFor("raiseDispute");
const save = (store, id, action, nonce, over = {}) =>
  store.save(id, action, over.signed ?? signedFor(action), {
    nonce,
    userAddress: over.userAddress ?? BUYER,
  });

test("only the two permitted actions can be stored", () => {
  const store = createAuthorisationStore(freshDir());
  assert.deepEqual(PERMITTED_ACTIONS, ["raiseDispute", "escalateDispute"]);
  for (const forbidden of ["completeExchange", "resolveDispute", "retractDispute"]) {
    assert.throws(() => save(store, "42", forbidden, 1), /not an action this system may take/);
  }
});

test("an authorisation round-trips and carries its nonce", () => {
  const store = createAuthorisationStore(freshDir());
  save(store, "42", "raiseDispute", 1_756_300_000_000);
  const loaded = store.load("42", "raiseDispute");
  assert.equal(loaded.functionSignature, "0xdeadbeef");
  assert.equal(loaded.nonce, 1_756_300_000_000);
  assert.equal(loaded.exchangeId, "42");
});

test("has answers without loading the signature", () => {
  const store = createAuthorisationStore(freshDir());
  assert.equal(store.has("42", "raiseDispute"), false);
  save(store, "42", "raiseDispute", 1);
  assert.equal(store.has("42", "raiseDispute"), true);
  assert.equal(store.has("42", "escalateDispute"), false);
});

test("discarding a spent authorisation removes it", () => {
  const store = createAuthorisationStore(freshDir());
  save(store, "42", "raiseDispute", 1);
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
  save(store, "42", "raiseDispute", 1);
  save(store, "42", "escalateDispute", 2);
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

test("a directory nobody listed is refused too, and so is the repository root", () => {
  // The rule is an allowlist. A blocklist of the directories we happened to
  // think of accepts `auth/` — which .gitignore does not cover — and accepts
  // the repository root itself, and then the instruments get committed.
  for (const unlisted of ["auth", "tmp", "state-old"]) {
    assert.throws(
      () => createAuthorisationStore(join(ROOT, unlisted)),
      UnsafeAuthorisationDirError
    );
  }
  assert.throws(() => createAuthorisationStore(ROOT), UnsafeAuthorisationDirError);
});

test("state/ inside the repository is allowed, because git ignores it", () => {
  const store = createAuthorisationStore(join(ROOT, "state", "authorisations-test"));
  assert.ok(store.dir.endsWith("authorisations-test"));
  rmSync(store.dir, { recursive: true, force: true });
});

test("a signature is refused unless it authorises the action it is filed under", () => {
  const store = createAuthorisationStore(freshDir());

  // The hole this closes: the action space was enforced on the argument, so a
  // completeExchange signature could be stored as a raiseDispute and then
  // relayed verbatim — through the one component that cannot do that.
  for (const forbidden of ["completeExchange(uint256)", "resolveDispute(uint256,uint256,bytes32,bytes32,uint8)"]) {
    assert.throws(
      () => save(store, "42", "raiseDispute", 1, { signed: { ...signed, functionName: forbidden } }),
      /refusing to store a .* signature as raiseDispute/
    );
  }

  // Including the other permitted action: they are not interchangeable.
  assert.throws(
    () => save(store, "42", "escalateDispute", 1, { signed: signedFor("raiseDispute") }),
    /refusing to store a raiseDispute\(uint256\) signature as escalateDispute/
  );
  assert.equal(store.has("42", "raiseDispute"), false);
  assert.equal(store.has("42", "escalateDispute"), false);
});

test("an authorisation carries the address that signed it", () => {
  // Public, and holding it is what removes any reason to hold the buyer's key.
  const store = createAuthorisationStore(freshDir());
  save(store, "42", "raiseDispute", 1);
  assert.equal(store.load("42", "raiseDispute").userAddress, BUYER);

  assert.throws(
    () => store.save("43", "raiseDispute", signed, { nonce: 1 }),
    /needs the address that signed it/
  );
});

test("files are written readable by their owner only", { skip: platform() === "win32" }, () => {
  const dir = freshDir();
  const store = createAuthorisationStore(dir);
  save(store, "42", "raiseDispute", 1);
  const mode = statSync(join(dir, "42.raiseDispute.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});
