// src/cases.mjs
// Two stores with different lifetimes, deliberately separate.
//
// A case is live working state and lives under state/, which is gitignored, on
// the same footing as the exchange records. A recording is read by tests and by
// the replay path, so it is committed and lives under fixtures/.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEX = /^[0-9a-f]{16,64}$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function createCaseStore(dir) {
  mkdirSync(dir, { recursive: true });
  const path = (id) => join(dir, `${String(id).replace(/[^0-9A-Za-z_-]/g, "")}.json`);
  return {
    read: (exchangeId) => readJson(path(exchangeId)),
    write: (record) => writeFileSync(path(record.exchangeId), JSON.stringify(record, null, 2)),
    list: () => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))),
  };
}

export function createRecordingStore(dir) {
  mkdirSync(dir, { recursive: true });
  // The hash is a filename, so it is validated rather than trusted — the same
  // reason the event store validates a tracker id before writing one.
  const path = (hash) => {
    if (!HEX.test(hash)) throw new Error(`refusing to use "${hash}" as a recording hash`);
    return join(dir, `${hash}.json`);
  };
  return {
    find: (hash) => (HEX.test(hash) ? readJson(path(hash)) : null),
    save: (hash, { model, response }) =>
      // ⚠️ Note what is absent: the request. A recording keys on the bundle
      // hash and stores the answer. Storing the request would embed the
      // photographs, and a photograph is a file with a hash, not bytes in git.
      writeFileSync(path(hash), JSON.stringify({ bundleHash: hash, model, response }, null, 2)),
  };
}
