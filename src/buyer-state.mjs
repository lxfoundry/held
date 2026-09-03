// src/buyer-state.mjs
// What the buyer reads.
//
// Two independent lines: what happened to their money, and what happened to
// their parcel. They change for different reasons and at different moments, so
// they are computed separately and never interleaved.
//
// This is the only module holding user-visible copy that this system writes,
// which is what lets a single test assert the vocabulary rule over all of it.
//
// ⚠️ It is not the whole user-visible surface any more. A mediator's reasoning,
// its findings and its requests are shown to both parties and are written by a
// model, so no test here can reach them. The rule is put to it in
// fixtures/case/system.md instead, and it holds only as well as the model
// follows it — read a proposal before it goes in front of anyone.

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

  // One carrier scan, as one line. The join lives here for the same reason
  // every other join does: it is punctuation the buyer reads, and this module
  // is the only place a string the buyer reads may be written.
  timeline_entry: "{date}, {clock} · {text}",

  from_a_stranger: "{price} · from a stranger",
  arrived_all_good: "It arrived, all good",
  something_wrong: "Something's wrong",
  add_photo: "Add a photo",

  // ⭐ What the buyer has already sent, so that pressing "Add a photo" changes
  // something on screen. Two keys rather than one with a {count}: "1 photos
  // added" is the kind of wrong that reads as a broken product, and choosing
  // the noun outside this module would be public/held.js composing copy.
  photo_added_one: "1 photo added",
  photos_added: "{count} photos added",
  // Every thumbnail carries the same description, because that is all this
  // system truthfully knows about any of them: the buyer sent it. Naming the
  // subject would mean inventing one.
  photo_alt: "A photo you added",
  accept_proposal: "That works for me",
  decline_proposal: "No thanks",
  // ⭐ Declining is not a chain call, so it is not a button. A proposal is
  // inert: it settles only if the buyer accepts it, and if they never do, the
  // resolution window runs down and the case goes to a person. This line says
  // that, rather than promising a control that is coming.
  decline_unavailable: "If this isn't right, don't accept — a person will look at it.",
  // The operator has not armed settling. Neutral on purpose: the buyer never
  // learns an environment variable's name.
  settle_unavailable: "Accepting isn't available right now",
  complete_unavailable: "This isn't available right now",

  // The one line on the screen that no store made: a request that did not go
  // through. The server's own error body is an operator diagnostic and never
  // reaches the buyer, so this is what they are told instead.
  action_failed: "That didn't go through. Have another go.",

  // ⚠️ Drawn when a purchase cannot be read at all, which is the one screen
  // that has no model behind it — so the server sends this sentence in the
  // failure body beside its diagnostic, and the client draws it only when
  // nothing else stands. Spec §11: a purchase whose store is unreadable renders
  // as unavailable. Neutral, and it names nothing an operator would recognise.
  purchase_unavailable: "This purchase can't be shown right now.",

  // ⚠️ Not a parcel state — the absence of one. Every other line here is a
  // claim about where the parcel is, and this is what the screen says when
  // nothing has been scanned and there is no snapshot to read. Deliberately
  // without "yet": a finalised purchase draws this too, and there is nothing
  // still to come for it.
  no_tracking: "We don't have tracking for this",
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

