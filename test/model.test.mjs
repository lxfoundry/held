import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, callModel, FORMAT, MEDIATOR_MODEL_DEFAULT, UnusableModelResponse } from "../src/model.mjs";

const bundle = { exchangeId: "241", hash: "abc", items: [{ id: "pho-1", kind: "photo", provenance: "buyer", visibility: "shared", authored: false, content: { path: "p.jpg", sha256: "aa" } }] };

test("the request carries no tools field at all", () => {
  const req = buildRequest({ bundle, system: "s", photos: [] });
  assert.equal("tools" in req, false);
});

test("the request pins the model and uses structured output", () => {
  const req = buildRequest({ bundle, system: "s", photos: [] });
  assert.equal(req.model, MEDIATOR_MODEL_DEFAULT);
  assert.ok(req.output_config?.format, "output_config.format missing");
  assert.equal("output_format" in req, false, "the deprecated parameter was used");
});

// ⚠️ Found by the first live calls, which the whole schema had never faced. The
// structured-output validator accepts a schema's *structure* — types, enums,
// required, additionalProperties — and rejects its *value constraints* with a
// 400: minimum/maximum on a number, minItems above 1 on an array. Both were in
// here, and both meant every request died before the model saw a single case.
//
// ⭐ So the rule is one rule rather than a list of keywords learned one 400 at a
// time: the schema says what shape an answer has, and checkProposal says what
// values are allowed. A constraint written here is not stricter, it is absent —
// twice over, because the request never lands.
test("the schema carries structure only, never a value constraint", () => {
  const CONSTRAINTS = [
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern",
    "minProperties", "maxProperties",
  ];
  const offenders = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (CONSTRAINTS.includes(key)) offenders.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(FORMAT.schema, "schema");
  assert.deepEqual(offenders, [], "the API returns 400 for these and no case is ever mediated");
});

test("thinking is adaptive", () => {
  assert.deepEqual(buildRequest({ bundle, system: "s", photos: [] }).thinking, { type: "adaptive" });
});

test("photographs are attached as image blocks, base64 only at this layer", () => {
  const req = buildRequest({
    bundle, system: "s",
    photos: [{ id: "pho-1", media_type: "image/jpeg", base64: "QUJD" }],
  });
  const blocks = req.messages[0].content;
  const image = blocks.find((b) => b.type === "image");
  assert.equal(image.source.data, "QUJD");
  assert.ok(blocks.some((b) => b.type === "text" && b.text.includes("pho-1")),
    "the image is not tied to its evidence id");
});

test("a final round says so in the request", () => {
  const req = buildRequest({ bundle, system: "s", photos: [], final: true });
  const text = req.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  assert.match(text, /final round/i);
});

test("callModel parses the structured output and reports the model beside it", async () => {
  const client = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: '{"status":"proposal","buyerPercent":20}' }] }),
    },
  };
  const { model, result } = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(result.buyerPercent, 20);
  // The recording states which model produced a proposal, and this is the only
  // layer that knows. It cannot ride on `result`: checkProposal would reject it.
  assert.equal(model, MEDIATOR_MODEL_DEFAULT);
});

// Adaptive thinking means the response carries thinking blocks alongside the
// text. Concatenating every block would hand JSON.parse the reasoning too.
test("thinking blocks in the response are not parsed as output", async () => {
  const client = {
    messages: {
      create: async () => ({ content: [
        { type: "thinking", thinking: "weighing the carton evidence" },
        { type: "text", text: '{"status":"proposal","buyerPercent":20}' },
      ] }),
    },
  };
  const { result } = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(result.buyerPercent, 20);
});

const responding = (response) => ({ messages: { create: async () => response } });
const ok = '{"status":"proposal","buyerPercent":20}';

// ⚠️ stop_reason is read before the content. Adaptive thinking shares the token
// budget with several base64 photographs, so a truncated response is a real
// outcome here — and it arrives as HTTP 200 with JSON cut off mid-object.
test("a response truncated at max_tokens is refused, not parsed", async () => {
  const client = responding({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"status":"pro' }] });
  await assert.rejects(
    callModel({ client, bundle, system: "s", photos: [] }),
    (err) => err instanceof UnusableModelResponse && /truncated/.test(err.message),
  );
});

// A safety refusal is HTTP 200 with a stop_reason and possibly no text block at
// all, so JSON.parse("") would be the first thing to notice it.
test("a refusal is reported as a refusal", async () => {
  const client = responding({
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber" },
    content: [],
  });
  await assert.rejects(
    callModel({ client, bundle, system: "s", photos: [] }),
    (err) => err instanceof UnusableModelResponse && /declined/.test(err.message),
  );
});

test("output that is not JSON is refused as an unusable response", async () => {
  const client = responding({ stop_reason: "end_turn", content: [{ type: "text", text: "I think 20%." }] });
  await assert.rejects(
    callModel({ client, bundle, system: "s", photos: [] }),
    (err) => err instanceof UnusableModelResponse && !(err instanceof SyntaxError),
  );
});

test("a response with no text block at all is refused", async () => {
  const client = responding({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }] });
  await assert.rejects(
    callModel({ client, bundle, system: "s", photos: [] }),
    UnusableModelResponse,
  );
});

test("an ordinary completion still parses", async () => {
  const client = responding({ stop_reason: "end_turn", content: [{ type: "text", text: ok }] });
  const { result } = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(result.buyerPercent, 20);
});

// The recording exists to state which model produced a proposal, and the
// authoritative answer is the one the API says it served — not the one the
// request asked for.
test("the model reported is the one the response says served it", async () => {
  const client = responding({ stop_reason: "end_turn", model: "claude-opus-5-served", content: [{ type: "text", text: ok }] });
  const { model } = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(model, "claude-opus-5-served");
});

test("a response that names no model falls back to the one requested", async () => {
  const client = responding({ stop_reason: "end_turn", content: [{ type: "text", text: ok }] });
  const { model } = await callModel({ client, bundle, system: "s", photos: [] });
  assert.equal(model, MEDIATOR_MODEL_DEFAULT);
});
