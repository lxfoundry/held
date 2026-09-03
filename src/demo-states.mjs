// src/demo-states.mjs
// Every screen state the buyer's view can reach, as data.
//
// The view is a pure function of three stores — the exchange record, the
// tracking snapshot and the case record — so a state is reached by putting
// those three in a particular arrangement and nothing else. Reaching one by
// hand means editing JSON under state/ and remembering which combination of
// fields produces which screen; this is that table, written down once.
//
// ⭐ Each entry declares the state it claims to produce, and
// test/demo-states.test.mjs renders every entry through viewFor() and checks
// the claim. So the catalogue is not documentation that can drift from the
// code: it is a table-driven test of the whole view, and the same table
// scripts/demo-states.mjs materialises on disk for a browser.
//
// ⚠️ These are demonstration records. They are not exchanges — nothing on any
// chain corresponds to them, they carry no offerId and no pre-signed
// authorisation, and so every action drawn on them fails when pressed. That
// failure is honest and is itself one of the states below. The id range says
// so at a glance: a real exchange id is a small integer the protocol assigned.

import { deriveState } from "./store.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ⚠️ Eight digits, so a demonstration record can never collide with an id the
// protocol assigned — those are small and sequential, and will not reach here
// within the life of this repository. The prefix is also what
// scripts/demo-states.mjs matches on to clean them up again, so it is the one
// thing about these ids that is load-bearing.
export const DEMO_ID_PREFIX = "999999";
export const isDemoId = (id) => String(id).startsWith(DEMO_ID_PREFIX);

// The protocol's own periods, taken from a real seeded exchange rather than
// invented: 17 days to dispute, 7 to resolve. The deadline notice states a date
// computed from these, so a made-up period would put a made-up date on screen.
const DISPUTE_PERIOD_MS = 1_468_800_000;
const RESOLUTION_PERIOD_MS = 604_800_000;

// ⭐ Two of the three milestones below never appear in a capture under
// fixtures/events — no parcel we tracked was ever refused at the door or held
// at a depot — so the states that depend on them are unreachable from real
// data. These event lists exist to reach them and are marked as what they are:
// a demo courier, a demo tracking number, no location, and ids that say
// "demo" in the filename they are written to.
//
// ⚠️ Only the events are written here. The milestone state is derived from
// them by the store's own deriveState(), exactly as a real push is, so a
// snapshot this produces is one the ingest path could have produced. The test
// asserts the derived state matches what each entry claims it needs.
const demoEvent = (milestone, status, at) => ({
  statusMilestone: milestone,
  statusCode: milestone,
  occurrenceDatetime: at,
  status,
  location: null,
});

export const DEMO_TRACKERS = {
  "demo-failed-attempt": {
    trackingNumber: "DE000009902GB",
    events: [
      demoEvent("in_transit", "Accepted at depot", "2026-08-30T09:12:00+01:00"),
      demoEvent("out_for_delivery", "Out for delivery", "2026-09-01T07:40:00+01:00"),
      demoEvent("failed_attempt", "Delivery attempted, nobody available", "2026-09-01T11:26:00+01:00"),
    ],
  },
  "demo-available-for-pickup": {
    trackingNumber: "DE000009903GB",
    events: [
      demoEvent("in_transit", "Accepted at depot", "2026-08-30T09:12:00+01:00"),
      demoEvent("out_for_delivery", "Out for delivery", "2026-09-01T07:40:00+01:00"),
      demoEvent("available_for_pickup", "Available for collection", "2026-09-01T14:03:00+01:00"),
    ],
  },
  // ⚠️ No available_for_pickup event anywhere in this list, and that is the
  // point of keeping it separate from the one above. everAvailableForPickup is
  // sticky in the store and parcelLine() tests it before the current
  // milestone, so an exception that followed a collection notice reads as "It's
  // waiting for you to collect" — correctly, but then this entry would be a
  // duplicate of the previous one rather than the exception state.
  "demo-exception": {
    trackingNumber: "DE000009904GB",
    events: [
      demoEvent("in_transit", "Accepted at depot", "2026-08-30T09:12:00+01:00"),
      demoEvent("exception", "Delivery exception, parcel held", "2026-09-01T16:55:00+01:00"),
    ],
  },
};

