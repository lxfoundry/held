#!/usr/bin/env node
// Create one exchange, end to end, and capture what the deadline logic needs.
//
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn>
//   node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <tn> --execute
//
// ⭐ And the recovery half of the same job:
//
//   node scripts/seed-exchange.mjs --adopt <exchangeId> --tracker <t> --tracking-number <tn> --execute
//
// --adopt sends no transaction. It exists because the window this script keeps
// short is not zero: an exchange can end up live on chain with no record and no
// authorisations — the relay landed, something after it did not. That exchange
// is holding the buyer's money with nothing standing guard, and the two failure
// messages at the bottom of this file say "check it before re-running" without
// saying what else to do. This is the what else. It reads the exchange back,
// signs the two authorisations against it and writes the record, so the
// watchdog can see an exchange it previously could not.
//
// ⚠️ THIS COMMAND SPENDS THE BUYER'S MONEY, AND NOTHING IT DOES CAN BE UNDONE.
// The single relayed transaction below creates the offer, commits to it and
// redeems it, and the commit moves the price out of the buyer's wallet into the
// protocol's escrow. There is no buyer-side cancel after the redeem: the money
// leaves escrow when the buyer confirms receipt, when a raised dispute is
// resolved, or when the window lapses — and a lapsed window pays the seller.
//
// ⭐ Which is why it plans and stops by default. Without --execute it performs
// every read and every guard, prints the offer it would create, and submits
// nothing: no transaction, no money moved, nothing that can be undone.
//
// ⚠️ Not the same claim as "signs nothing", and the difference is written down
// because it used to be stated wrongly here. A planning run of the seed path
// does produce the seller's offer signature, locally — it is off-chain, costs
// nothing, commits to nothing and is sent nowhere, and building the offer is
// where a bad price, a bad period or a missing field is actually caught, so a
// plan that skipped it would not be planning the run that happens. --adopt
// signs nothing without --execute. --execute is the only thing that makes
// either real, here and in scripts/confirm-receipt.mjs, where it means the same
// thing.
//
// The seller signs the offer off-chain and never sends a transaction. The buyer
// submits one relayed meta-transaction that creates the offer, commits to it and
// redeems it — so the offer does not exist on-chain until the moment of purchase,
// and the buyer never holds native currency.
//
// ⭐ The two authorisations are signed immediately afterwards, in this same run,
// and they cannot be signed earlier: the protocol requires raiseDispute and
// escalateDispute to come from the buyer, and the exchangeId they are scoped to
// does not exist until the purchase is mined. An exchange without them is
// unprotected and must be shown as such.

import { resolve } from "node:path";
import { Contract, constants, utils } from "ethers";
import { abis } from "@bosonprotocol/core-sdk";
import { connect, waitForState } from "../src/chain.mjs";
import { loadEnv, ROOT } from "../src/env.mjs";
import { createExchangeStore, CorruptRecordError } from "../src/exchanges.mjs";
import { createAuthorisationStore } from "../src/authorisations.mjs";

// ⚠️ `connect()` returns an environment narrowed to the chain keys — that
// `only` list is what keeps wallet keys and the tracking key out of each
// other's processes, so the settings this script needs beyond the chain are
// loaded separately rather than by widening it.
const settings = loadEnv({
  only: ["EXCHANGES_DIR", "AUTHORISATIONS_DIR", "ITEM_PRICE", "DELIVERY_TIMELINE_DAYS", "OFFER_METADATA_URI"],
});

const ok = (line) => console.log(`✓ ${line}`);
const info = (line) => console.log(`  ${line}`);
const step = (line) => console.log(`\n▶ ${line}`);

// ⚠️ The next token is a value only if it does not itself look like a flag.
// `--tracker --tracking-number XYZ` otherwise yields a trackerId of
// "--tracking-number", which passes every check here and then quietly names a
// parcel that does not exist. The tracker id is the handle the whole system
// resolves an exchange by, so a wrong one means this exchange never sees its
// own delivery events and the watchdog raises against a seller who performed.
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};

const MS = 1000;
const DAY_MS = 86_400 * MS;

// The offer's clock is backdated by this much against the chain's own, so that
// "redeemable from" is in the past by a margin rather than by a hair.
const CLOCK_MARGIN_MS = 60 * MS;

const trackerId = arg("tracker");
const trackingNumber = arg("tracking-number");
const adopt = arg("adopt");
const execute = process.argv.includes("--execute");
const force = process.argv.includes("--force");

// Carried into the command every plan-mode run prints at the end. A planning
// run that needed --force to get past a guard produces an --execute line that
// needs it too, and an operator following that line verbatim is the whole point
// of printing it.
const forceFlag = force ? " --force" : "";

