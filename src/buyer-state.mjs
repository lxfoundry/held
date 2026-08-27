// src/buyer-state.mjs
// What the buyer reads.
//
// Two independent lines: what happened to their money, and what happened to
// their parcel. They change for different reasons and at different moments, so
// they are computed separately and never interleaved.
//
// This is the only module holding user-visible copy, which is what lets a
// single test assert the vocabulary rule over the entire surface.

export const BUYER_STRINGS = {
  held: "Your money is held. The seller can't touch it.",
  paid: "Seller has been paid.",
  returned: "Your money has been returned.",

  on_its_way: "On its way",
  needs_you: "The courier couldn't deliver it — it needs you",
  waiting_for_collection: "It's waiting for you to collect",
  looking_into_it: "We're looking into it",
  arrived: "It arrived",
  raised_for_you: "It hasn't arrived. We've raised this for you.",
  sorting_out: "Let's sort this out",
  with_a_person: "A person is now looking at it",
};

const line = (key) => ({ key, text: BUYER_STRINGS[key] });

export function moneyLine(record) {
  if (record.finalisedAt == null) return line("held");
  return line(record.outcome === "returned" ? "returned" : "paid");
}

export function parcelLine({ tracking, record }) {
  // Compared against null for the same reason as the decision function: these
  // are timestamps and zero is a real one.
  if (record.escalatedAt != null) return line("with_a_person");
  if (record.disputeRaisedAt != null) {
    return line(record.disputeRaisedBy === "watchdog" ? "raised_for_you" : "sorting_out");
  }

  const milestone = tracking?.current ?? "pending";
  if (tracking?.delivered) return line("arrived");

  // Both of these need the buyer to do something with the courier, and telling
  // them prominently is what earns the right to stand down rather than raise.
  if (tracking?.everAvailableForPickup || milestone === "available_for_pickup") {
    return line("waiting_for_collection");
  }
  if (milestone === "failed_attempt") return line("needs_you");

  if (milestone === "exception") return line("looking_into_it");
  return line("on_its_way");
}
