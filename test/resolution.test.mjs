import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, NotBuiltError } from "../src/resolution.mjs";

test("settling is not implemented, and says so rather than appearing to work", async () => {
  await assert.rejects(() => settle({ exchangeId: "241", buyerPercent: 20 }), NotBuiltError);
});

test("the error names what is missing, so a caller can render something true", async () => {
  await assert.rejects(() => settle({ exchangeId: "241", buyerPercent: 20 }), /resolveDispute/);
});
