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

// ⭐ allowConfirm and allowPhoto are the two operator settings this model
// takes. Both work the same way: the operator's choice becomes an action that
// is enabled, or one that is drawn disabled with a neutral reason. Neither is
// ever a reason for the client to draw something other than what it is told —
// an action the model emits is an action the screen shows.
//
// ⚠️ allowPhoto says *whether* a photograph is on offer, never which one. The
// branch of the damage case is an operator's decision and has no place in what
// the buyer is shown.
export function viewFor({ record, tracking, caseRecord = null, listing, events = [], allowConfirm = false, allowPhoto = false }) {
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
    actions: actionsFor({ tracking, record, latest, allowConfirm, allowPhoto }),
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
  return fill(BUYER_STRINGS.deadline_notice, { date: formatDate(record.redeemedAt + record.disputePeriodMs) });
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// The one date formatter, so two dates on the same screen — the deadline
// notice and a settled exchange's finalised date — can never disagree in
// style.
function formatDate(ms) {
  const at = new Date(ms);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

// The clock half of the same formatter, in the same style.
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
        date: formatDate(stamped),
        clock: formatClock(stamped),
        text: e.text,
      });
    });
  // An empty list is not a timeline: nothing is drawn for it, exactly as
  // nothing is drawn for a dispute that has produced no question yet.
  return entries.length ? entries : null;
}

function lastRound(caseRecord) {
  const rounds = caseRecord?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1]?.result ?? null : null;
}

// ⭐ The split currently on the buyer's screen, or null when the case is not at
// a proposal. Exported because the settle route has to submit exactly the
// number the screen showed, and working that out a second time — from the same
// case record, by the same rule, in another module — is how the figure a buyer
// accepted and the figure that settled would come to differ.
export function proposedPercent(caseRecord) {
  const latest = lastRound(caseRecord);
  return latest?.status === "proposal" ? latest.buyerPercent : null;
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
  const ask = (latest.requests ?? []).find((r) => r.to === "buyer");
  return { question: ask?.asks ?? null, proposal: null };
}


function actionsFor({ tracking, record, latest, allowConfirm, allowPhoto }) {
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

  const asked = (latest.requests ?? []).some((r) => r.to === "buyer");
  if (!asked) return [];
  // Drawn whether or not a photograph is on offer, exactly as completing is:
  // the mediator asked the buyer a question, and a question with no visible
  // way to answer it is worse than a disabled control that says why.
  return [
    { id: ACTIONS.PHOTO, label: BUYER_STRINGS.add_photo, primary: true,
      enabled: allowPhoto, reason: allowPhoto ? null : BUYER_STRINGS.photo_unavailable },
  ];
}
