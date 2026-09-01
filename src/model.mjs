// src/model.mjs
// The only module in this repository that talks to the model provider.
//
// ⭐ There is no `tools` field anywhere in this file, and that is the point.
// The rule that no model-driven component may hold a tool that can move funds
// is not a discipline someone has to maintain — it is the absence of a
// parameter, in one place, where adding it would be a visible change.

export const MEDIATOR_MODEL_DEFAULT = "claude-opus-5";

// One type for every way a call can come back unusable, so the mediator can
// retry it on the same footing as a response that failed its bounds. A raw
// SyntaxError escaping instead would fail the case on the first attempt, and
// a truncated response is the likeliest malformation of the two.
export class UnusableModelResponse extends Error {
  constructor(detail) {
    super(`the mediator returned an unusable result: ${detail}`);
    this.name = "UnusableModelResponse";
  }
}

// The schema is the action space. There is no field for a remedy that is not a
// percentage, so a wider remedy is unrepresentable rather than rejected.
export const FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "findings"],
    properties: {
      status: { type: "string", enum: ["needs_evidence", "proposal", "cannot_settle"] },
      buyerPercent: { type: "number", minimum: 0, maximum: 100 },
      reasoning: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["statement", "evidenceIds"],
          properties: {
            statement: { type: "string" },
            evidenceIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      provisional: {
        type: "object",
        additionalProperties: false,
        required: ["buyerPercent", "reasoning"],
        properties: {
          buyerPercent: { type: "number", minimum: 0, maximum: 100 },
          reasoning: { type: "string" },
        },
      },
      requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["what", "whyItMatters", "whoCanProvide", "wouldChange"],
          properties: {
            what: { type: "string" },
            whyItMatters: { type: "string" },
            whoCanProvide: { type: "string", enum: ["buyer", "seller"] },
            wouldChange: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["answer", "implies", "split"],
                properties: {
                  answer: { type: "string" },
                  implies: { type: "string" },
                  split: { type: "number", minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
    },
  },
};

// The one place the model name is decided. Exported because the recording has
// to state which model produced a proposal, and the answer cannot travel back
// on the result itself: checkProposal's field allowlist refuses any key outside
// the schema, so a result carrying `model` is rejected as an unknown field.
//
// ⚠️ MEDIATOR_MODEL arrives as an argument, never off process.env. loadEnv
// reads .env without mutating the environment, so a process.env read here would
// never see the configured value and would bypass loadEnv's `only` allowlist —
// which exists so a component that cannot move funds does not hold the means
// to. The composition root supplies it.
export function resolveModel(model = null) {
  return model ?? MEDIATOR_MODEL_DEFAULT;
}

export function buildRequest({ bundle, system, photos = [], final = false, model = null }) {
  const content = [
    { type: "text", text: JSON.stringify({ exchangeId: bundle.exchangeId, items: bundle.items }, null, 2) },
  ];

  // Each photograph is announced by its evidence id immediately before its
  // bytes, so a finding that cites pho-2 is citing something the model can tell
  // apart from pho-1. Without this the images are an unlabelled pile.
  for (const photo of photos) {
    content.push({ type: "text", text: `Evidence item ${photo.id}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: photo.media_type, data: photo.base64 },
    });
  }

  if (final) {
    content.push({
      type: "text",
      text: "This is the final round. Return a proposal or cannot_settle; needs_evidence is not available.",
    });
  }

  return {
    model: resolveModel(model),
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: { format: FORMAT },
    messages: [{ role: "user", content }],
  };
}

// Returns the model alongside the parsed answer rather than merged into it,
// for the reason above: the answer is schema-bound and has no room for it.
export async function callModel({ client, bundle, system, photos = [], final = false, model = null }) {
  const request = buildRequest({ bundle, system, photos, final, model });
  const response = await client.messages.create(request);

  // ⚠️ stop_reason before content, because both of these arrive as HTTP 200
  // and neither says anything useful once it has reached JSON.parse. Adaptive
  // thinking shares the token budget with several base64 photographs, so a
  // truncation here is an ordinary outcome rather than an edge case; a refusal
  // may carry no text block at all. stop_details is populated only on a
  // refusal, so it is read only there.
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "no category given";
    throw new UnusableModelResponse(`the model declined the case (${category})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new UnusableModelResponse("the response was truncated at max_tokens");
  }

  // ⚠️ Text blocks only. Adaptive thinking puts thinking blocks in the same
  // array, and concatenating everything would hand JSON.parse the reasoning.
  const text = (response.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text) throw new UnusableModelResponse("the response carried no text block");

  try {
    return { model: request.model, result: JSON.parse(text) };
  } catch (err) {
    throw new UnusableModelResponse(`the response was not valid JSON: ${err.message}`);
  }
}