// ⚠️ A flag that was passed but carries no value must stop the run, never fall
// through as though it had not been passed at all. `arg` above matches
// `--name value` only: the `=`-joined form never matches, and neither does a
// flag whose next token is another flag or an empty string.
//
// ⭐ For --adopt that is not a usage nuisance, it is the whole difference
// between the two modes. `--adopt=239` parses to nothing, and nothing means
// "do not adopt" — so the run silently becomes the one that creates an offer
// and escrows the buyer's money, reached by an operator who is mid-recovery
// and was handed a line ending in --execute by this very script. The tracker
// collision guard does not save them either: the premise of adopting is an
// exchange with no record, so there is nothing for it to collide with.
// --tracker and --tracking-number fail safe below, but they are checked here
// too, because a flag that behaves differently from its neighbour is its own
// trap.
//
// Placeholders rather than plausible values: an exchange id in an error message
// is one an operator might copy, and every id in this system names a live
// exchange holding someone's money.
const EXAMPLE_VALUE = { adopt: "<exchangeId>", tracker: "<trackerId>", "tracking-number": "<trackingNumber>" };
const passed = (name) => process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const valueless = Object.keys(EXAMPLE_VALUE).filter((name) => passed(name) && !arg(name));
if (valueless.length) {
  for (const name of valueless) {
    const example = EXAMPLE_VALUE[name];
    console.error(
      `✗ --${name} needs its value as the next argument: --${name} ${example}, not --${name}=${example}`
    );
  }
  if (valueless.includes("adopt")) {
    console.error("  refusing to continue: without it this run would not adopt anything — it would create a");
    console.error("  new exchange and escrow the buyer's money, which cannot be undone");
  }
  process.exit(1);
}

if (!trackerId || !trackingNumber) {
  console.error(
    "✗ usage: node scripts/seed-exchange.mjs --tracker <trackerId> --tracking-number <trackingNumber> [--execute] [--force]"
  );
  console.error(
    "     or: node scripts/seed-exchange.mjs --adopt <exchangeId> --tracker <trackerId> --tracking-number <trackingNumber> [--execute] [--force]"
  );
  console.error("  the tracker and tracking number are required either way, and neither may be another flag");
  console.error("  every value is the next argument: --tracker T, never --tracker=T");
  console.error("  without --execute nothing is submitted and no money moves: each mode reports what it would");
  console.error("  do and stops — seeding signs the seller's offer locally on the way, and sends it nowhere");
  console.error("  --adopt protects an exchange that already exists on chain, and sends no transaction at all");
  console.error("  --force overrides the guards that refuse a duplicate, in either mode");
  process.exit(1);
}

const seller = connect({ role: "seller", required: ["DISPUTE_RESOLVER_ID"] });
const buyer = connect({ role: "buyer" });
const { env, config, provider } = seller;
const protocol = config.contracts.protocolDiamond;
const explorer = (hash) => config.getTxExplorerUrl?.(hash) ?? hash;

const accountHandler = new Contract(protocol, abis.IBosonAccountHandlerABI, provider);
const offerHandler = new Contract(protocol, abis.IBosonOfferHandlerABI, provider);
const exchangeHandler = new Contract(protocol, abis.IBosonExchangeHandlerABI, provider);
const configHandler = new Contract(protocol, abis.IBosonConfigHandlerABI, provider);

// Anchored to the repository, not to wherever this was launched from — the
// same reasoning as scripts/watchdog.mjs, and it must resolve to the same
// place: a store built elsewhere makes a live exchange read as unprotected to
// the watchdog that is supposed to guard it. AUTHORISATIONS_DIR is checked by
// the store itself: inside the repository, only a path under state/ is
// accepted.
const under = (value, fallback) => resolve(ROOT, value || fallback);

const exchanges = createExchangeStore(under(settings.EXCHANGES_DIR, "state/exchanges"));
const authorisations = createAuthorisationStore(under(settings.AUTHORISATIONS_DIR, "state/authorisations"));

console.log(`config ${config.configId} — chain ${config.chainId}, environment "${config.envName}"`);
info(`seller ${seller.signer.address}`);
info(`buyer  ${buyer.signer.address}`);
if (!execute) info("planning only — nothing will be signed or submitted");

// ⭐ The record first, then the signatures, then the record again. Both paths
// into this function reach it with an exchange already live on chain and
// unguarded, so the ordering is the point: the record exists — and the
// watchdog can therefore see the exchange — before anything that can fail
// again is attempted. `authorisations` is the only field that changes.
//
// ⚠️ `put` is an unconditional overwrite, and the parcel this record names is
// taken from the arguments rather than from the surrounding scope. On the seed
// path the tracker was just verified against the store; on the adopt path it is
// an operator's typing about an exchange they have lost track of, and the
// tracker is how the watchdog finds any delivery evidence at all. Passing it in
// is what makes that visible at the two call sites instead of implied here.
async function protect({
  exchangeId,
  offerId,
  redeemedAt,
  disputePeriodMs,
  resolutionPeriodMs,
  trackerId: parcelTrackerId,
  trackingNumber: parcelTrackingNumber,
}) {
  exchanges.put({
    exchangeId: String(exchangeId),
    offerId,
    configId: config.configId,
    trackerId: parcelTrackerId,
    trackingNumber: parcelTrackingNumber,
    redeemedAt,
    disputePeriodMs,
    resolutionPeriodMs,
    disputeRaisedAt: null,
    disputeRaisedBy: null,
    disputeTimeoutAt: null,
    escalatedAt: null,
    finalisedAt: null,
    outcome: null,
    authorisations: [],
  });

  step("capturing the authorisations the deadline logic will need");
  const toAuthorise = [
    ["raiseDispute", (args) => buyer.coreSDK.signMetaTxRaiseDispute(args)],
    ["escalateDispute", (args) => buyer.coreSDK.signMetaTxEscalateDispute(args)],
  ];
  for (const [index, [action, sign]] of toAuthorise.entries()) {
    // ⚠️ Distinct nonces, so neither depends on the other having executed. The
    // handler marks nonces used rather than requiring them in sequence, so the
    // two are order-independent — but they must not collide, and two calls to
    // Date.now() in the same millisecond would.
    const actionNonce = Date.now() + index;
    const signedAction = await sign({ nonce: actionNonce, exchangeId });
    authorisations.save(exchangeId, action, signedAction, {
      nonce: actionNonce,
      userAddress: buyer.signer.address,
    });
    ok(`${action} authorised for exchange ${exchangeId} only`);
  }

  const captured = authorisations.list(exchangeId);
  exchanges.update(exchangeId, { authorisations: captured });
  return captured;
}

