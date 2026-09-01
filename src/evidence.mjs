// src/evidence.mjs
// What the mediator and the clerk read, and the only thing they read.
//
// The bundle is deterministic and hashed so a case is reproducible: a proposal
// is recorded against the bundle that produced it, and adding one photograph
// produces a different hash — which is the whole mechanism behind a second
// round.

import { createHash } from "node:crypto";
import { parseEventTime } from "./store.mjs";

export const PROVENANCE = Object.freeze(["carrier", "buyer", "seller", "listing", "chain"]);

// Ids are short because the model cites them repeatedly and a UUID per item is
// tokens spent on nothing. The prefix makes a citation readable in a case file.
const PREFIX = {
  tracking_event: "trk",
  photo: "pho",
  message: "msg",
  listing: "lst",
  offer_terms: "off",
};

// Stable key order, so a hash is over content rather than over whatever order
// an object literal happened to be written in.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  // ⚠️ Both of these before the object branch, and both are silent otherwise.
  // A Date has no own enumerable keys, so Object.keys() is empty and every Date
  // canonicalises to {} — two different instants producing one hash, on the
  // value the hash exists to distinguish. A BigInt is not an object at all and
  // JSON.stringify throws on it outright.
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? "Invalid Date" : value.toISOString();
  }
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, k) => {
      out[k] = canonical(value[k]);
      return out;
    }, {});
  }
  return value;
}

// ⚠️ Over the items, and deliberately not over the exchangeId.
//
// The hash is the replay key, and replay is what lets this system run with no
// network access to the model provider. Rebuilding the same case under a new
// exchangeId — which is what re-seeding does — must still find its recording;
// binding the key to the exchange would miss every one of them and force a live
// call, which is the failure mode replay exists to prevent.
//
// What that trades away: two exchanges whose evidence is byte-identical share a
// recording. Every real bundle carries per-parcel event ids and its own offer
// terms, so identical evidence means an empty bundle — a case with nothing to
// mediate — rather than two genuine cases colliding.
export function bundleHash(items) {
  return createHash("sha256").update(JSON.stringify(canonical(items))).digest("hex");
}

// ⚠️ Every source says when it happened in its own vocabulary. A captured
// carrier event carries `occurrenceDatetime` (and `datetime`, which is the same
// wall clock mislabelled as UTC — src/store.mjs settles which is right); an
// authored message fixture carries a plain numeric `at`. Normalising that once,
// here, is what lets ordering and the case file's timeline read one field.
//
// Reading `at` off a raw carrier event — which is what this module did first —
// yields undefined, so `a.at - b.at` is NaN, the sort silently no-ops and the
// ids come out in whatever order the caller happened to pass.
function momentOf(source) {
  if (typeof source?.at === "number" && Number.isFinite(source.at)) return source.at;
  return parseEventTime(source);
}

function byMoment(a, b) {
  const at = momentOf(a) ?? 0;
  const bt = momentOf(b) ?? 0;
  if (at !== bt) return at - bt;
  // Two events at the same instant would otherwise swap ids with the input
  // order, which is the reordering guarantee failing in the one case where the
  // timestamps cannot break the tie.
  return String(a?.eventId ?? "").localeCompare(String(b?.eventId ?? ""));
}

function item(kind, provenance, authored, content, n, at = null) {
  return { id: `${PREFIX[kind]}-${n}`, kind, provenance, visibility: "shared", authored, at, content };
}

export function assembleBundle({
  exchangeId,
  tracking = { events: [] },
  offerTerms = null,
  photos = [],
  messages = [],
  listing = null,
  viewer = "mediator",
} = {}) {
  const items = [];

  // Assembly order is fixed, and sorting inside each kind is what makes an id
  // stable when a caller hands the same evidence over in a different order.
  const events = [...(tracking.events ?? [])].sort(byMoment);
  events.forEach((e, i) => items.push(item("tracking_event", "carrier", false, e, i + 1, momentOf(e))));

  if (offerTerms) items.push(item("offer_terms", "chain", false, offerTerms, 1));

  [...photos]
    .sort((a, b) => a.path.localeCompare(b.path))
    // ⚠️ Referenced, never inlined. Base64 enters only at the API call; a
    // recording that embedded it would put megabytes into git on every round.
    .forEach((p, i) => items.push(item("photo", "buyer", false, { path: p.path, sha256: p.sha256 }, i + 1)));

  [...messages]
    .sort(byMoment)
    .forEach((m, i) => items.push(item("message", m.from === "seller" ? "seller" : "buyer", true, m, i + 1, momentOf(m))));

  if (listing) items.push(item("listing", "listing", true, listing, 1));

  // The viewer selects what that viewer may see. Today every item is shared and
  // every caller passes the mediator, so this selects everything — see the
  // spec's note that a field never exercised will be wrong the first time it is.
  const visible = items.filter((i) => i.visibility === "shared" || viewer === "mediator");

  return { exchangeId, items: visible, hash: bundleHash(visible) };
}
