// src/model.mjs
// The only module in this repository that talks to the model provider.
//
// ⭐ There is no `tools` field anywhere in this file, and that is the point.
// The rule that no model-driven component may hold a tool that can move funds
// is not a discipline someone has to maintain — it is the absence of a
// parameter, in one place, where adding it would be a visible change.

export const MEDIATOR_MODEL_DEFAULT = "claude-opus-5";

// The schema is the action space. There is no field for a remedy that is not a
// percentage, so a wider remedy is unrepresentable rather than rejected.
const FORMAT = {
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
    model: model ?? process.env.MEDIATOR_MODEL ?? MEDIATOR_MODEL_DEFAULT,
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: { format: FORMAT },
    messages: [{ role: "user", content }],
  };
}

export async function callModel({ client, bundle, system, photos = [], final = false, model = null }) {
  const response = await client.messages.create(buildRequest({ bundle, system, photos, final, model }));
  // ⚠️ Text blocks only. Adaptive thinking puts thinking blocks in the same
  // array, and concatenating everything would hand JSON.parse the reasoning.
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}
