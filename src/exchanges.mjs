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

function assertNoSecrets(value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase())) throw new SecretLeakError(here);
    assertNoSecrets(child, here);
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
      throw err;
    }
  }

  function put(record) {
    assertNoSecrets(record);
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

  function all() {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => get(f.slice(0, -".json".length)))
      .filter(Boolean);
  }

  function byTracker(trackerId) {
    return all().find((r) => r.trackerId === trackerId) ?? null;
  }

  return { put, get, update, all, byTracker, dir };
}
