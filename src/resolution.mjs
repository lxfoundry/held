// src/resolution.mjs
// Settling a proposal — the interface, ahead of the implementation.
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
