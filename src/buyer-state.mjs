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
  split: "{refund} has come back to you.",
  split_note: "You both agreed. No platform, no court.",

  paid_meta: "{price} · {date}",
  returned_meta: "{price} · back to you",
  split_meta: "The seller has been paid the rest.",

  deadline_notice: "The seller is paid on {date}. If something's wrong, say so before then.",

  from_a_stranger: "{price} · from a stranger",
  arrived_all_good: "It arrived, all good",
  something_wrong: "Something's wrong",
  add_photo: "Add a photo",
  accept_proposal: "That works for me",
  decline_proposal: "No thanks",
  decline_unavailable: "Declining isn't available yet",
  settle_unavailable: "Settling isn't available yet",

  on_its_way: "On its way",
  needs_you: "The courier couldn't deliver it — it needs you",
  waiting_for_collection: "It's waiting for you to collect",
  looking_into_it: "We're looking into it",
  arrived: "It arrived",
  raised_for_you: "It hasn't arrived. We've raised this for you.",
  sorting_out: "Let's sort this out",
  with_a_person: "A person is now looking at it",
};

// A placeholder left unresolved would reach the screen as literal braces, so an
// absent value is an error rather than an empty string.
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (values[name] == null) throw new Error(`no value for {${name}}`);
    return String(values[name]);
  });
}

const line = (key, values = null) => ({
  key,
  text: values ? fill(BUYER_STRINGS[key], values) : BUYER_STRINGS[key],
});

export function moneyLine(record, { priceText = null, currency = "£" } = {}) {
  // An outcome is what happened to the money, and until the exchange finalises
  // nothing has. `held` is the line rendered in the absence of an outcome — it
  // is deliberately not one of `outcome`'s values.
  if (record.finalisedAt == null) return line("held");
  if (record.outcome !== "split") {
    return line(record.outcome === "returned" ? "returned" : "paid");
  }

  // Without a price there is no amount to state, and stating a fraction is
  // honest where inventing a number is not.
  const percent = record.buyerPercent;
  const refund =
    priceText == null
      ? `${percent}%`
      : `${currency}${formatAmount((Number(priceText) * percent) / 100)}`;
  return line("split", { refund });
}

// Whole pounds where the split is whole, two places where it is not. A refund
// of "£40.00" reads as a machine's output; "£40.5" reads as a bug.
function formatAmount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
