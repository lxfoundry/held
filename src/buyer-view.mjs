// src/buyer-view.mjs
// One exchange, as the buyer reads it.
//
// ⭐ Pure. It performs no I/O and reads no clock — the server gathers, this
// decides, the client draws. That is what makes every state a table row in a
// test rather than a browser session.
//
// It emits no copy of its own. Every string is resolved through BUYER_STRINGS,
// which is what lets one test hold the vocabulary rule over the whole surface.

import { BUYER_STRINGS, fill, formatAmount, moneyLine, parcelLine } from "./buyer-state.mjs";

export const ACTIONS = Object.freeze({
  COMPLETE: "complete",
  RAISE: "raise",
  PHOTO: "photos",
  SETTLE: "settle",
  DECLINE: "decline",
});

// ⭐ allowConfirm is the one operator setting this model takes. The operator's
// choice becomes an action that is enabled, or one drawn disabled with a
// neutral reason — never a reason for the client to draw something other than
// what it is told. An action the model emits is an action the screen shows.
//
// ⚠️ There used to be a second, allowPhoto, and adding a photograph was drawn
// disabled unless the operator had named one in the page's URL. It gated the
// wrong thing. *Which* photograph is attached is a branch of the demonstration
// and remains the operator's — but it is a lookup in the rounds table, not a
// question, so it has no bearing on whether the buyer may answer the
// mediator at all. A permanently disabled primary control under a question
// asking for evidence was an interface that could not be used as drawn.
export function viewFor({ record, tracking, caseRecord = null, listing, photos = [], events = [], allowConfirm = false }) {
  const priceText = listing?.priceText ?? null;
  const currency = listing?.currency ?? "£";

  const money = moneyLine(record, {
    priceText,
    currency,
    finalisedDate: record.finalisedAt != null ? formatDate(record.finalisedAt) : null,
  });
  const parcel = parcelLine({ tracking, record });

  const disputed = record.disputeRaisedAt != null;
  const settled = record.finalisedAt != null;
  const latest = lastRound(caseRecord);

  return {
    exchangeId: String(record.exchangeId),
    item: {
      title: listing?.title ?? "",
      price: priceText == null ? "" : fill(BUYER_STRINGS.from_a_stranger, { price: `${currency}${priceText}` }),
    },
    money: { ...money, tone: money.key },
    parcel,
    note: money.key === "split" ? BUYER_STRINGS.split_note : null,
    // The timeline answers "where is it"; once a dispute exists the question is
    // "what happens now", and the two are never on screen together.
    timeline: disputed || settled ? null : timelineFrom(events),
    notice: offersCompletion(tracking, record) ? deadlineNotice(record) : null,
    mediation: disputed && !settled ? mediationFrom(latest, priceText, currency) : null,
    // ⭐ What the buyer has already sent, on the same window as the mediation
    // block: before a case exists there is no evidence, and after settlement
    // the money line is the answer rather than the file.
    //
    // ⚠️ It exists because "Add a photo" wrote a file nothing on screen drew,
    // so the one action a buyer can actually complete confirmed nothing. The
    // count used to ride along inside `mediation`, read by nothing, and was
    // removed for that reason — the field was never the mistake, not drawing
    // it was.
    evidence: disputed && !settled ? evidenceFrom(photos, record.exchangeId) : null,
    actions: actionsFor({ tracking, record, latest, allowConfirm }),
    // Copy for something the stores cannot know happened: the buyer pressed a
    // button and the request did not go through. It is carried on every model
    // so that public/held.js can say so without composing a sentence of its
    // own — the vocabulary rule holds because this module emits every string.
    actionFailed: BUYER_STRINGS.action_failed,
    caseFile: record.escalatedAt != null,
  };
}

function offersCompletion(tracking, record) {
  return Boolean(tracking?.delivered) && record.disputeRaisedAt == null && record.finalisedAt == null;
}