// The two captured snapshots the catalogue points at rather than re-inventing.
// They are committed under fixtures/events, so an entry naming one needs
// nothing generated and reads real carrier events in its timeline.
export const CAPTURED_IN_TRANSIT = "96a4693b-33b5-45b3-9fff-32c596798c96";
export const CAPTURED_DELIVERED = "8645991e-538a-40a2-8618-6f9d3777a6ae";

// The recorded mediator answers a case entry is seeded from. Both are real
// calls to the model, recorded against the evidence that produced them and
// committed under fixtures/case/recordings — so the question and the reasoning
// on those two screens are the model's own words, not copy written for a demo.
export const RECORDING_NEEDS_EVIDENCE =
  "242b157bf69688420924c8eefc1dbc546c166ee64466361fa20fb91f8ea0c9a0";
export const RECORDING_PROPOSAL =
  "79ddd114b88ad84692b4efce5cad0cfe12209177602d97c5fb773ee683e49fb7";

// ⭐ The listing of the case those two recordings are about. An entry seeded
// from a recorded round must carry it: the model's reasoning names four
// retired sets and the boxes they came in, so any other listing would put its
// words against the wrong item.
const MEDIATED_LISTING = {
  title: "Four retired sets",
  body: "Used - like new. Boxes in good condition.",
  priceText: "200",
};

// Everything a record holds before an entry says otherwise. `now` is passed in
// rather than read here, so the catalogue stays pure and a test can render it
// at a fixed instant.
export function baseRecord(exchangeId, now) {
  return {
    exchangeId: String(exchangeId),
    // ⚠️ Null, not a plausible-looking integer. No offer was created for this
    // and writing one would be the only field on the record that lies.
    offerId: null,
    configId: "demo",
    trackerId: null,
    trackingNumber: null,
    redeemedAt: now - 2 * DAY,
    disputePeriodMs: DISPUTE_PERIOD_MS,
    resolutionPeriodMs: RESOLUTION_PERIOD_MS,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeTimeoutAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: [],
  };
}

