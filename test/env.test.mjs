// Tests for the environment reader, and above all for `only`.
//
// ⭐ `only` is the boundary that keeps the wallet keys, the relayer credential
// and the model provider key out of components with no business holding them —
// most of all the internet-facing receiver. An inverted filter would leak every
// one of them with nothing else failing, so the exclusions are asserted here
// directly rather than inferred from what a caller happens to read back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = fileURLToPath(new URL("../src/env.mjs", import.meta.url));

// loadEnv resolves .env from its own module location, so a test that needs a
// known file has to give it a root of its own — this repository's real .env
// holds real secrets and is never written to or read from here. env.mjs imports
// nothing but node builtins, so the copy is the same module; were it ever to
// grow a relative import, the copy would fail to load rather than pass quietly.
//
// Keys the file under test defines are cleared from the real process.env for
// the duration, so an exported value on the developer's machine cannot decide
// the result. A test that wants one sets it itself.
async function withEnvFile(contents, fn) {
  const root = mkdtempSync(join(tmpdir(), "held-env-"));
  const shadowed = new Map();
  for (const [, key] of (contents ?? "").matchAll(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/gm)) {
    shadowed.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    mkdirSync(join(root, "src"));
    copyFileSync(SOURCE, join(root, "src", "env.mjs"));
    if (contents !== null) writeFileSync(join(root, ".env"), contents);
    const { loadEnv } = await import(pathToFileURL(join(root, "src", "env.mjs")).href);
    return await fn(loadEnv);
  } finally {
    for (const [key, value] of shadowed) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function withProcessEnv(values, fn) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SECRETS = `SHIP24_API_KEY=apik_test
EVENTS_DIR=fixtures/events
BUYER_PRIVATE_KEY=0x00000000000000000000000000000000000000000000000000000000deadbeef
SELLER_PRIVATE_KEY=0x000000000000000000000000000000000000000000000000000000000badf00d
META_TX_RELAYER_API_KEY=relayer-credential
ANTHROPIC_API_KEY=sk-ant-test
`;

test("only keeps the keys it names and drops every other one in the file", async () => {
  await withEnvFile(SECRETS, (loadEnv) => {
    const env = loadEnv({ only: ["SHIP24_API_KEY", "EVENTS_DIR"] });

    assert.deepEqual(Object.keys(env).sort(), ["EVENTS_DIR", "SHIP24_API_KEY"]);
    for (const key of ["BUYER_PRIVATE_KEY", "SELLER_PRIVATE_KEY", "META_TX_RELAYER_API_KEY", "ANTHROPIC_API_KEY"]) {
      assert.equal(env[key], undefined, `${key} crossed the only boundary`);
    }
    assert.equal(env.SHIP24_API_KEY, "apik_test");
  });
});

test("only drops the same keys when they arrive from the environment", async () => {
  // The deployed case: on a real host the secrets are exported, not in a file,
  // and filtering the file alone would let every one of them through.
  await withEnvFile("", (loadEnv) =>
    withProcessEnv(
      { BUYER_PRIVATE_KEY: "0xdeadbeef", ANTHROPIC_API_KEY: "sk-ant-test", EVENTS_DIR: "/data/events" },
      () => {
        const env = loadEnv({ only: ["EVENTS_DIR"] });

        assert.deepEqual(Object.keys(env), ["EVENTS_DIR"]);
        assert.equal(env.BUYER_PRIVATE_KEY, undefined, "a wallet key crossed the only boundary");
        assert.equal(env.ANTHROPIC_API_KEY, undefined, "a provider key crossed the only boundary");
      },
    ),
  );
});

test("with no only, nothing is filtered", async () => {
  await withEnvFile(SECRETS, (loadEnv) => {
    const env = loadEnv();
    assert.equal(env.BUYER_PRIVATE_KEY?.endsWith("deadbeef"), true);
  });
});

test("a real environment value wins over the file", async () => {
  await withEnvFile("EVENTS_DIR=fixtures/events\n", (loadEnv) =>
    withProcessEnv({ EVENTS_DIR: "/data/events" }, () => {
      assert.equal(loadEnv({ only: ["EVENTS_DIR"] }).EVENTS_DIR, "/data/events");
    }),
  );
});

test("an empty value means unset, in the file and in the environment", async () => {
  // .env.example ships with blank secrets, and a blank one must never read as
  // configured — nor may an exported blank erase a value the file did set.
  await withEnvFile("SHIP24_API_KEY=\nEVENTS_DIR=fixtures/events\n", (loadEnv) =>
    withProcessEnv({ EVENTS_DIR: "" }, () => {
      const env = loadEnv({ only: ["SHIP24_API_KEY", "EVENTS_DIR"] });

      assert.equal(env.SHIP24_API_KEY, undefined);
      assert.equal(env.EVENTS_DIR, "fixtures/events");
    }),
  );
});

test("required is checked after only, so a key not on the list is missing", async () => {
  await withEnvFile(SECRETS, (loadEnv) => {
    assert.throws(
      () => loadEnv({ required: ["ANTHROPIC_API_KEY"], only: ["SHIP24_API_KEY"] }),
      /missing required environment: ANTHROPIC_API_KEY/,
    );
    assert.doesNotThrow(() => loadEnv({ required: ["SHIP24_API_KEY"], only: ["SHIP24_API_KEY"] }));
  });
});

test("export prefixes, matched quotes and CRLF lines are read", async () => {
  const contents =
    'export SHIP24_API_KEY="apik_quoted"\r\n' + "MEDIATOR_MODEL='claude-opus-5'\n" + 'PUBLIC_BASE_URL=https://held.example/"\n';

  await withEnvFile(contents, (loadEnv) => {
    const env = loadEnv({ only: ["SHIP24_API_KEY", "MEDIATOR_MODEL", "PUBLIC_BASE_URL"] });

    assert.equal(env.SHIP24_API_KEY, "apik_quoted");
    assert.equal(env.MEDIATOR_MODEL, "claude-opus-5");
    // Unmatched: stripping quotes independently would mangle this one.
    assert.equal(env.PUBLIC_BASE_URL, 'https://held.example/"');
  });
});

test("a missing .env is fine unless the caller requires the file", async () => {
  await withEnvFile(null, (loadEnv) => {
    assert.deepEqual(loadEnv({ only: ["SHIP24_API_KEY"] }), {});
    assert.throws(() => loadEnv({ requireFile: true, only: ["SHIP24_API_KEY"] }), /Copy \.env\.example/);
  });
});
