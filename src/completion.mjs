// src/completion.mjs
// The buyer completes, and the seller is paid.
//
// ⭐ Optional by design. If nobody calls this the dispute period elapses and
// the seller is paid anyway — completing only makes it sooner. Nothing here may
// be presented to a buyer as an obligation.
//
// ⚠️ It is still irreversible, and it forfeits the right to dispute. It plans
// and stops unless `execute` is true, which is what `--execute` means everywhere
// else in this repository.

import { PERMITTED_ACTIONS } from "./authorisations.mjs";

export class AlreadyFinalisedError extends Error {
  constructor(exchangeId) {
    super(`exchange ${exchangeId} is already finalised`);
    this.name = "AlreadyFinalisedError";
  }
}

export class DisputedError extends Error {
  constructor(exchangeId) {
    super(`exchange ${exchangeId} has a dispute open; completing it now would end that dispute`);
    this.name = "DisputedError";
  }
}

export async function complete({ exchangeId, exchanges, authorisations, chain, execute = false }) {
  const record = exchanges.get(exchangeId);
  if (!record) throw new Error(`unknown exchange ${exchangeId}`);
  if (record.finalisedAt != null) throw new AlreadyFinalisedError(exchangeId);
  if (record.disputeRaisedAt != null) throw new DisputedError(exchangeId);

  if (!execute) return { planned: true, finalisedAt: null, paid: null };

  const { finalisedAt, paid } = await chain.complete({ exchangeId, record });

  // ⭐ The exchange is over, so the pre-signed authorisations are spent:
  // deleted here, before the record update, so a caller that throws while
  // writing the record never leaves a spent bearer instrument on disk. This
  // used to live in whichever script called complete() — moved here so the
  // discipline no longer depends on the caller remembering it.
  for (const action of PERMITTED_ACTIONS) {
    authorisations.discard(exchangeId, action);
  }

  // Completing pays the seller in full, so the outcome is not derived from a
  // dispute — there was none.
  exchanges.update(exchangeId, { finalisedAt, outcome: "paid", buyerPercent: 0, authorisations: [] });
  return { planned: false, finalisedAt, paid };
}