function deadlineNotice(record) {
  // ⚠️ Both terms, not their sum. src/exchanges.mjs permits a null redeemedAt
  // and does not validate what it reads, and `null + 17 days` is not an error
  // — it is a number, an instant in January 1970, which this line then stated
  // as confidently as a real one: "The seller is paid on 18 January."
  //
  // ⭐ This is the only warning the buyer gets, and inaction pays the seller,
  // so a wrong date here is the one copy error on this screen with a cost.
  // Saying nothing leaves the deadline unstated; saying a date the record does
  // not hold tells them to act by a day that means nothing.
  if (!Number.isFinite(record.redeemedAt) || !Number.isFinite(record.disputePeriodMs)) return null;
  return fill(BUYER_STRINGS.deadline_notice, { date: formatDate(record.redeemedAt + record.disputePeriodMs) });
}

// ⚠️ A fixed zone, and deliberately neither UTC nor the machine's own. These
// are instants, and a date is what a person reads off a calendar: formatting in
// UTC showed a deadline stamped at 00:30 on the 19th as the 18th to a buyer
// whose clock already said the 19th, which is a day early on a line telling
// them when to act. Formatting in the machine's zone would instead make the
// date on screen depend on which laptop served the page, and the test that
// pins it depend on where it runs.
const ZONE = "Europe/London";

// One style, stated once, so no two dates on the same screen can disagree in
// how they are written. What the two formatters below differ in is only which
// clock the instant is read against, which is the whole distinction.
const DATE_STYLE = { day: "numeric", month: "long" };

// An instant with no zone attached, read against the buyer's calendar: the
// deadline they are told to act by, and the day a settled exchange finalised.
const DATE = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, ...DATE_STYLE });

function formatDate(ms) {
  return DATE.format(new Date(ms));
}

// ⚠️ A wall-clock reading, and separate from formatDate for one reason:
// timelineFrom below shifts a carrier's stamp by its own offset precisely so
// that reading it as UTC gives the time printed on the scan. Passing that
// through the buyer's zone would add the offset a second time — moving a 23:30
// scan onto the next day while formatClock, which does read it as UTC, went on
// saying 23:30. It pairs with formatClock and with nothing else.
const STAMP_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...DATE_STYLE });

function formatStampDate(ms) {
  return STAMP_DATE.format(new Date(ms));
}

// The clock half of the stamp formatter, in the same style.
function formatClock(ms) {
  const at = new Date(ms);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
}

// ⚠️ The offset a carrier stamped its own scan with, added back before
// formatting rather than normalised away. A parcel scanned at 09:13 in London
// is what the buyer will compare this line against, and reading it as UTC
// would show 08:13 — and would move a late-evening scan onto the day before.
// Everything else this module formats is an instant with no zone attached.
const OFFSET = /([+-])(\d{2}):?(\d{2})$/;
function offsetOf(stamp) {
  const parts = OFFSET.exec(stamp);
  if (!parts) return 0;
  return (parts[1] === "-" ? -1 : 1) * (Number(parts[2]) * 60 + Number(parts[3])) * 60_000;
}

// ⚠️ occurrenceDatetime, never datetime: the two disagree by the UTC offset and
// the second is local time labelled as UTC. There is no fallback to it — a line
// the buyer reads at the wrong time is worse than a line they do not read — and
// an event carrying neither a usable stamp nor a description is not shown.
function timelineFrom(events) {
  if (!events?.length) return null;
  const entries = events
    .map((e) => ({ stamp: e.occurrenceDatetime ?? "", text: e.status ?? "" }))
    .map((e) => ({ ...e, at: Date.parse(e.stamp) }))
    .filter((e) => Number.isFinite(e.at) && e.text !== "")
    .sort((a, b) => b.at - a.at)
    .map((e) => {
      const stamped = e.at + offsetOf(e.stamp);
      return fill(BUYER_STRINGS.timeline_entry, {
        date: formatStampDate(stamped),
        clock: formatClock(stamped),
        text: e.text,
      });
    });
  // An empty list is not a timeline: nothing is drawn for it, exactly as
  // nothing is drawn for a dispute that has produced no question yet.
  return entries.length ? entries : null;
}

// ⚠️ The round *is* the mediator's answer — there is no `result` wrapper to
// unpick. scripts/mediate.mjs writes `{ ...result, bundleHash }` into the
// rounds array, src/mediator.mjs reads `rounds.at(-1).bundleHash` off the same
// level, and src/clerk.mjs reads `round.requests` off it too. Reaching for
// `.result` here read `undefined` on every record this system actually writes,
// so the mediation block and its actions were unreachable from real data while
// the tests, which built the wrapper themselves, stayed green.
function lastRound(caseRecord) {
  const rounds = caseRecord?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1] ?? null : null;
}

