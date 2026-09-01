// src/exchanges.mjs
// What the system knows about an exchange, as a file per exchange.
//
// Deliberately separate from the pre-signed authorisations in
// src/authorisations.mjs, and it enforces that separation rather than assuming
// it: a record is ordinary state anything may read, an authorisation is a
// bearer instrument. Keeping both in one place would apply the weaker of the
// two rules to both.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MalformedRecordError } from "./adapter.mjs";

// Every name a signature or a key could plausibly arrive under, matched at any
// depth — because a whole signed meta-transaction is exactly the kind of object
// that gets spread into a record in a hurry.
const SECRET_KEYS = new Set([
  "signature", "functionsignature", "sigr", "sigs", "sigv",
  "r", "s", "v", "privatekey", "mnemonic", "secret",
]);

export class SecretLeakError extends Error {
  constructor(path) {
    super(`refusing to write a record containing "${path}": that belongs in the authorisation store`);
    this.name = "SecretLeakError";
  }
}

export class CorruptRecordError extends Error {
  constructor(path, detail) {
    super(`${path} could not be read as a record: ${detail}`);
    this.name = "CorruptRecordError";
  }
}

// ⚠️ Scanned by value as well as by key. A field name nobody predicted is
// exactly how a signature gets in, so the shape is checked too: 65 bytes of hex
// is an ECDSA signature and nothing a record legitimately holds.
//
// Deliberately not 32 bytes. A transaction hash is 32 bytes of hex and is a
// perfectly reasonable thing to record, so that rule would forbid a legitimate
// field — and a check that has to be worked around stops being a check.
const SIGNATURE_VALUE = /^0x[0-9a-fA-F]{130}$/;

// The timestamps and durations the deadline logic reads. A record is where they
// enter the system, so this is the cheapest place to insist they are numbers:
// past here they reach arithmetic where a wrong type produces NaN, and NaN
// stands the watchdog down silently.
const MS_FIELDS = [
  "redeemedAt", "disputePeriodMs", "resolutionPeriodMs",
  "disputeRaisedAt", "disputeTimeoutAt", "escalatedAt", "finalisedAt",
  // When this system submitted a raise, as opposed to when the protocol
  // recorded one. The two differ whenever a relay lands and its confirmation
  // does not, and the gap is what attributes the dispute afterwards.
  "disputeRaiseAttemptedAt",
];

function assertNoSecrets(value, path = "") {
  if (typeof value === "string" && SIGNATURE_VALUE.test(value)) throw new SecretLeakError(path);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase())) throw new SecretLeakError(here);
    assertNoSecrets(child, here);
  }
}

// A period is a duration the protocol enforces a 7-day floor on, so zero is not
// a short window — it is a value that failed to arrive.
//
// ⚠️ Rejected here rather than trusted, because a zero period is silent
// downstream and expensive: dueAt collapses onto redeemedAt, every sweep reads
// "the window has closed", no dispute is ever raised, and the buyer pays in
// full when the real window lapses. It is finite, so the number check above
// passes it. The observed way in is a read-back landing on an RPC node one
// block behind: getOffer returns a truthy result with `exists: false` and every
// duration zeroed.
const PERIOD_FIELDS = ["disputePeriodMs", "resolutionPeriodMs"];

function assertShape(record) {
  for (const field of MS_FIELDS) {
    const value = record[field];
    if (value == null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new MalformedRecordError(
        record.exchangeId,
        `${field} is ${JSON.stringify(value)}, not a number of milliseconds`
      );
    }
    if (PERIOD_FIELDS.includes(field) && value <= 0) {
      throw new MalformedRecordError(
        record.exchangeId,
        `${field} is ${value}, and a period the protocol floors at 7 days cannot be zero or negative`
      );
    }
  }
}

export function createExchangeStore(dir) {
  mkdirSync(dir, { recursive: true });

  const pathFor = (exchangeId) => join(dir, `${String(exchangeId)}.json`);

  function get(exchangeId) {
    try {
      return JSON.parse(readFileSync(pathFor(exchangeId), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      if (err instanceof SyntaxError) throw new CorruptRecordError(pathFor(exchangeId), err.message);
      throw err;
    }
  }

  function put(record) {
    assertNoSecrets(record);
    assertShape(record);
    const target = pathFor(record.exchangeId);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, target);
    return record;
  }

  function update(exchangeId, patch) {
    const existing = get(exchangeId);
    if (!existing) throw new Error(`unknown exchange ${exchangeId}`);
    return put({ ...existing, ...patch });
  }

  const ids = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));

  // ⚠️ One unreadable file must not take the others with it. A half-written or
  // truncated record used to throw out of here, which meant every sweep died
  // before reaching the exchange whose window was about to close — and stayed
  // dead, because nothing repairs itself. Skipped and reported instead.
  function all() {
    const records = [];
    for (const id of ids()) {
      try {
        const record = get(id);
        if (record) records.push(record);
      } catch (err) {
        if (!(err instanceof CorruptRecordError)) throw err;
      }
    }
    return records;
  }

  // The other half of that: skipping silently would hide an exchange nobody is
  // watching, so an operator can ask which records could not be read.
  function unreadable() {
    return ids().filter((id) => {
      try {
        get(id);
        return false;
      } catch (err) {
        if (err instanceof CorruptRecordError) return true;
        throw err;
      }
    });
  }

  function byTracker(trackerId) {
    return all().find((r) => r.trackerId === trackerId) ?? null;
  }

  return { put, get, update, all, unreadable, byTracker, dir };
}
