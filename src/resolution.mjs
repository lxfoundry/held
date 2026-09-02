// src/resolution.mjs
// Mutual resolution: both halves of it, in one file so they cannot disagree.
//
// The protocol settles a dispute on one call carrying two agreements — the
// counterparty's signature over a Resolution struct, and the caller's own
// submission of it:
//
//   resolveDispute(exchangeId, buyerPercentBasisPoints, sigR, sigS, sigV)
//   Resolution { exchangeId: uint256, buyerPercentBasisPoints: uint256 }
//
// signConsent() produces the first. settle() submits it. They are kept together
// because they have to agree on one number, and two files agreeing on a number
// is a thing that stops being true.
//
// ⚠️ buyerPercentBasisPoints is the *buyer's* share, 0-10000. Direction and
// scale are both easy to invert and inverting either pays the wrong party in
// full. The one conversion lives in src/proposal.mjs and is tested for
// direction; nothing here works it out a second time.
//
// ⭐ One party signs and the counterparty submits. That requirement is the
// protocol's, not this system's, which is what makes it worth relying on: no
// arrangement of this code can settle a dispute on one party's say-so.

import { utils } from "ethers";
import { toBasisPoints } from "./proposal.mjs";
import { outcomeFor } from "./adapter.mjs";
import { PERMITTED_ACTIONS } from "./authorisations.mjs";

// Why an exchange cannot be settled, decided from the record before anything is
// signed. Each of these is a revert the protocol would give anyway, named here
// so that a person reads a sentence rather than decodes one.
export class NotSettleableError extends Error {
  constructor(exchangeId, why) {
    super(`exchange ${exchangeId} cannot be settled: ${why}`);
    this.name = "NotSettleableError";
  }
}

export class NoConsentError extends Error {
  constructor(exchangeId) {
    super(`no consent is held for exchange ${exchangeId}: nothing settles without the counterparty's signature`);
    this.name = "NoConsentError";
  }
}

// ⭐ The property that makes this route safe to expose at all: a consent is
// bound to one exact percentage, so the only settlement it can produce is the
// one both parties looked at.
export class ConsentMismatchError extends Error {
  constructor(exchangeId, held, asked) {
    super(
      `the consent held for exchange ${exchangeId} is for ${held}%, not ${asked}%: ` +
        "a consent settles the split it was signed over and no other"
    );
    this.name = "ConsentMismatchError";
  }
}

// ⭐ The counterparty's half. It signs and nothing else: no chain, no provider,
// no gas, no transaction. Signing typed data is a local operation on a key, so
// this is reachable with a wallet alone.
//
// ⚠️ The domain is asked for, never declared. Boson's EIP712Domain carries no
// chainId field — the chain goes into `salt` — and a restated domain is one
// that can silently disagree with the contract that verifies it, exactly as
// src/chain.mjs reads contract addresses from the shipped configuration rather
// than repeating them. The independent statement of the domain lives in
// test/resolution-signature.test.mjs, where a change fails a test rather than a
// transaction.
//
// `signedBy` is recovered from the signature rather than read off the signer.
// It is the address that provably signed *this* struct, which is the only
// meaning worth storing beside it.
export async function signConsent({ coreSDK, exchangeId, buyerPercent }) {
  const buyerPercentBasisPoints = toBasisPoints(buyerPercent);
  const args = { exchangeId: String(exchangeId), buyerPercentBasisPoints };

  const typedData = await coreSDK.signDisputeResolutionProposal({ ...args, returnTypedDataToSign: true });
  const { r, s, v, signature } = await coreSDK.signDisputeResolutionProposal(args);

  // ethers verifies the struct types alone; EIP712Domain is the domain's own
  // description and it rejects it as a type. The SDK's own adapter drops it the
  // same way before signing.
  const types = { ...typedData.types };
  delete types.EIP712Domain;
  const signedBy = utils.verifyTypedData(typedData.domain, types, typedData.message, signature);

  return { buyerPercent, buyerPercentBasisPoints, signedBy, r, s, v };
}

