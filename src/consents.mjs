// src/consents.mjs
// The counterparty's signed agreement to one settlement, held until it is spent.
//
// ⭐ Deliberately not src/authorisations.mjs, and the difference is the whole
// point. An authorisation is a standing instrument: it names an action, anything
// holding it may take that action whenever it decides to, and the deadline logic
// spends one unattended. PERMITTED_ACTIONS is a closed list for that reason and
// nothing that disposes of funds is on it.
//
// A consent is the opposite shape. It is bound to one exchange *and one exact
// percentage*, so it cannot settle at any other split — there is no discretion
// in it to delegate. That narrowness is what makes it safe to hold at all, and
// it is why it belongs beside the proposal it agrees to rather than in a store of
// standing authorisations.
//
// ⚠️ It is still a bearer instrument: whoever holds it can settle at that split.
// So it is a secret — never in a fixture, never in a log, never in a commit, and
// deleted the moment it is spent.
//
// ⚠️ It cannot live on the exchange record either, and that is enforced rather
// than remembered: src/exchanges.mjs refuses to write a record carrying r, s, v
// or 65 bytes of hex. Nor on the case record, which scripts/mediate.mjs rewrites
// wholesale on every round — a consent kept there would be destroyed by the next
// one without anything noticing.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBasisPoints } from "./proposal.mjs";

// ⚠️ Fixed in source, never read from a setting. state/ is the directory this
// repository's .gitignore covers, and a consent is a secret in a repository that
// is published — so the one thing no operator may do is point this somewhere
// git tracks. The case store is fixed for a weaker reason and this one is
// stronger, so it is fixed the same way: in source, where it cannot be moved.
export const CONSENTS_DIR = "state/consents";

export function createConsentStore(dir) {
  mkdirSync(dir, { recursive: true });

  const pathFor = (exchangeId) => join(dir, `${String(exchangeId)}.json`);

  // ⭐ Checked, not converted. src/proposal.mjs owns the one conversion in this
  // repository and is tested for direction rather than merely arithmetic, so
  // this asserts the two numbers agree instead of working out the second one
  // itself. A consent whose percentage and basis points disagreed would settle
  // at one of them and be recorded as the other.
  function save(exchangeId, { buyerPercent, buyerPercentBasisPoints, signedBy, r, s, v }) {
    const expected = toBasisPoints(buyerPercent);
    if (buyerPercentBasisPoints !== expected) {
      throw new Error(
        `refusing a consent for ${buyerPercent}% carrying ${buyerPercentBasisPoints} basis points: ` +
          `${buyerPercent}% is ${expected}`
      );
    }
    if (!signedBy) throw new Error("a consent needs the address that signed it");
    if (!r || !s || v == null) throw new Error("a consent needs the r, s and v of its signature");

    const stored = {
      exchangeId: String(exchangeId),
      buyerPercent,
      buyerPercentBasisPoints,
      signedBy,
      r,
      s,
      v,
      signedAt: Date.now(),
    };
    const target = pathFor(exchangeId);
    writeFileSync(target, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // `mode` applies on creation only, so a re-save over an existing file would
    // keep whatever permissions that file already had. Reassert it.
    chmodSync(target, 0o600);
    return stored;
  }

  function read(exchangeId) {
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function has(exchangeId) {
    try {
      statSync(pathFor(exchangeId));
      return true;
    } catch {
      return false;
    }
  }

  // Spent, or superseded by a consent at another split. Either way it is
  // deleted rather than kept: a signature nobody needs is a liability with no
  // upside.
  function discard(exchangeId) {
    rmSync(pathFor(exchangeId), { force: true });
  }

  return { save, read, has, discard, dir };
}