// ⭐ What is already on disk for this exchange, and — the part that matters —
// whether adopting would be resuming this script's own interrupted work rather
// than overwriting somebody's.
//
// `protect()` above writes the record before it signs anything, deliberately,
// so the failure it is arranged to survive leaves a *correct* record with an
// empty authorisation list and no instruments on disk. That is the exact state
// the recovery command printed at the bottom of this file is for, so the guard
// has to accept it: a refusal there is a live exchange left unguarded by an
// operator who did as they were told.
//
// The signature is narrow on purpose — no instrument held, an authorisation
// list that is present and empty, and the same tracker the record already
// names. Anything else is somebody's work: a populated list or a held
// instrument means protecting got further than this, and a *different* tracker
// is the case that matters most, because the tracker is not a chain fact,
// nothing merges it back, and the record is the only copy of it.
//
// Throws only what `exchanges.get` throws for a store it cannot read at all; a
// record that exists and cannot be parsed comes back as `unreadable`, carrying
// the message that names the file.
function existingProtection(exchangeId, parcelTrackerId) {
  const held = authorisations.list(exchangeId);
  let record = null;
  let unreadable = null;
  try {
    record = exchanges.get(exchangeId);
  } catch (err) {
    // A record that exists and cannot be parsed is still a record: overwriting
    // it silently would throw away the only copy of what it named.
    if (!(err instanceof CorruptRecordError)) throw err;
    unreadable = err.message;
  }
  const resumable =
    record != null &&
    held.length === 0 &&
    Array.isArray(record.authorisations) &&
    record.authorisations.length === 0 &&
    record.trackerId === parcelTrackerId;
  return { held, record, unreadable, resumable };
}

// Whether the command this file prints for a given exchange has to carry
// --force to be a command that works. An operator following a printed line
// verbatim is the whole point of printing it, so the line is built from what
// the guard would actually make of the state on disk rather than from a guess
// about which failure happened.
function forceNeededToAdopt(exchangeId, parcelTrackerId) {
  try {
    const { held, record, unreadable, resumable } = existingProtection(exchangeId, parcelTrackerId);
    if (resumable) return false;
    return held.length > 0 || record != null || unreadable != null;
  } catch {
    // The store itself could not be read. Adopting will say so and stop before
    // it signs anything, and no flag changes that — but this is not the place
    // to raise it: this runs inside a failure report that already has something
    // more urgent to say.
    return false;
  }
}

// ⭐ Reads what the offer actually says, and refuses a period that did not
// arrive. getOffer does not revert on an offer the node cannot see yet: it
// returns a perfectly truthy result with `exists: false` and every duration
// zeroed, and a zero period recorded as fact stands the watchdog down for the
// life of the exchange.
async function periodsFor(offerId, fallback = null) {
  let offer = null;
  try {
    offer = await offerHandler.getOffer(offerId);
  } catch (err) {
    if (!fallback) throw err;
    info(`could not read offer ${offerId} back (${err.message}) — recording the requested periods`);
  }
  const durations = offer?.exists ? offer.offerDurations : null;
  if (!durations) {
    if (!fallback) throw new Error(`offer ${offerId} does not read back from the protocol`);
    return fallback;
  }
  return {
    disputePeriodMs: Number(durations.disputePeriod) * MS,
    resolutionPeriodMs: Number(durations.resolutionPeriod) * MS,
  };
}