// ⭐ `expect` is the claim each entry makes about the screen it produces, in
// the view model's own vocabulary: the key of the money line, the key of the
// parcel line, the ids of the actions drawn, and whether the deadline notice,
// the timeline and the mediation block are present. Rendered and checked in
// test/demo-states.test.mjs.
export const CATALOGUE = [
  {
    id: "99999901",
    name: "on its way",
    what: "Money held, parcel still moving. The timeline is the carrier's own scans.",
    tracker: CAPTURED_IN_TRANSIT,
    listing: { title: "Nearly new road bike", body: "Ridden one summer. Small frame, new tyres.", priceText: "220" },
    patch: () => ({}),
    expect: { money: "held", parcel: "on_its_way", actions: [], notice: false, timeline: true, mediation: false },
  },
  {
    id: "99999902",
    name: "the courier couldn't deliver it",
    what: "Rung 1: the buyer has to do something with the courier, and the screen says so.",
    tracker: "demo-failed-attempt",
    listing: { title: "Vintage Anglepoise lamp", body: "Original 1970s. Rewired, works.", priceText: "65" },
    patch: () => ({}),
    expect: { money: "held", parcel: "needs_you", actions: [], notice: false, timeline: true, mediation: false },
  },
  {
    id: "99999903",
    name: "waiting for collection",
    what: "Also rung 1, and the state that makes the watchdog stand down permanently.",
    tracker: "demo-available-for-pickup",
    listing: { title: "Winter coat, worn twice", body: "Wool, size 12. Too warm for me.", priceText: "48" },
    patch: () => ({}),
    expect: { money: "held", parcel: "waiting_for_collection", actions: [], notice: false, timeline: true, mediation: false },
  },
  {
    id: "99999904",
    name: "something went wrong in transit",
    what: "An exception with no collection notice before it — the carrier is holding the parcel.",
    tracker: "demo-exception",
    listing: { title: "Boxed record player", body: "Belt drive, boxed with the original lid.", priceText: "130" },
    patch: () => ({}),
    expect: { money: "held", parcel: "looking_into_it", actions: [], notice: false, timeline: true, mediation: false },
  },
  {
    id: "99999905",
    name: "it arrived, nothing decided yet",
    what: "The one screen with both buttons, and the deadline the seller is paid on regardless.",
    tracker: CAPTURED_DELIVERED,
    listing: { title: "Cast iron casserole dish", body: "24cm, one chip on the lid handle.", priceText: "55" },
    patch: () => ({}),
    expect: {
      money: "held", parcel: "arrived", actions: ["complete", "raise"],
      notice: true, timeline: true, mediation: false,
    },
  },
  {
    id: "99999906",
    name: "it never arrived, and the watchdog acted",
    what: "Rung 2. Nobody pressed anything: the parcel stopped moving and the window was closing.",
    tracker: CAPTURED_IN_TRANSIT,
    listing: { title: "Child's balance bike", body: "Age 2-4. Scuffed, rolls fine.", priceText: "35" },
    patch: (now) => ({
      disputeRaisedAt: now - 6 * HOUR,
      disputeRaisedBy: "watchdog",
      disputeTimeoutAt: now + 7 * DAY,
    }),
    // No case record: the watchdog raised it and mediation has not run, so
    // there is no question and no proposal yet, and nothing to press.
    expect: { money: "held", parcel: "raised_for_you", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999913",
    name: "something's wrong, and nothing has been sent yet",
    what: "The buyer pressed \"Something's wrong\" and mediation has not run. No question, nothing to press, and no evidence block — because there is no evidence.",
    tracker: CAPTURED_DELIVERED,
    listing: { title: "Stand mixer with three attachments", body: "Bowl scratched underneath, motor sound.", priceText: "160" },
    // ⚠️ No case record and no photographs, deliberately. This is the state an
    // exchange sits in between the buyer raising and the mediator's first
    // round — the parcel line has changed and nothing else has, which is the
    // whole of what the buyer is told at that moment.
    patch: (now) => ({ disputeRaisedAt: now - 20 * 60_000, disputeRaisedBy: "buyer", disputeTimeoutAt: now + 7 * DAY }),
    expect: { money: "held", parcel: "sorting_out", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999907",
    name: "the mediator has asked the buyer for something",
    what: "Rung 3, first round. The question is the model's own, replayed from a recording.",
    tracker: CAPTURED_DELIVERED,
    listing: MEDIATED_LISTING,
    // ⭐ The evidence file is seeded at the opening round, so the photograph
    // the question asks for is one this case does not yet hold — which is what
    // makes "Add a photo" a press that changes something.
    caseInput: { from: "241", round: "1" },
    recording: RECORDING_NEEDS_EVIDENCE,
    patch: (now) => ({ disputeRaisedAt: now - 4 * HOUR, disputeRaisedBy: "buyer", disputeTimeoutAt: now + 7 * DAY }),
    expect: {
      money: "held", parcel: "sorting_out", actions: ["photos"],
      notice: false, timeline: false, mediation: "question", evidence: "1 photo added",
    },
  },
  {
    id: "99999908",
    name: "the mediator has proposed a number",
    what: "Rung 3, answered. One number over a pot both sides already locked, and either may decline.",
    tracker: CAPTURED_DELIVERED,
    listing: MEDIATED_LISTING,
    caseInput: { from: "241", round: "2" },
    recording: RECORDING_PROPOSAL,
    patch: (now) => ({ disputeRaisedAt: now - 2 * DAY, disputeRaisedBy: "buyer", disputeTimeoutAt: now + 5 * DAY }),
    // ⚠️ Both actions are drawn disabled, and that is the current truth rather
    // than a gap in the demo: resolveDispute is not implemented, so neither
    // accepting nor declining has anywhere to go.
    expect: {
      money: "held", parcel: "sorting_out", actions: ["settle", "decline"],
      notice: false, timeline: false, mediation: "proposal", evidence: "2 photos added",
    },
  },
  {
    id: "99999909",
    name: "a person has it now",
    what: "Rung 4. The case left the model, and nothing on this screen is pressable.",
    tracker: CAPTURED_DELIVERED,
    listing: { title: "Upright vacuum cleaner", body: "Serviced last year, new filter fitted.", priceText: "85" },
    patch: (now) => ({
      disputeRaisedAt: now - 3 * DAY,
      disputeRaisedBy: "buyer",
      disputeTimeoutAt: now + 4 * DAY,
      escalatedAt: now - 2 * HOUR,
    }),
    expect: { money: "held", parcel: "with_a_person", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999910",
    name: "ending — the seller was paid",
    what: "The ordinary ending. It arrived, nobody disputed, the money went where it was going.",
    tracker: CAPTURED_DELIVERED,
    listing: { title: "Two dining chairs", body: "Oak, one seat pad marked.", priceText: "90" },
    patch: (now) => ({ finalisedAt: now - 1 * HOUR, outcome: "paid" }),
    expect: { money: "paid", parcel: "arrived", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999911",
    name: "ending — the money came back",
    what: "The parcel never arrived, the watchdog raised it, and the buyer was made whole.",
    tracker: CAPTURED_IN_TRANSIT,
    listing: { title: "Boxed board game bundle", body: "Six games, all complete.", priceText: "40" },
    patch: (now) => ({
      disputeRaisedAt: now - 5 * DAY,
      disputeRaisedBy: "watchdog",
      finalisedAt: now - 1 * HOUR,
      outcome: "returned",
    }),
    // ⚠️ Still "It hasn't arrived. We've raised this for you." after
    // finalisation, deliberately: it states what happened rather than
    // describing a process, so it stays true. The two present-tense lines do
    // not survive here, which is why 99999912 below reads "It arrived".
    expect: { money: "returned", parcel: "raised_for_you", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999912",
    name: "ending — they split it",
    what: "The ending both parties chose. Amber, not green: it is neither of the other two.",
    tracker: CAPTURED_DELIVERED,
    listing: { title: "Wool rug, 2m x 3m", body: "Hand-knotted. One edge worn, photographed.", priceText: "120" },
    patch: (now) => ({
      disputeRaisedAt: now - 6 * DAY,
      disputeRaisedBy: "buyer",
      finalisedAt: now - 1 * HOUR,
      outcome: "split",
      buyerPercent: 30,
    }),
    expect: { money: "split", parcel: "arrived", actions: [], notice: false, timeline: false, mediation: false },
  },
  {
    id: "99999914",
    name: "there is no tracking for it at all",
    what: "No tracker the store can read — never registered, or its snapshot is gone. The screen says so rather than picking the first line of the parcel table, which is what it used to do.",
    // ⚠️ Names no tracker, and that is the state. Every other entry points at
    // one; this is the one where nothing resolves, and it is reachable in
    // ordinary use — an EVENTS_DIR pointing somewhere else is enough, and a
    // finalised record then drew "On its way" beneath "Seller has been paid".
    tracker: null,
    listing: { title: "Cast iron casserole dish", body: "Enamel chipped on the lid rim.", priceText: "45" },
    patch: () => ({}),
    expect: { money: "held", parcel: "no_tracking", actions: [], notice: false, timeline: false, mediation: false },
  },
];

// The exchange record an entry stands for, at the instant it is built.
export function recordFor(entry, now) {
  const tracker = DEMO_TRACKERS[entry.tracker];
  return {
    ...baseRecord(entry.id, now),
    trackerId: entry.tracker,
    trackingNumber: tracker?.trackingNumber ?? null,
    ...entry.patch(now),
  };
}

// The case record an entry stands for, in the shape scripts/mediate.mjs writes:
// the recorded answer spread flat into the rounds array with the hash of the
// evidence it answered. Null for an entry that seeds no case.
//
// ⚠️ Flat, with no `result` wrapper. That wrapper is what src/buyer-view.mjs
// used to reach through, and reproducing it here would hide the same bug again.
export function caseRecordFor(entry, recording) {
  if (!entry.recording) return null;
  return {
    exchangeId: entry.id,
    rounds: [{ ...recording.response, bundleHash: recording.bundleHash }],
    model: recording.model ?? null,
    closedAt: null,
    outcome: null,
  };
}

// The tracking state an entry's screen is rendered against — derived from the
// demo events by the store's own function, or read from the captured snapshot a
// caller supplies for the two entries that point at one.
export function trackingFor(entry, capturedSnapshots) {
  const demo = DEMO_TRACKERS[entry.tracker];
  if (demo) return deriveState(demo.events);
  return capturedSnapshots[entry.tracker]?.state ?? null;
}
