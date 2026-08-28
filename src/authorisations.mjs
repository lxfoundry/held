// src/authorisations.mjs
// The buyer's pre-signed meta-transactions, held so the deadline logic can act
// on their behalf without ever holding their key.
//
// ⭐ These are bearer instruments. Narrowly scoped ones — one exchange, one
// function — but anyone holding one can perform that action. They are secrets:
// never in a fixture, never in a log, never in a commit, and deleted the moment
// they are spent.
//
// ⭐ The action space is enforced here, in the only place a signature can be
// stored. The watchdog does not refrain from completing an exchange or settling
// a dispute — it cannot, because no signature authorising either can exist.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ROOT } from "./env.mjs";

// The complete list, and it is a closed one. Every entry keeps a decision open
// for a human; nothing that disposes of funds appears, and nothing may be added
// without changing the specification this implements.
export const PERMITTED_ACTIONS = ["raiseDispute", "escalateDispute"];

// What the signature for each action must say it authorises. These are the
// exact strings the protocol signs over, so an instrument that does not carry
// one of them is not the thing its filename claims.
const SIGNED_AS = {
  raiseDispute: "raiseDispute(uint256)",
  escalateDispute: "escalateDispute(uint256)",
};

export class UnsafeAuthorisationDirError extends Error {
  constructor(dir) {
    super(
      `refusing to keep authorisations in ${dir}: inside the repository, only state/ is ignored by git`
    );
    this.name = "UnsafeAuthorisationDirError";
  }
}

// ⭐ An allowlist, not a list of the paths we happened to think of. Naming the
// committed directories means any path nobody listed — `auth/`, or the
// repository root itself — is accepted, written with bearer instruments in it,
// and then committed, in a repository that is published. Inside the repository
// the only safe answer is the directory .gitignore already covers; outside it,
// git is not involved at all.
const IGNORED_DIR = "state";

function assertSafeDir(dir) {
  const full = resolve(dir);
  if (full === ROOT) throw new UnsafeAuthorisationDirError(full);
  if (!full.startsWith(ROOT + sep)) return full;
  if (full.slice(ROOT.length + 1).split(sep)[0] !== IGNORED_DIR) {
    throw new UnsafeAuthorisationDirError(full);
  }
  return full;
}

export function createAuthorisationStore(dir) {
  const root = assertSafeDir(dir);
  mkdirSync(root, { recursive: true });

  function assertPermitted(action) {
    if (!PERMITTED_ACTIONS.includes(action)) {
      throw new Error(`${action} is not an action this system may take on the buyer's behalf`);
    }
  }

  const pathFor = (exchangeId, action) => join(root, `${String(exchangeId)}.${action}.json`);

  // `userAddress` is the buyer's public address, kept beside the signature
  // because the relayer needs to be told who signed. It is public, and holding
  // it is what removes any reason for this system to hold their key.
  function save(exchangeId, action, signed, { nonce, userAddress }) {
    assertPermitted(action);

    // ⭐ The action space is enforced on what was signed, not on the name the
    // caller passed. Checking the argument alone would let a completeExchange
    // signature be filed under raiseDispute and relayed verbatim — through the
    // one component whose whole purpose is that it cannot do that.
    if (signed.functionName !== SIGNED_AS[action]) {
      throw new Error(
        `refusing to store a ${signed.functionName} signature as ${action}: ` +
          `an authorisation for ${action} must be signed over ${SIGNED_AS[action]}`
      );
    }
    if (!userAddress) throw new Error("an authorisation needs the address that signed it");

    const stored = {
      exchangeId: String(exchangeId),
      action,
      userAddress,
      functionName: signed.functionName,
      functionSignature: signed.functionSignature,
      r: signed.r,
      s: signed.s,
      v: signed.v,
      nonce,
      createdAt: Date.now(),
    };
    const target = pathFor(exchangeId, action);
    writeFileSync(target, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // `mode` applies on creation only, so a re-save over an existing file would
    // keep whatever permissions that file already had. Reassert it.
    chmodSync(target, 0o600);
    return { exchangeId: String(exchangeId), action };
  }

  function load(exchangeId, action) {
    assertPermitted(action);
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId, action), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function has(exchangeId, action) {
    try {
      statSync(pathFor(exchangeId, action));
      return true;
    } catch {
      return false;
    }
  }

  // Spent, or the exchange is over. Either way it is deleted rather than kept:
  // a signature nobody needs is a liability with no upside.
  function discard(exchangeId, action) {
    rmSync(pathFor(exchangeId, action), { force: true });
  }

  // Names only, so an operator can be told what an exchange is protected by
  // without any of it reaching a terminal or a log file.
  function list(exchangeId) {
    return PERMITTED_ACTIONS.filter((action) => has(exchangeId, action));
  }

  return { save, load, has, discard, list, dir: root };
}