// --- adopt: protect an exchange that already exists -------------------------
if (adopt) {
  if (!/^\d+$/.test(adopt) || !Number.isSafeInteger(Number(adopt))) {
    console.error(`✗ --adopt expects a whole exchange id, not ${JSON.stringify(adopt)}`);
    process.exit(1);
  }
  // The protocol reads "007" as 7, and so must the store — otherwise this
  // writes 007.json for an exchange the watchdog looks up as 7.
  const exchangeId = String(Number(adopt));
  if (exchangeId !== adopt) console.log(`⚠ reading "${adopt}" as exchange ${exchangeId}`);

  step(`reading exchange ${exchangeId} back from the protocol`);
  const onChain = await exchangeHandler.getExchange(exchangeId);
  if (!onChain.exists) {
    console.error(`✗ exchange ${exchangeId} does not exist on ${config.configId}`);
    console.error("  an exchange id from another configuration names a different exchange, or none");
    process.exit(1);
  }
  // ⚠️ Ours, before anything else about it matters. Exchange ids are global and
  // dense, so 238 typed for 239 lands on a stranger's live exchange rather than
  // on nothing — and every other guard here would pass it.
  //
  // ⭐ The failure it prevents is the worst one this tool has. raiseDispute and
  // escalateDispute must come from the buyer who committed, so instruments
  // signed with our key against someone else's exchange revert when relayed;
  // the watchdog's read-back never confirms, so it never discards them, so it
  // retries them every sweep — while the record written here says the exchange
  // is protected and the exchange that actually needed protecting still has
  // nothing. This is the one tool for an operator who has lost track of what is
  // guarded: a false "protected" is worse than a visible refusal.
  const [buyerExists, buyerAccount] = await accountHandler.getBuyer(onChain.exchange.buyerId);
  const committedBy = buyerExists ? buyerAccount.wallet : null;
  if (!committedBy || committedBy.toLowerCase() !== buyer.signer.address.toLowerCase()) {
    console.error(`✗ exchange ${exchangeId} was not committed by this buyer, so it is not ours to protect`);
    console.error(
      committedBy
        ? `  it belongs to ${committedBy}`
        : `  buyer account ${onChain.exchange.buyerId} does not read back from the protocol`
    );
    console.error(`  this buyer is ${buyer.signer.address}`);
    console.error("  authorisations signed here would revert when relayed, and the record would claim it is guarded");
    console.error("  check the id — and check the configuration, since the same id names a different exchange on each");
    process.exit(1);
  }
  ok(`exchange ${exchangeId} was committed by this buyer`);

  if (onChain.voucher.redeemedDate.isZero()) {
    console.error(`✗ exchange ${exchangeId} has not been redeemed, so no window is open yet`);
    console.error("  there is nothing for the watchdog to guard until it is");
    process.exit(1);
  }
  if (!onChain.exchange.finalizedDate.isZero()) {
    console.error(`✗ exchange ${exchangeId} is already finalised — the money has moved`);
    console.error("  adopting it would write authorisations that can never be used");
    process.exit(1);
  }

  // ⚠️ Both stores, because either alone answers the wrong question. An empty
  // authorisation list is ordinary — the watchdog discards an instrument once
  // it has been spent, and confirming receipt discards both — so held.length
  // says nothing about whether this exchange is already known. The record is
  // what says that, and `protect()` overwrites it with `put`: every dispute,
  // escalation and finalisation field resets to null, and the tracker and
  // tracking number become whatever is on this command line. The sweep merges
  // the chain facts back, but the tracker is not a chain fact and does not come
  // back — a live exchange re-pointed at another parcel's evidence stands the
  // watchdog down while its own window lapses in the seller's favour.
  //
  // ⭐ Except for the one state this script itself produces. A correct record
  // with nothing signed against it is a half-finished `protect()`, and finishing
  // it is what adopting is for, so it is not an overwrite and must not be
  // refused as one — see `existingProtection` above.
  let existing;
  try {
    existing = existingProtection(exchangeId, trackerId);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error(`  ${exchanges.dir} could not be read, so what exchange ${exchangeId} already has is unknown`);
    console.error("  nothing was signed and nothing was written");
    process.exit(1);
  }
  const { held, record, unreadable, resumable } = existing;

  if (resumable) {
    ok(`exchange ${exchangeId} has a record naming tracker ${trackerId} and nothing signed against it`);
    info("this is a protect() that did not finish — adopting completes it rather than replacing anything");
  }

  const known = resumable
    ? []
    : [
        held.length ? `the ${held.join(" and ")} authorisation${held.length > 1 ? "s" : ""}` : null,
        unreadable
          ? "a record that cannot be read"
          : record
            ? `a record naming tracker ${record.trackerId}`
            : null,
      ].filter(Boolean);
  if (known.length && !force) {
    console.error(`✗ exchange ${exchangeId} already has ${known.join(" and ")}`);
    if (held.length) {
      console.error("  re-signing would replace instruments that are still valid, and the watchdog needs only");
      console.error("  one of each — an exchange holding both is already guarded and needs nothing done to it");
    }
    if (unreadable) {
      console.error(`  ${unreadable}`);
      console.error("  read that file before doing anything else: the tracker it names is the only copy of");
      console.error("  itself, and it is not on chain. Re-run with --force once you have it written down");
    } else if (record) {
      console.error("  adopting rewrites the record rather than merging into it: the dispute, escalation and");
      console.error(`  finalisation fields reset to null and the tracker becomes ${trackerId}`);
      if (record.trackerId !== trackerId) {
        console.error(`  ⚠ and the record names a different parcel — tracker ${record.trackerId}, not ${trackerId}`);
        console.error("  the dispute and finalisation fields come back on the next sweep; the tracker does not,");
        console.error("  so this is the case where forcing destroys the only copy of something");
        console.error(`  if ${record.trackerId} is this exchange's parcel, re-run with --tracker ${record.trackerId}`);
        console.error(`  if ${trackerId} is, write ${record.trackerId} down first, then re-run with --force`);
      } else {
        console.error(`  the record already names this parcel — read it in ${exchanges.dir} before replacing it`);
      }
    }
    console.error("  pass --force only if what is already there is known to be lost or wrong");
    process.exit(1);
  }
  if (known.length) console.log(`⚠ --force: replacing ${known.join(" and ")}`);

  // ⚠️ Not a refusal, unlike the seed path's version of this — and the
  // difference is deliberate. Two unfinalised exchanges naming one tracker make
  // byTracker ambiguous, and byTracker is the guard that stops one parcel being
  // bought twice, so this is worth saying loudly. But adopting sends no
  // transaction and escrows nothing, and the collision's usual cause is an
  // accidental second exchange for one parcel — which is exactly what adopt
  // exists to bring under guard. Refusing would leave the buyer's money
  // unwatched in order to protect a lookup.
  //
  // ⚠️ And it says what the two ways out actually cost, rather than leaving a
  // verb to do the work. There is no command here that undoes an escrow: the
  // only script that finalises an exchange is `confirm`, which pays the seller
  // and cannot be reversed, so "clear the duplicate" read as an instruction
  // pays twice for one parcel. Which exchange ends how is a decision, and this
  // says so.
  const collision = exchanges.byTracker(trackerId);
  if (collision && collision.exchangeId !== exchangeId && collision.finalisedAt == null) {
    console.log(`⚠ tracker ${trackerId} is already held by unfinalised exchange ${collision.exchangeId}`);
    console.log("⚠ two unfinalised exchanges naming one tracker make the duplicate-purchase guard ambiguous:");
    console.log(`⚠ a later seed run may find either ${exchangeId} or ${collision.exchangeId}, whichever it reads first`);
    console.log("⚠ the usual cause is a second escrow for one parcel, so one of the two is holding money that");
    console.log("⚠ should come back to the buyer — and there is no command for that. What is available:");
    console.log("⚠   · npm run confirm -- <exchangeId> --execute pays that exchange's seller immediately and");
    console.log("⚠     cannot be reversed — it is for the exchange whose parcel actually arrived, and only that one");
    console.log("⚠   · returning the buyer's money runs through a dispute: the watchdog raises one on the");
    console.log("⚠     exchange's behalf as its window nears expiry, and nothing here resolves a dispute — the");
    console.log("⚠     seller agrees a split or the dispute resolver decides");
    console.log("⚠ leaving both alone is not the neutral option: a window that lapses pays the seller, and here");
    console.log("⚠ that is twice for one parcel");
  }

  const redeemedAt = Number(onChain.voucher.redeemedDate) * MS;
  const offerId = onChain.exchange.offerId.toString();

  // ⚠️ Strict here, and it throws rather than falling back — a zero period
  // recorded as fact stands the watchdog down for the life of the exchange.
  // Caught so that failure reads like every other refusal in this file rather
  // than as an unhandled rejection: nothing has been signed or written yet, so
  // there is nothing to clean up and the answer is simply to try again.
  let periods;
  try {
    periods = await periodsFor(offerId);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    console.error(`  offer ${offerId} did not read back, so the periods every deadline counts from are unknown`);
    console.error("  nothing was signed and no record was written — the RPC is a pool, so try again in a moment");
    process.exit(1);
  }
  const { disputePeriodMs, resolutionPeriodMs } = periods;

  ok(`exchange ${exchangeId} is redeemed and unfinalised — its window is open`);
  info(`offer ${offerId} — dispute period ${disputePeriodMs / DAY_MS}d, resolution period ${resolutionPeriodMs / DAY_MS}d`);
  info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);
  info(`tracker          ${trackerId}`);
  info(`tracking number  ${trackingNumber}`);
  info("raiseDispute and escalateDispute would be signed for this exchange and kept for the watchdog");

  if (!execute) {
    console.log("");
    console.log("nothing was signed. No transaction is sent either way — adopting only signs and records.");
    console.log("Protect it with:");
    console.log(
      `  npm run seed -- --adopt ${exchangeId} --tracker ${trackerId} --tracking-number ${trackingNumber}${forceFlag} --execute`
    );
    process.exit(0);
  }

  const captured = await protect({
    exchangeId,
    offerId,
    redeemedAt,
    disputePeriodMs,
    resolutionPeriodMs,
    trackerId,
    trackingNumber,
  });
  console.log("");
  console.log(`exchange ${exchangeId} is now protected by ${captured.join(" and ")}.`);
  console.log(`Confirm receipt with: npm run confirm -- ${exchangeId} --execute`);
  process.exit(0);
}