// ⭐ The submitting half. It plans and stops unless `execute` is true, which is
// what --execute means everywhere else in this repository.
//
// `buyerPercent` is the split the caller is settling at — for the buyer's view,
// the number on the screen they pressed. It is required and it is checked
// against the consent rather than read from it: taking whichever split happened
// to be on disk would let a consent signed for one proposal settle a different
// one.
export async function settle({
  exchangeId,
  buyerPercent,
  exchanges,
  consents,
  authorisations,
  chain,
  execute = false,
}) {
  const record = exchanges.get(exchangeId);
  if (!record) throw new Error(`unknown exchange ${exchangeId}`);

  // ⚠️ Compared against null, not truthiness, for the reason the decision
  // function gives: these are timestamps and zero is a real one.
  if (record.finalisedAt != null) {
    throw new NotSettleableError(exchangeId, "it is already finalised");
  }
  if (record.disputeRaisedAt == null) {
    throw new NotSettleableError(exchangeId, "no dispute is open on it");
  }
  // Once a case is with a person, the split they reach is theirs to reach. The
  // protocol refuses a mutual resolution on an escalated dispute, and one that
  // slipped past would take the decision back off them.
  if (record.escalatedAt != null) {
    throw new NotSettleableError(exchangeId, "it has been escalated, and a person is deciding it");
  }

  if (buyerPercent == null) {
    throw new Error(`refusing to settle exchange ${exchangeId} without being told which split it settles at`);
  }

  const consent = consents.read(exchangeId);
  if (!consent) throw new NoConsentError(exchangeId);
  if (consent.buyerPercent !== buyerPercent) {
    throw new ConsentMismatchError(exchangeId, consent.buyerPercent, buyerPercent);
  }

  if (!execute) return { planned: true, finalisedAt: null, outcome: null, buyerPercent };

  // ⚠️ Checked here, before anything is signed, even though neither is used
  // until after the chain call — the same reasoning src/completion.mjs gives
  // for its authorisation store. These are the collaborators this function
  // reaches for *after* the money has moved, so an omitted one would otherwise
  // surface as a TypeError with the pot already split and the record never
  // written. A plan-and-stop discards nothing, which is why the checks sit
  // below that return rather than with the record's own preconditions.
  if (typeof consents?.discard !== "function") {
    throw new Error(`settling exchange ${exchangeId} needs a consent store to discard the spent consent`);
  }
  if (typeof authorisations?.discard !== "function") {
    throw new Error(`settling exchange ${exchangeId} needs an authorisations store to discard`);
  }

  // The relayer resolving is not the protocol having acted: a meta-transaction
  // that reverted comes back through the path a successful one returns through.
  // chain.resolve() is required to read back through the protocol, and what it
  // answers with is what gets written down.
  //
  // ⭐ A throw here leaves the consent on disk and the record untouched. That is
  // deliberate: a transaction whose confirmation timed out may yet have landed,
  // the watchdog reconciles finalisation and outcome from chain truth on its
  // next sweep, and a consent discarded here could not be produced again
  // without the counterparty.
  const { finalisedAt, buyerPercentBasisPoints } = await chain.resolve({ exchangeId, consent });

  // Spent. Discarded before the record is written, as everywhere else here: a
  // throw while writing the record must not leave a spent bearer instrument on
  // disk.
  consents.discard(exchangeId);

  // The exchange is over, so a standing authorisation now names an action that
  // can no longer happen — a liability with no upside.
  for (const action of PERMITTED_ACTIONS) {
    authorisations.discard(exchangeId, action);
  }

  // ⚠️ The protocol's number, not the one that was asked for, and mapped by the
  // one function that owns that mapping. They agree on every path that works;
  // where they do not, the record must state what happened.
  const settled = outcomeFor(buyerPercentBasisPoints);

  // The record's list is rewritten from the store rather than edited, so what an
  // operator is told protects this exchange cannot drift from what is held.
  exchanges.update(exchangeId, {
    finalisedAt,
    outcome: settled.outcome,
    buyerPercent: settled.buyerPercent,
    authorisations: authorisations.list(exchangeId),
  });

  return { planned: false, finalisedAt, outcome: settled.outcome, buyerPercent: settled.buyerPercent };
}
