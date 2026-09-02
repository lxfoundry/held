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

  // ⭐ The one place an authorisation is deleted, so the record's list of what
  // protects an exchange cannot drift from the store that actually holds them.
  // It used to: the watchdog reads the filesystem and never that array, so a
  // relayed raise left the record still claiming to hold one. Harmless to the
  // machinery, and exactly the wrong thing to hand an operator asking what is
  // protected.
  //
  // The signature goes first and the record second, deliberately — a throw
  // while writing the record must not leave a spent bearer instrument on disk.
  function discard(exchangeId, action, why) {
    if (!authorisations.has(exchangeId, action)) return;
    authorisations.discard(exchangeId, action);
    exchanges.update(exchangeId, { authorisations: authorisations.list(exchangeId) });
    if (why) log(`· discarded the ${action} authorisation: ${why}`);
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

    // ⭐ Who raised it, for a dispute this watchdog relayed but never got to
    // confirm. Attribution used to be written only on the confirmed path, so a
    // relay that landed while the read-back timed out came back on the next
    // sweep as a dispute out of nowhere — and an unattributed dispute is read as
    // the buyer's own. The buyer was then told "Let's sort this out" rather than
    // "It hasn't arrived. We've raised this for you.", which is the promise the
    // whole watchdog exists to keep, dropped in the one case it exists for.
    //
    // The attempt is recorded before relaying and read back here, so the answer
    // survives the process dying between the two. Narrow on purpose: no attempt
    // means the dispute is somebody else's and is left unattributed.
    //
    // ⭐ Read again rather than trust the snapshot sweep() opened the pass with.
    // The buyer can raise too, from scripts/raise-dispute.mjs — a separate
    // process, so the in-process sweeping guard says nothing about it — and an
    // earlier exchange sitting in confirm() can leave this snapshot minutes
    // stale. exchanges.update re-reads from disk anyway, so this costs one read
    // and shrinks the window from a whole sweep to microseconds.
    const before = exchanges.get(record.exchangeId) ?? record;
    if (
      facts.disputeRaisedAt != null &&
      facts.disputeRaisedBy == null &&
      before.disputeRaisedBy == null &&
      before.disputeRaiseAttemptedAt != null
    ) {
      facts.disputeRaisedBy = "watchdog";
    }
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

    // The other half of "discard on use", and it is the protocol that decides
    // what "spent" means rather than this process's own record of what it
    // relayed. A dispute cannot be raised twice and an escalation cannot be
    // escalated twice, so the moment the chain shows either has happened that
    // signature can never be accepted again — whoever spent it. Relaying it
    // would revert on a used nonce, so nothing here was ever dangerous; a
    // bearer instrument with no remaining use is simply a liability with no
    // upside, and it does not sit on disk waiting for the one that spends it.
    //
    // Ordered widest first: a finalised exchange needs none of them, whatever
    // the dispute dates say.
    const spent = [];
    if (current.finalisedAt != null) {
      for (const held of authorisations.list(current.exchangeId)) {
        spent.push([held, `exchange ${current.exchangeId} is finalised`]);
      }
    } else {
      if (current.disputeRaisedAt != null) {
        spent.push([ACTIONS.RAISE, `a dispute already exists on chain for exchange ${current.exchangeId}`]);
      }
      if (current.escalatedAt != null) {
        spent.push([ACTIONS.ESCALATE, `exchange ${current.exchangeId} is already escalated`]);
      }
    }
    for (const [held, why] of spent) {
      discard(current.exchangeId, held, why);
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

    // ⚠️ Written before the relay, not after, because the failure it answers is
    // precisely that nothing after the relay runs. Once the transaction is
    // submitted the dispute may exist on chain whatever happens to this
    // process, so the note that it was this watchdog that submitted it has to
    // already be on disk by then.
    if (action === ACTIONS.RAISE) {
      exchanges.update(current.exchangeId, { disputeRaiseAttemptedAt: now() });
    }

    await relay(stored);

    // The protocol is asked whether it happened, rather than the relayer being
    // taken at its word. A revert throws here, which leaves the authorisation
    // in place and the record untouched, so the next sweep retries with the
    // window still open instead of recording a raise that does not exist.
    await confirm(stored);

    // Discarded only once the action is known to have landed. Doing it any
    // earlier trades the buyer's protection for the appearance of success.
    discard(current.exchangeId, action);

    const at = now();
    if (action === ACTIONS.RAISE) {
      // ⭐ Read again, exactly as the attribution guard above does and for the
      // same reason. confirm() asks whether a dispute exists, not whose it is,
      // so a buyer raise landing since this step decided answers it too. The
      // unconditional write that used to be here then signed this watchdog's
      // name to the buyer's own raise — the inversion attribution exists to
      // prevent, reached from the other side. A raise already recorded is
      // somebody's, and is left alone.
      const settled = exchanges.get(current.exchangeId);
      if (settled?.disputeRaisedAt == null) {
        exchanges.update(current.exchangeId, { disputeRaisedAt: at, disputeRaisedBy: "watchdog" });
      }
    } else {
      exchanges.update(current.exchangeId, { escalatedAt: at });
    }
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