// --- has this parcel already been bought? ----------------------------------
// ⚠️ The guard with no recovery behind it. Both failure messages at the bottom
// of this file end in "check it before re-running", and a re-run against the
// same parcel escrows a second lot of the buyer's money for one delivery —
// silently, because nothing else in the system objects to two exchanges naming
// one tracker.
step("checking this parcel is not already bought");
const existing = exchanges.byTracker(trackerId);
if (existing && existing.finalisedAt == null) {
  if (!force) {
    console.error(`✗ tracker ${trackerId} already belongs to exchange ${existing.exchangeId}, which is not finalised`);
    console.error("  seeding again would escrow the buyer's money a second time against the same parcel");
    console.error(`  confirm that one with: npm run confirm -- ${existing.exchangeId} --execute`);
    console.error("  or pass --force if a second exchange for this parcel is genuinely what you want");
    process.exit(1);
  }
  console.log(`⚠ --force: tracker ${trackerId} is already held by unfinalised exchange ${existing.exchangeId}`);
  console.log("⚠ this run escrows the buyer's money a second time for the same parcel");
} else if (existing) {
  ok(`tracker ${trackerId} was last used by exchange ${existing.exchangeId}, which is finalised`);
} else {
  ok(`tracker ${trackerId} is not held by any recorded exchange`);
}

// --- read everything the offer is built from -------------------------------
step("reading the resolver and the protocol floors");

// ⚠️ The exchange token comes from the resolver's own fee schedule, not from
// .env: an offer is valid only if its token is one the resolver lists.
const resolverId = env.DISPUTE_RESOLVER_ID;
const [resolverExists, , fees] = await accountHandler.getDisputeResolver(resolverId);
if (!resolverExists) {
  console.error(`✗ dispute resolver ${resolverId} does not exist on ${config.configId}`);
  process.exit(1);
}