export function moneyLine(record, { priceText = null, currency = "£", finalisedDate = null } = {}) {
  // An outcome is what happened to the money, and until the exchange finalises
  // nothing has. `held` is the line rendered in the absence of an outcome — it
  // is deliberately not one of `outcome`'s values, and has no second line.
  if (record.finalisedAt == null) return { ...line("held"), meta: null };

  // The listing's price, formatted the same way item.price is — a
  // presentational fact, never a claim about what the chain moved.
  const price = priceText == null ? null : `${currency}${priceText}`;

  if (record.outcome === "returned") {
    return {
      ...line("returned"),
      meta: price == null ? null : fill(BUYER_STRINGS.returned_meta, { price }),
    };
  }

  if (record.outcome === "paid") {
    return {
      ...line("paid"),
      meta:
        price == null || finalisedDate == null
          ? null
          : fill(BUYER_STRINGS.paid_meta, { price, date: finalisedDate }),
    };
  }

  if (record.outcome === "split") {
    // ⚠️ A split is a proportion, so a record that names none supports no
    // statement about the money at all. `Number(priceText) * null / 100` is
    // 0, so this branch used to read "£0 has come back to you." on a record
    // that says no such thing — the same invented claim the fall-through
    // below exists to prevent, and precisely the shape of every record
    // finalised before buyerPercent was written. The absence is answered the
    // way this module answers every other one: the record holds no outcome
    // this line can read, so it states none.
    const percent = record.buyerPercent;
    if (!Number.isFinite(percent)) return { ...line("held"), meta: null };

    // Without a price there is no amount to state, and stating a fraction is
    // honest where inventing a number is not. A price a human wrote with a
    // separator ("1,200") is not a number either, and reads as the same
    // absence one step later — "£NaN has come back to you." — so it takes the
    // same answer rather than a new one.
    const amount = priceText == null ? NaN : (Number(priceText) * percent) / 100;
    const refund = Number.isFinite(amount) ? `${currency}${formatAmount(amount)}` : `${percent}%`;
    return { ...line("split", { refund }), meta: BUYER_STRINGS.split_meta };
  }

  // ⚠️ Explicit, because this used to be the fall-through: an outcome that is
  // absent, or one this module has never heard of, would then have asserted
  // "Seller has been paid" — that the buyer's money is gone — on a record that
  // says no such thing. src/exchanges.mjs skips null fields when it writes and
  // does not validate what it reads, so the absence is reachable. The record
  // holds no outcome, so the line states none.
  return { ...line("held"), meta: null };
}

// Whole pounds where the split is whole, two places where it is not. A refund
// of "£40.00" reads as a machine's output; "£40.5" reads as a bug.
//
// ⭐ Exported because src/buyer-view.mjs formats the mediator's proposed refund
// with it. That figure and the settled one above are the same money on two
// consecutive screens of one dispute, and a second copy of this function is a
// second answer waiting to disagree with the first.
export function formatAmount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function parcelLine({ tracking, record }) {
  // A line describing an open process must not survive finalisation; a line
  // that states a fact may. "A person is now looking at it" and "Let's sort
  // this out" are both present-tense claims about a process still running —
  // once the exchange finalises they are false, and the line falls through
  // to whatever the tracking data actually shows. "It hasn't arrived. We've
  // raised this for you." states what happened, remains true after
  // settlement, and is not guarded by finalisation at all.
  const finalised = record.finalisedAt != null;

  // Compared against null for the same reason as the decision function: these
  // are timestamps and zero is a real one.
  if (!finalised && record.escalatedAt != null) return line("with_a_person");
  if (record.disputeRaisedAt != null) {
    if (record.disputeRaisedBy === "watchdog") return line("raised_for_you");
    if (!finalised) return line("sorting_out");
  }

  // ⚠️ An absence, not a state, and the same fall-through moneyLine's outcome
  // branch exists to close. Every line below is a positive claim about a
  // parcel and the last of them is unconditional, so a record whose tracker
  // resolves to no snapshot — cleaned up, never registered, or an EVENTS_DIR
  // pointing somewhere else — read "On its way" about a parcel nothing has
  // scanned, and on a finalised record it contradicted the money line above
  // it. A tracker that exists and has simply not been scanned yet is a
  // different thing and still reads "On its way".
  if (tracking == null) return line("no_tracking");

  const milestone = tracking.current ?? "pending";
  if (tracking.delivered) return line("arrived");

  // Both of these need the buyer to do something with the courier, and telling
  // them prominently is what earns the right to stand down rather than raise.
  if (tracking.everAvailableForPickup || milestone === "available_for_pickup") {
    return line("waiting_for_collection");
  }
  if (milestone === "failed_attempt") return line("needs_you");

  if (milestone === "exception") return line("looking_into_it");
  return line("on_its_way");
}
