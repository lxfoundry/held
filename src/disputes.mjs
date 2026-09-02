// src/disputes.mjs
// Raising a dispute on an exchange, for whoever is doing the raising.
//
// ⭐ One pre-signed authorisation, two possible spenders. The buyer's "something
// is wrong" spends exactly the instrument the watchdog would have spent later,
// and the watchdog then stands down on its own — the decision function moves to
// the escalation branch as soon as disputeRaisedAt is set.
//
// ⚠️ This repeats the order in src/watchdog.mjs step() rather than sharing it.
// That code is live and proven against real disputes on chain; forking it days
// before a freeze is the larger risk. The order is the part that matters and it
// is identical: attribute, relay, confirm, discard, record.

const MS = 1000;

// ⭐ What the protocol says the time is, in milliseconds — or null while it says
// the action has not landed, which is the signal waitForState polls on.
//
// ⚠️ The read-back used to answer `true` and threw this number away, leaving the
// caller to stamp its own clock on a fact the protocol already dated. The two
// are not interchangeable: `seed --adopt` rewrites a record with the dispute
// fields null, so the chain can have held a dispute for a day while the record
// reads as undisputed — and now() would then date it to now, putting the
// escalation deadline a day past the one the protocol enforces.
//
// One copy for both spenders, and for both actions: a raise and an escalation
// differ here only in which of the two dates they read.
export function confirmedAt(dispute, action) {
  if (!dispute?.exists) return null;
  const { disputed, escalated } = dispute.disputeDates;
  const landed = action === "raiseDispute" ? disputed : escalated;
  return landed.isZero() ? null : Number(landed) * MS;
}

export async function raiseFor({
  exchangeId,
  by,
  exchanges,
  authorisations,
  relay,
  confirm,
  now = () => Date.now(),
}) {
  if (!authorisations.has(exchangeId, "raiseDispute")) {
    throw new Error(`no raiseDispute authorisation is held for exchange ${exchangeId}`);
  }
  const stored = authorisations.load(exchangeId, "raiseDispute");

  // ⚠️ Before the relay, not after. Attribution is buyer-visible, and the case
  // it exists for is precisely the one where the relay lands and the
  // confirmation does not: without this the record says nobody raised it, and
  // the next sweep — finding a dispute on chain that this system has no attempt
  // on record for — leaves it unattributed too.
  //
  // Safe to write early in a way the watchdog's own attribution is not: the
  // buyer's line is gated on disputeRaisedAt, which is set below and only once
  // the protocol has confirmed. Until then the record says who would have
  // raised it, not that it was raised.
  exchanges.update(exchangeId, { disputeRaisedBy: by, disputeRaiseAttemptedAt: now() });

  await relay(stored);

  // The relayer resolving is not the protocol having acted. A reverted
  // meta-transaction returns through the same path as a successful one, so the
  // protocol is asked. A throw here leaves the authorisation in place and the
  // window open for another attempt.
  //
  // ⭐ And what it answers with is the date the protocol recorded, which is the
  // one thing this function has to write down. It polled for exactly that, so
  // taking it costs nothing; this process's clock is the fallback for a
  // confirm() that reports no date rather than the first answer.
  const confirmed = await confirm(stored);
  const at = Number.isFinite(confirmed) ? confirmed : now();

  // Only once it is known to have landed. Any earlier trades the buyer's
  // protection for the appearance of success.
  //
  // The signature goes first and the record second, as in the watchdog: a throw
  // while writing the record must not leave a spent bearer instrument on disk.
  // The record's list is rewritten from the store rather than edited, so what an
  // operator is told protects this exchange cannot drift from what is held.
  authorisations.discard(exchangeId, "raiseDispute");

  // ⚠️ The authorisations list is rewritten either way — the signature is spent
  // whoever ends up attributed — but the raise itself is claimed only if no
  // completed raise is already on the record. confirm() cannot tell whose
  // dispute it saw, so a watchdog raise that landed first answers this one's
  // confirm as well, and writing unconditionally would relabel it as the
  // buyer's. Whoever recorded a completed raise owns it.
  const settled = exchanges.get(exchangeId);
  exchanges.update(exchangeId, {
    ...(settled?.disputeRaisedAt == null ? { disputeRaisedAt: at, disputeRaisedBy: by } : {}),
    authorisations: authorisations.list(exchangeId),
  });
  return stored;
}