// ⚠️ Named in .env means required, not preferred. Falling back to another token
// the resolver happens to list would price the offer — and take the buyer's
// money — in something nobody configured, so a mismatch is refused rather than
// quietly resolved.
const usable = fees.filter((f) => f.feeAmount.isZero() && f.tokenAddress !== constants.AddressZero);
const wanted = env.EXCHANGE_TOKEN_ADDRESS?.toLowerCase() ?? null;
const fee = wanted ? usable.find((f) => f.tokenAddress.toLowerCase() === wanted) : usable[0];
if (!fee) {
  if (wanted) {
    console.error(`✗ resolver ${resolverId} does not list ${env.EXCHANGE_TOKEN_ADDRESS} at zero fee on ${config.configId}`);
    for (const f of fees) info(`it lists ${f.tokenAddress} (${f.tokenName || "unnamed"}) at fee ${f.feeAmount.toString()}`);
    console.error("  the offer would be rejected at creation — point EXCHANGE_TOKEN_ADDRESS at a token this resolver takes");
  } else {
    console.error("✗ the resolver lists no usable token at zero fee");
  }
  process.exit(1);
}
const exchangeToken = fee.tokenAddress;
if (!wanted) info("EXCHANGE_TOKEN_ADDRESS is unset — taking the resolver's first zero-fee token");

// ⚠️ Read from the token, never assumed. Six decimals is a property of the USDC
// deployed on one chain, not of "the exchange token": the resolver's schedule
// decides what this offer is priced in, so that token's own decimals decide
// what ITEM_PRICE means. A hard-coded 6 against an 18-decimal token underprices
// the item by a factor of a trillion.
const erc20 = new Contract(exchangeToken, abis.ERC20ABI, provider);
const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
ok(`exchange token ${symbol} at ${exchangeToken}, ${decimals} decimals, resolver fee 0`);

const [sellerExists, sellerAccount] = await accountHandler.getSellerByAddress(seller.signer.address);
if (!sellerExists) {
  console.error(`✗ ${seller.signer.address} has no seller account — run \`npm run provision\` first`);
  process.exit(1);
}
ok(`seller account ${sellerAccount.id}`);

// ⚠️ Read the floors rather than trusting a written-down value: an offer below
// either is rejected outright, and they are protocol configuration.
const [minDispute, minResolution] = await Promise.all([
  configHandler.getMinDisputePeriod(),
  configHandler.getMinResolutionPeriod(),
]);
info(`period floors — dispute ${Number(minDispute) / 86_400}d, resolution ${Number(minResolution) / 86_400}d`);

// --- can the buyer actually pay? -------------------------------------------
// The protocol takes the price with transferFrom at commit, so a short balance
// or a short allowance reverts the whole atomic purchase — after both
// signatures have been produced and the relayer has been asked to submit them.
// Two reads on a provider already in hand answer it first instead.
//
// ⚠️ A second-run failure rather than a first-run one: `npm run provision`
// approves exactly the balance, so allowance and balance fall together with
// every purchase and both come up short at the same moment.
step("checking the buyer can pay");
const price = utils.parseUnits(settings.ITEM_PRICE ?? "20", decimals);
const amount = (value) => `${utils.formatUnits(value, decimals)} ${symbol}`;
const [balance, allowance] = await Promise.all([
  erc20.balanceOf(buyer.signer.address),
  erc20.allowance(buyer.signer.address, protocol),
]);
info(`price      ${amount(price)}`);
info(`balance    ${amount(balance)}`);
info(`allowance  ${amount(allowance)} to the protocol`);
if (balance.lt(price)) {
  console.error(`✗ the buyer holds ${amount(balance)} and this offer is priced at ${amount(price)}`);
  console.error(`  fund ${buyer.signer.address} before seeding an exchange`);
  process.exit(1);
}
if (allowance.lt(price)) {
  console.error(`✗ the buyer has approved ${amount(allowance)} and this offer is priced at ${amount(price)}`);
  console.error("  run `npm run provision` to re-grant the allowance");
  process.exit(1);
}
ok("the buyer can pay");

// --- build the offer -------------------------------------------------------
step("building the offer");

// ⚠️ The chain's clock, not this machine's. Every date here is compared against
// block.timestamp, and a local clock running ahead of the node makes the atomic
// redeem revert with nothing on screen to explain it — the offer would simply
// not be redeemable yet. Backdated by a margin on top, so "redeemable from" is
// comfortably in the past rather than equal to a bound that has to hold.
const latestBlock = await provider.getBlock("latest");
const now = latestBlock.timestamp * MS - CLOCK_MARGIN_MS;
info(`chain time ${new Date(latestBlock.timestamp * MS).toISOString()} at block ${latestBlock.number}`);

const deliveryDays = Number(settings.DELIVERY_TIMELINE_DAYS ?? 3);

// The window opens at purchase, not at delivery, so it has to cover shipping
// and inspection — and can never go below the protocol floor.
const requestedDisputePeriodMs = Math.max((deliveryDays + 14) * DAY_MS, Number(minDispute) * MS);
const requestedResolutionPeriodMs = Number(minResolution) * MS;
const metadataUri = settings.OFFER_METADATA_URI ?? "https://held.invalid/offer";

