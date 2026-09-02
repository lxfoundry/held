// src/buyer-view.mjs
// One exchange, as the buyer reads it.
//
// ⭐ Pure. It performs no I/O and reads no clock — the server gathers, this
// decides, the client draws. That is what makes every state a table row in a
// test rather than a browser session.
//
// It emits no copy of its own. Every string is resolved through BUYER_STRINGS,
// which is what lets one test hold the vocabulary rule over the whole surface.

import { BUYER_STRINGS, fill, moneyLine, parcelLine } from "./buyer-state.mjs";

export const ACTIONS = Object.freeze({
  COMPLETE: "complete",
  RAISE: "raise",
  PHOTO: "photos",
  SETTLE: "settle",
  DECLINE: "decline",
});

export function viewFor({ record, tracking, caseRecord = null, listing, events = [], photos = 0, allowConfirm = false }) {
  const priceText = listing?.priceText ?? null;
  const currency = listing?.currency ?? "£";

  const money = moneyLine(record, { priceText, currency });
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
    mediation: disputed && !settled ? mediationFrom(latest, priceText, currency, photos) : null,
    actions: actionsFor({ tracking, record, latest, allowConfirm }),
    caseFile: record.escalatedAt != null,
  };
}

function offersCompletion(tracking, record) {
  return Boolean(tracking?.delivered) && record.disputeRaisedAt == null && record.finalisedAt == null;
}

function deadlineNotice(record) {
  const at = new Date(record.redeemedAt + record.disputePeriodMs);
  const date = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return fill(BUYER_STRINGS.deadline_notice, { date });
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// ⚠️ occurrenceDatetime, never datetime: the two disagree by the UTC offset and
// the second is local time labelled as UTC.
function timelineFrom(events) {
  if (!events?.length) return null;
  return events
    .map((e) => ({ at: e.occurrenceDatetime ?? e.datetime ?? null, text: e.status ?? "" }))
    .filter((e) => e.at != null && e.text !== "")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function lastRound(caseRecord) {
  const rounds = caseRecord?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1]?.result ?? null : null;
}

function mediationFrom(latest, priceText, currency, photos) {
  if (!latest) return { question: null, photos, proposal: null };
  if (latest.status === "proposal") {
    return {
      question: null,
      photos,
      proposal: {
        refund: priceText == null
          ? `${latest.buyerPercent}%`
          : `${currency}${amount((Number(priceText) * latest.buyerPercent) / 100)}`,
        reasoning: latest.reasoning ?? "",
      },
    };
  }
  const ask = (latest.requests ?? []).find((r) => r.to === "buyer");
  return { question: ask?.asks ?? null, photos, proposal: null };
}

const amount = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

function actionsFor({ tracking, record, latest, allowConfirm }) {
  if (record.finalisedAt != null || record.escalatedAt != null) return [];

  if (offersCompletion(tracking, record)) {
    return [
      {
        id: ACTIONS.COMPLETE,
        label: BUYER_STRINGS.arrived_all_good,
        primary: true,
        enabled: allowConfirm,
        reason: allowConfirm ? null : "BUYER_UI_ALLOW_CONFIRM is not set",
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
  return asked
    ? [{ id: ACTIONS.PHOTO, label: BUYER_STRINGS.add_photo, primary: true, enabled: true, reason: null }]
    : [];
}
