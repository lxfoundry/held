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
// ⭐ `resolveDispute` is not implemented anywhere in this repository. This file
// exists so that the shape of the call is fixed now and nothing else has to
// change when it arrives: the view already renders both endings it produces,
// and the server already routes to it.
//
// ⚠️ It throws rather than resolving. An action that appears to succeed while
// nothing settled is the one failure this whole system exists to prevent, so
// the absence is loud at every layer above.
//
// Implementing it means: the counterparty signs an EIP-712 resolution, this
// side submits it. `test/authorisations.test.mjs` deliberately forbids
// automated code from holding a `resolveDispute` authorisation — that is a
// design decision, not an oversight, so a human signature is required here.

import { utils } from "ethers";
import { toBasisPoints } from "./proposal.mjs";

export class NotBuiltError extends Error {
  constructor() {
    super("resolveDispute is not implemented: a proposal cannot be settled yet");
    this.name = "NotBuiltError";
  }
}

// eslint-disable-next-line no-unused-vars
export async function settle({ exchangeId, buyerPercent }) {
  throw new NotBuiltError();
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