const fullOfferArgsUnsigned = {
  price: price.toString(),
  // ⭐ Zero, and it must stay zero: any deposit obliges the seller to fund
  // escrow before the buyer can commit, which reintroduces a gas-paying step.
  sellerDeposit: 0,
  agentId: 0,
  buyerCancelPenalty: 0,
  quantityAvailable: 1,
  validFromDateInMS: now,
  validUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Must be at or before now, or the atomic redeem in the same transaction
  // reverts.
  voucherRedeemableFromDateInMS: now,
  voucherRedeemableUntilDateInMS: now + 30 * DAY_MS,
  // ⚠️ Typed optional by the SDK, required in practice: its validation resolves
  // the redeemable-until date with `when("voucherValidDurationInMS", …)` and
  // throws "invalid BigNumber value" naming no field when it is absent. Exactly
  // one of the two must be non-zero; this sets the date.
  voucherValidDurationInMS: 0,
  disputePeriodDurationInMS: requestedDisputePeriodMs,
  resolutionPeriodDurationInMS: requestedResolutionPeriodMs,
  exchangeToken,
  disputeResolverId: resolverId,
  // ⚠️ Validated locally against ipfs://, http(s):// or a CIDv0 — a bare label
  // is rejected before anything is sent.
  metadataUri,
  metadataHash: "held-offer",
  collectionIndex: 0,
  // ⚠️ Typed optional, but signFullOffer reads `feeLimit.toString()` unguarded
  // and throws on undefined.
  feeLimit: price.toString(),
  royaltyInfo: { recipients: [], bps: [] },
  creator: 0, // OfferCreator.Seller — the seller signs, the buyer submits
  offerCreator: seller.signer.address,
  committer: buyer.signer.address,
  sellerId: sellerAccount.id.toString(),
  buyerId: 0,
  // Unconditional: nothing gates who may commit.
  condition: {
    method: 0,
    tokenType: 0,
    tokenAddress: constants.AddressZero,
    gatingType: 0,
    minTokenId: 0,
    maxTokenId: 0,
    threshold: 0,
    maxCommits: 0,
  },
  useDepositedFunds: false,
  sellerOfferParams: {
    collectionIndex: 0,
    royaltyInfo: { recipients: [], bps: [] },
    mutualizerAddress: constants.AddressZero,
  },
  mutualizerAddress: constants.AddressZero,
};

// --- what this run would do ------------------------------------------------
// ⭐ Printed whether or not --execute was passed, so the plan an operator reads
// is the plan that runs: the same reads, the same guards and the same
// construction happen either way, and the only difference below is whether
// anything is signed.
step(execute ? "what this run does" : "what this run would do");
info(`price            ${amount(price)} — ${price.toString()} base units at ${decimals} decimals`);
info(`exchange token   ${symbol} ${exchangeToken}`);
info(`seller           ${seller.signer.address} — account ${sellerAccount.id}`);
info(`buyer            ${buyer.signer.address}`);
info(`dispute resolver ${resolverId}`);
info(`valid            ${new Date(now).toISOString()} → ${new Date(now + 30 * DAY_MS).toISOString()}`);
info(`dispute period   ${requestedDisputePeriodMs / DAY_MS}d, from the redeem`);
info(`resolution       ${requestedResolutionPeriodMs / DAY_MS}d, from a raised dispute`);
info(`metadata         ${metadataUri}`);
info(`tracker          ${trackerId}`);
info(`tracking number  ${trackingNumber}`);
info("then raiseDispute and escalateDispute are signed for that exchange and kept for the watchdog");

// --- the seller signs, gaslessly -------------------------------------------
// ⭐ Deliberately above the gate. This signature is off-chain, costs nothing and
// commits to nothing — but building the offer struct is where a bad price, a
// bad period or a missing field is actually caught, and the SDK validates
// locally before it signs. Gating above this point would mean a planning run
// never exercised the one step most likely to be wrong, which is the opposite
// of what planning is for. Nothing leaves this machine until the relay below.
step("the seller signs the offer");
const offerSignature = await seller.coreSDK.signFullOffer({ fullOfferArgsUnsigned });
ok("signed — the seller sends no transaction and pays no gas");

if (!execute) {
  console.log("");
  console.log("the offer is valid and the seller's signature was produced locally.");
  console.log("Nothing was submitted and no money moved.");
  console.log("Escrow the buyer's money — which cannot be undone — with:");
  console.log(`  npm run seed -- --tracker ${trackerId} --tracking-number ${trackingNumber}${forceFlag} --execute`);
  process.exit(0);
}

// --- the buyer submits one relayed meta-transaction ------------------------
step("the buyer creates, commits and redeems in one transaction");
const nonce = Date.now();
const signedTx = await buyer.coreSDK.signMetaTxCreateOfferCommitAndRedeem({
  nonce,
  createOfferAndCommitArgs: { ...fullOfferArgsUnsigned, signature: offerSignature.signature },
});

// ⚠️ Its own guard, and the narrowest one in the file. The SDK POSTs the
// transaction to the relayer and only then builds what it returns, so a throw
// here can mean the submission failed — or that it succeeded and the answer was
// lost on the way back. No hash exists locally either way, which is exactly the
// shape that leaves an exchange nobody knows about: there is nothing to print,
// so the message is the whole value.
let tx;
try {
  tx = await buyer.coreSDK.relayMetaTransaction({
    functionName: signedTx.functionName,
    functionSignature: signedTx.functionSignature,
    sigR: signedTx.r,
    sigS: signedTx.s,
    sigV: signedTx.v,
    nonce,
  });
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  console.error("  the relay call failed, but a transaction may already have been submitted:");
  console.error("  the relayer is POSTed before this call returns, and no hash came back to print.");
  console.error(`  check ${buyer.signer.address} on the explorer before re-running — a re-run escrows the price again`);
  process.exit(1);
}

