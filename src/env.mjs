// Reads .env into a plain object. No dependency, no process.env mutation:
// callers take what they need and nothing leaks into child processes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv({ required = [], optional = true } = {}) {
  let raw = "";
  try {
    raw = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    if (!optional) {
      throw new Error(".env not found. Copy .env.example to .env and fill it in.");
    }
  }

  // An empty value means unset, not set-to-empty: .env.example ships with
  // blank secrets, and a blank one must never read as a configured one.
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value !== "") env[m[1]] = value;
  }

  // A real environment wins over the file, so a deployed host needs no .env at all.
  for (const key of Object.keys(process.env)) {
    if (process.env[key] !== undefined && process.env[key] !== "") env[key] = process.env[key];
  }

  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing required environment: ${missing.join(", ")}`);

  return env;
}
