import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTrackings } from "../src/receiver.mjs";

// The push envelope is not confirmed against a real delivery yet, so every
// plausible shape is accepted rather than risking the first one being dropped.
test("accepts the nested envelope the fetch endpoint returns", () => {
  assert.equal(extractTrackings({ data: { trackings: [{ tracker: {} }] } }).length, 1);
});

test("accepts a flat trackings array", () => {
  assert.equal(extractTrackings({ trackings: [{ tracker: {} }, { tracker: {} }] }).length, 2);
});

test("accepts a single tracking object", () => {
  assert.equal(extractTrackings({ tracker: { trackerId: "x" }, events: [] }).length, 1);
});

test("treats anything else as empty rather than throwing", () => {
  assert.deepEqual(extractTrackings(null), []);
  assert.deepEqual(extractTrackings({}), []);
  assert.deepEqual(extractTrackings("ping"), []);
});