// ⚠️ The transaction is already submitted the moment relayMetaTransaction
// returns — tx.hash exists before wait() is even called, because the relayer
// has already accepted it. wait() can still fail or time out independently of
// what the chain does, and its receipt carries no status field, so a
// meta-transaction that reverted on chain comes back through exactly the same
// path as one that succeeded (scripts/watchdog.mjs states this too). Everything
// from here on, including wait() itself, runs inside one protected span: a
// throw anywhere in it reports what is already known — the hash, then the
// receipt, then the exchange id — rather than dying into a bare stack trace
// with nothing to look the transaction up by. Once a receipt exists the
// exchange id is captured, a record with an empty authorisations list is
// written before either signature is requested, and the two signing calls are
// the last things that can fail.
let receipt;
let exchangeId;
try {
  receipt = await tx.wait();
  ok(`relayed — tx ${explorer(receipt.transactionHash)}`);

  exchangeId = buyer.coreSDK.getCommittedExchangeIdFromLogs(receipt.logs);
  if (!exchangeId) {
    throw new Error("the transaction mined but no exchange id appears in its logs");
  }

  // ⚠️ Not read directly. The relayer resolves on mining and the shipped RPC is
  // a pool, so a read here can be answered by a node that does not have the
  // block — which reads exactly like a failed transaction and is not one.
  const onChain = await waitForState(
    async () => {
      const result = await exchangeHandler.getExchange(exchangeId);
      return result.exists && !result.voucher.redeemedDate.isZero() ? result : null;
    },
    { what: `exchange ${exchangeId} to read as redeemed` }
  );
  const redeemedAt = Number(onChain.voucher.redeemedDate) * MS;

  // The offer the protocol actually created, rather than one predicted before
  // it existed: the id arrives free with the exchange, and the periods the
  // offer was created with are what every deadline in this system counts from.
  const offerId = onChain.exchange.offerId.toString();

  // ⚠️ Tolerated rather than required, unlike the adopt path. This read sits in
  // the window between a live exchange and a written record — the window
  // everything below is arranged to keep short — so a read that fails here must
  // not cost the record. It falls back to what was asked for and says so.
  const { disputePeriodMs, resolutionPeriodMs } = await periodsFor(offerId, {
    disputePeriodMs: requestedDisputePeriodMs,
    resolutionPeriodMs: requestedResolutionPeriodMs,
  });

  ok(`exchange ${exchangeId} is redeemed — the window is open and the seller must fulfil`);
  info(`offer ${offerId} — dispute period ${disputePeriodMs / DAY_MS}d, resolution period ${resolutionPeriodMs / DAY_MS}d`);
  info(`window closes ${new Date(redeemedAt + disputePeriodMs).toISOString()}`);

  // ⭐ The same capture the adopt path uses, deliberately. Recovering an
  // exchange and creating one differ only in how the exchange came to exist;
  // what protecting it means must not drift between the two.
  const captured = await protect({
    exchangeId,
    offerId,
    redeemedAt,
    disputePeriodMs,
    resolutionPeriodMs,
    trackerId,
    trackingNumber,
  });

  console.log("");
  console.log(`exchange ${exchangeId} is live and protected by ${captured.join(" and ")}.`);
  console.log(`Confirm receipt with: npm run confirm -- ${exchangeId} --execute`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (receipt && exchangeId) {
    // The commit is in the logs, so the exchange exists whatever failed after
    // it, and it is holding the buyer's money with nothing standing guard.
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error(`  exchange ${exchangeId}`);
    console.error("  this exchange is live and is not yet protected");
    console.error("  protect it — no transaction, only signing and recording — with:");
    // ⚠️ Built from what is on disk, not from a guess about where this failed.
    // `protect()` writes the record before either signature, so the ordinary
    // failure leaves a record the adopt guard recognises as its own unfinished
    // work and no flag is wanted; a failure between the two signatures leaves an
    // instrument held, which that guard refuses without --force. A printed line
    // its own guard rejects is how a live exchange stays unguarded — the
    // operator does exactly as told, is refused, and reasonably declines to
    // force past a warning about losing something.
    const adoptForce = forceNeededToAdopt(exchangeId, trackerId) ? " --force" : "";
    console.error(
      `    npm run seed -- --adopt ${exchangeId} --tracker ${trackerId} --tracking-number ${trackingNumber}${adoptForce} --execute`
    );
    if (adoptForce) {
      console.error("    --force is in that line because part of this run's own work is already on disk;");
      console.error("    it will say what it is replacing before it does it");
    }
    console.error("  do NOT simply re-run: that escrows the buyer's money a second time");
  } else if (receipt) {
    // ⚠️ A receipt is not a commit. The relayer's receipt carries no status
    // field, so a reverted meta-transaction mines and resolves through exactly
    // the same path as a successful one — and with no BuyerCommitted log there
    // is nothing here to say an exchange was created at all. Calling one live
    // is how an operator ends up hunting for an exchange that never existed.
    console.error(`  tx ${explorer(receipt.transactionHash)}`);
    console.error("  the transaction mined but the protocol recorded no commit — the exchange may not exist;");
    console.error("  check it before re-running");
  } else {
    console.error(`  tx ${explorer(tx.hash)}`);
    console.error("  the transaction was submitted but its outcome is unconfirmed — check it before re-running");
    // There is a hash, so there is a way through: the explorer shows whether it
    // committed and under which id, and adopting closes the gap without sending
    // anything. Saying so here is the difference between a recoverable failure
    // and one an operator has to work out under time pressure.
    console.error("  if it did commit, take the exchange id from that transaction — the exchange is live and");
    console.error("  unprotected until it is adopted:");
    console.error(
      `    npm run seed -- --adopt <exchangeId> --tracker ${trackerId} --tracking-number ${trackingNumber} --execute`
    );
    console.error("  do NOT simply re-run: that escrows the buyer's money a second time");
  }
  process.exitCode = 1;
}
