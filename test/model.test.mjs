import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, callModel, MEDIATOR_MODEL_DEFAULT, UnusableModelResponse } from "../src/model.mjs";

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
