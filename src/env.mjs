// Reads .env into a plain object. No dependency, no process.env mutation:
// callers take what they need and nothing leaks into child processes.
//
// ⭐ Pass `only` to get back just the keys a component is entitled to. The file
// holds wallet keys, a relayer credential and a model provider key alongside
// ordinary settings, so a component that cannot move funds should not be
// holding the means to. `only` makes that a property of the code rather than a
// claim in a document.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv({ required = [], only = null, requireFile = false } = {}) {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".env"), "utf8");
  } catch (err) {
    if (requireFile || err.code !== "ENOENT") {
      throw new Error(".env could not be read. Copy .env.example to .env and fill it in.");
    }
  }

  const allowed = only ? new Set(only) : null;
  const keep = (key) => !allowed || allowed.has(key);

  // An empty value means unset, not set-to-empty: .env.example ships with
  // blank secrets, and a blank one must never read as a configured one.
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !keep(m[1])) continue;
    const value = unquote(m[2].trim());
    if (value !== "") env[m[1]] = value;
  }

  // A real environment wins over the file, so a deployed host needs no .env at
  // all.
  for (const [key, value] of Object.entries(process.env)) {
    if (!keep(key)) continue;
    if (value !== undefined && value !== "") env[key] = value;
  }

  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing required environment: ${missing.join(", ")}`);

  return env;
}

// Strips a matched pair of surrounding quotes only. Stripping them
// independently would mangle a value that legitimately ends in one.
function unquote(value) {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.at(-1) === first) {
    return value.slice(1, -1);
  }
  return value;
}
