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
  confirm,
  leadsFor,
  now = () => Date.now(),
  log = () => {},
}) {
  // ⭐ Required, and deliberately not defaulted to a no-op. Relaying resolves
  // when the relayer accepted the transaction, which is not the same as the
  // protocol having recorded it: a meta-transaction that reverts on chain comes
  // back through the same path as one that succeeded. Without a read-back the
  // watchdog would delete the buyer's only signature, write down that the
  // dispute was raised, and never try again — so this cannot be optional.
  if (typeof confirm !== "function") {
    throw new Error("a watchdog needs a confirm() that reads back what the relay actually did");
  }

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

    // ⚠️ An unreadable snapshot is an absence of delivery evidence, not a reason
    // to stand down. Letting it throw would abort this exchange's step, and the
    // window could then lapse in the seller's favour — the one outcome the
    // watchdog exists to prevent. So it takes the same branch as no tracking at
    // all, loudly: the operator has a file to fix, and meanwhile a nearing
    // deadline still raises.
    let tracking = null;
    if (current.trackerId) {
      try {
        tracking = trackers.read(current.trackerId)?.state ?? null;
      } catch (err) {
        result.trackingUnreadable = true;
        log(`⚠ exchange ${current.exchangeId}: tracker ${current.trackerId} is unreadable, treating it as no delivery evidence — ${err.message}`);
      }
    }
    const { action, reason, dueAt } = decide({
      tracking,
      record: current,
      now: now(),
      leads: leadsFor(current),
    });
    Object.assign(result, { action, reason, dueAt });

    // The other half of "discard on use". An exchange that has finalised will
    // never need these again, and a bearer instrument nobody needs is a
    // liability with no upside — so they do not sit on disk indefinitely
    // waiting for the one that spends them.
    if (current.finalisedAt != null) {
      for (const held of authorisations.list(current.exchangeId)) {
        authorisations.discard(current.exchangeId, held);
        log(`· discarded the ${held} authorisation: exchange ${current.exchangeId} is finalised`);
      }
    }

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

    // The protocol is asked whether it happened, rather than the relayer being
    // taken at its word. A revert throws here, which leaves the authorisation
    // in place and the record untouched, so the next sweep retries with the
    // window still open instead of recording a raise that does not exist.
    await confirm(stored);

    // Discarded only once the action is known to have landed. Doing it any
    // earlier trades the buyer's protection for the appearance of success.
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

    // Reported before anything else. A record that cannot be read is an
    // exchange nobody is watching, and that is worth more to an operator than
    // anything the readable ones have to say.
    for (const exchangeId of exchanges.unreadable?.() ?? []) {
      log(`⚠ exchange ${exchangeId} has an unreadable record and is unprotected`);
      results.push({ exchangeId, action: ACTIONS.NONE, relayed: false, unreadable: true });
    }

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
