// src/proposal.mjs
// The bounds on what the model may return.
//
// ⚠️ None of these evaluates whether the number is fair. They cover the action
// space, whether citations resolve, and what may be shown to a party. Fairness
// is the model's whole job: the proposal is inert until a person accepts it and
// either party may decline, so a fairness rule here would be this system's own
// policy wearing the model's clothes — and wrong the first time a case did not
// match the rule it was written for.

export const STATUS = Object.freeze({
  NEEDS_EVIDENCE: "needs_evidence",
  PROPOSAL: "proposal",
  CANNOT_SETTLE: "cannot_settle",
});

// The settlement-bearing surface. Listed rather than inferred so that a field
// nobody planned for is a rejection instead of a silently wider action space.
const FIELDS = {
  [STATUS.NEEDS_EVIDENCE]: ["status", "requests", "provisional", "findings"],
  [STATUS.PROPOSAL]: ["status", "buyerPercent", "reasoning", "findings"],
  [STATUS.CANNOT_SETTLE]: ["status", "reasoning", "findings"],
};

const INTERNAL = ["wouldChange", "provisional"];

const fail = (reason) => ({ ok: false, reason });

function checkPercent(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) return `${label} must be a number`;
  if (value < 0 || value > 100) return `${label} must be within 0-100, got ${value}`;
  return null;
}

export function checkProposal(result, bundle) {
  const allowed = FIELDS[result?.status];
  if (!allowed) return fail(`unknown status ${result?.status}`);

  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) return fail(`unknown field "${key}" for ${result.status}`);
  }

  if (result.status === STATUS.PROPOSAL) {
    const bad = checkPercent(result.buyerPercent, "buyerPercent");
    if (bad) return fail(bad);
  }

  if (result.status === STATUS.NEEDS_EVIDENCE) {
    if (!result.provisional) return fail("needs_evidence must carry a provisional split");
    const bad = checkPercent(result.provisional.buyerPercent, "provisional.buyerPercent");
    if (bad) return fail(bad);
    if (!Array.isArray(result.requests) || result.requests.length === 0) {
      return fail("needs_evidence must carry at least one request");
    }
    for (const req of result.requests) {
      const branches = req.wouldChange ?? [];
      if (branches.length < 2) return fail("a request must name at least two branches");
      // A request whose branches agree is a question whose answer changes
      // nothing, and it spends a party's effort to look diligent.
      if (new Set(branches.map((b) => b.split)).size === 1) {
        return fail("every branch of a request implies the same split");
      }
    }
  }

  // ⚠️ Grounding, not fairness. This says nothing about whether a finding is
  // correct — only that what it cites was actually in front of the model.
  const ids = new Set((bundle?.items ?? []).map((i) => i.id));
  for (const finding of result.findings ?? []) {
    for (const id of finding.evidenceIds ?? []) {
      if (!ids.has(id)) return fail(`finding cites ${id}, which is not in the bundle`);
    }
  }

  return { ok: true };
}

// The protocol takes the buyer's share in basis points. Direction and scale are
// both easy to invert and inverting either pays the wrong party in full.
export function toBasisPoints(buyerPercent) {
  const bad = checkPercent(buyerPercent, "buyerPercent");
  if (bad) throw new RangeError(bad);
  return Math.round(buyerPercent * 100);
}

// ⚠️ Everything a party sees goes through here. A party who can see which
// answer raises their share has been handed a multiple-choice question with the
// marks printed on it.
export function forParty(result) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.entries(value)
        .filter(([k]) => !INTERNAL.includes(k))
        .reduce((out, [k, v]) => { out[k] = strip(v); return out; }, {});
    }
    return value;
  };
  return strip(result);
}