// ⭐ Every field here is drawn, and the ids are deliberately not among them.
// A photograph is located by its position in the case's own list, so nothing a
// caller sends is ever resolved against the filesystem — src/buyer-server.mjs
// bounds the index and then checks the file it resolved to is inside the
// photographs directory, and a name in this model would be a third way in.
//
// ⚠️ One alt line for all of them, from BUYER_STRINGS like every other string
// this module emits. What each photograph shows is something only the buyer
// knows, and a description invented here would be a claim no store made.
function evidenceFrom(photos, exchangeId) {
  const held = Array.isArray(photos) ? photos : [];
  if (held.length === 0) return null;
  return {
    summary: held.length === 1
      ? BUYER_STRINGS.photo_added_one
      : fill(BUYER_STRINGS.photos_added, { count: held.length }),
    alt: BUYER_STRINGS.photo_alt,
    photos: held.map((_, index) => `/api/purchases/${exchangeId}/photos/${index}`),
  };
}

// ⚠️ Nothing here that the screen does not draw. A count of the photographs
// already attached used to ride along in this block, read by nothing — and a
// field nothing reads is a claim nobody checks.
function mediationFrom(latest, priceText, currency) {
  if (!latest) return { question: null, proposal: null };
  if (latest.status === "proposal") {
    return {
      question: null,
      proposal: {
        refund: priceText == null
          ? `${latest.buyerPercent}%`
          : `${currency}${formatAmount((Number(priceText) * latest.buyerPercent) / 100)}`,
        reasoning: latest.reasoning ?? "",
      },
    };
  }
  // ⚠️ whoCanProvide and what, which is what the model's schema names these —
  // see src/proposal.mjs and any recording under fixtures/case/recordings. `to`
  // and `asks` were fields nothing has ever written.
  const ask = (latest.requests ?? []).find((r) => r.whoCanProvide === "buyer");
  return { question: ask?.what ?? null, proposal: null };
}


function actionsFor({ tracking, record, latest, allowConfirm }) {
  if (record.finalisedAt != null || record.escalatedAt != null) return [];

  if (offersCompletion(tracking, record)) {
    return [
      {
        id: ACTIONS.COMPLETE,
        label: BUYER_STRINGS.arrived_all_good,
        primary: true,
        enabled: allowConfirm,
        // ⚠️ The operator diagnostic (which env var, and that it's unset) is
        // Task 6's job to log server-side. This module emits no copy of its
        // own — the buyer only ever sees "the tool is unconfigured".
        reason: allowConfirm ? null : BUYER_STRINGS.complete_unavailable,
      },
      { id: ACTIONS.RAISE, label: BUYER_STRINGS.something_wrong, primary: false, enabled: true, reason: null },
    ];
  }

  if (record.disputeRaisedAt == null || latest == null) return [];

  if (latest.status === "proposal") {
    return [
      // ⚠️ Disabled and truthful. resolveDispute is not implemented, and an
      // action that appears to succeed while nothing settled is the one failure
      // this system exists to prevent.
      { id: ACTIONS.SETTLE, label: BUYER_STRINGS.accept_proposal, primary: true,
        enabled: false, reason: BUYER_STRINGS.settle_unavailable },
      // ⚠️ Disabled and truthful, same reason: there is no route and no chain
      // path behind declining, so it must not read as pressable.
      { id: ACTIONS.DECLINE, label: BUYER_STRINGS.decline_proposal, primary: false,
        enabled: false, reason: BUYER_STRINGS.decline_unavailable },
    ];
  }

  // whoCanProvide, for the reason mediationFrom above gives: a request names
  // the party who can answer it, and this must ask the same question of the
  // same field, or a question is drawn with no way to answer it.
  const asked = (latest.requests ?? []).some((r) => r.whoCanProvide === "buyer");
  if (!asked) return [];
  // ⭐ Enabled, always. The mediator asked the buyer a question and this is the
  // control that answers it; nothing about the operator's configuration bears
  // on whether they may. Which photograph it attaches is settled behind this,
  // in src/case-input.mjs, from the rounds table.
  return [
    { id: ACTIONS.PHOTO, label: BUYER_STRINGS.add_photo, primary: true, enabled: true, reason: null },
  ];
}
