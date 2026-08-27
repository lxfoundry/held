// src/watchdog.mjs
// The clock, not the events.
//
// A parcel that stops producing events entirely is precisely the case this
// exists for, so nothing here is triggered by an arrival: it sweeps on a timer,
// asks the decision function what each exchange needs, and relays one of the
// buyer's own pre-signed authorisations when a deadline nears.
//
// ⭐ Every side effect is injected. The module has no chain dependency, no
// provider and no key, which is what lets the whole of its behaviour be tested
// in milliseconds without a network.

import { ACTIONS, decide } from "./adapter.mjs";

export function createWatchdog({
  exchanges,
  trackers,
  authorisations,
  readChainState,
  relay,
  leadsFor,
  now = () => Date.now(),
  log = () => {},
}) {
  async function step(record) {
    const result = { exchangeId: record.exchangeId, action: ACTIONS.NONE, reason: null, relayed: false };

    // ⭐ The protocol is the authority on what has already happened. The buyer
    // may have acted themselves, in which case the stored authorisation is
    // simply never used — and relaying it anyway would revert.
    //
    // Only facts are merged, never absences. The protocol adds and never
    // retracts — a dispute does not un-raise and an exchange does not
    // un-finalise — so a null from the reader means "not yet", and writing it
    // over what we already know would erase it once per sweep.
    const chain = await readChainState(record.exchangeId);
    const facts = Object.fromEntries(Object.entries(chain).filter(([, value]) => value != null));
    const current = exchanges.update(record.exchangeId, facts);

    const tracking = current.trackerId ? (trackers.read(current.trackerId)?.state ?? null) : null;
    const { action, reason, dueAt } = decide({
      tracking,
      record: current,
      now: now(),
      leads: leadsFor(current),
    });
    Object.assign(result, { action, reason, dueAt });

    if (action === ACTIONS.NONE) return result;

    if (!authorisations.has(current.exchangeId, action)) {
      // ⚠️ Not a warning to swallow. The promise is that the buyer need not
      // watch the deadline, and without the signature that promise cannot be
      // kept — so it is reported rather than logged and forgotten.
      log(`⚠ exchange ${current.exchangeId} needs ${action} and is unprotected: no authorisation held`);
      return { ...result, unprotected: true };
    }

    const stored = authorisations.load(current.exchangeId, action);
    await relay(stored);

    // Discarded only after the relay resolves. A failure above leaves the
    // authorisation in place and the record untouched, so the next sweep
    // retries rather than losing the protection.
    authorisations.discard(current.exchangeId, action);

    const at = now();
    exchanges.update(
      current.exchangeId,
      action === ACTIONS.RAISE
        ? { disputeRaisedAt: at, disputeRaisedBy: "watchdog" }
        : { escalatedAt: at }
    );
    log(`✓ ${action} relayed for exchange ${current.exchangeId} — ${reason}`);
    return { ...result, relayed: true };
  }

  async function sweep() {
    const results = [];
    for (const record of exchanges.all()) {
      try {
        results.push(await step(record));
      } catch (err) {
        // One exchange failing must never stop the others: the next one along
        // may be the one whose window is about to lapse.
        log(`✗ exchange ${record.exchangeId}: ${err.message}`);
        results.push({ exchangeId: record.exchangeId, action: ACTIONS.NONE, relayed: false, error: err.message });
      }
    }
    return results;
  }

  return { sweep };
}
