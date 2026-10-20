import { upstreamError } from "./shared.mjs";

// Cloudflare Workers AI REST: POST {base}/accounts/{account}/ai/run/{model}
// Responses are wrapped: { result, success, errors: [{ code, message }], messages }.
// Clef / Clef-flash take the System One decision schema (state + questions);
// Clairic takes the extraction schema (state + fields).

const DECIDE_TYPES = ["noul", "choice", "score"];
const EXTRACT_TYPES = ["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"];

// Clef's documented question-id rule: letters, digits, '_', '.', '-' (max 100 chars).
const CLEF_ID = "^[A-Za-z0-9_.-]{1,100}$";

const MODELS = [
  {
    model: "@cf/cloudflare/clairic",
    alias: "clairic",
    label: "Cloudflare: Clairic",
    task: "extract",
    types: EXTRACT_TYPES,
    vision: true,
    context_length: 65536,
    pricing: { input_per_mtok: 0.1 },
    limits: { max_images: 4 },
    notes: "System One extraction model (preview). Text answers are spans of the state.",
  },
  {
    model: "@cf/cloudflare/clef",
    alias: "clef",
    label: "Cloudflare: Clef",
    task: "decide",
    types: DECIDE_TYPES,
    vision: true,
    context_length: 65536,
    pricing: { input_per_mtok: 0.24 },
    limits: { max_items: 64, max_images: 4, choice_options: [2, 255], score_levels: [2, 10], id_pattern: CLEF_ID },
    notes: "Open-weights 27B decision model.",
  },
  {
    model: "@cf/cloudflare/clef-flash",
    alias: "clef-flash",
    label: "Cloudflare: Clef Flash",
    task: "decide",
    types: DECIDE_TYPES,
    vision: true,
    context_length: 24576,
    pricing: { input_per_mtok: 0.038 },
    limits: { max_items: 64, max_images: 4, choice_options: [2, 255], score_levels: [2, 10], id_pattern: CLEF_ID },
    notes: "Fast 9B decision model.",
  },
];

const HINTS = {
  400: "Workers AI rejected the input; compare it with the model's schema in docs/CLOUDFLARE_NOTES.md.",
  401: "Set CLOUDFLARE_API_TOKEN to a token with Workers AI permissions.",
  403: "The token lacks Workers AI permission for this account, or CLOUDFLARE_ACCOUNT_ID is wrong.",
  404: "Workers AI does not know this model id. Check the @cf/... spelling.",
};

function describe(row, source) {
  return {
    id: `cloudflare:${row.model}`,
    provider: "cloudflare",
    model: row.model,
    alias: row.alias,
    label: row.label || row.model,
    task: row.task,
    types: row.types,
    vision: Boolean(row.vision),
    context_length: row.context_length,
    pricing: row.pricing || {},
    limits: row.limits || {},
    notes: row.notes,
    source,
  };
}

function firstError(json) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  return errors.map((error) => error?.message).find(Boolean) || json?.error?.message || json?.error;
}

export default {
  id: "cloudflare",
  label: "Cloudflare Workers AI",
  tasks: ["decide", "extract"],
  docs: "https://developers.cloudflare.com/workers-ai/models/clairic/",

  status(config) {
    const missing = [];
    if (!config.cloudflare.accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
    if (!config.cloudflare.apiToken) missing.push("CLOUDFLARE_API_TOKEN");
    return {
      configured: missing.length === 0,
      missing,
      hint: missing.length ? `Set ${missing.join(" and ")} (dash.cloudflare.com → AI → Workers AI → Use REST API).` : undefined,
    };
  },

  curated() {
    return MODELS.map((row) => describe(row, "curated"));
  },

  // A custom @cf/... id is assumed to speak the schema of the task it was picked for.
  describeCustom(model, task) {
    const alias = model.split("/").pop();
    return describe(
      { model, alias, label: model, task, types: task === "extract" ? EXTRACT_TYPES : DECIDE_TYPES, notes: "Custom model id — not in the catalog." },
      "custom",
    );
  },

  buildRequest({ task, descriptor, input, config }) {
    const body = { model: descriptor.alias, state: input.state };
    if (task.id === "extract") {
      body.fields = input.items;
      if (input.options.reference_date) body.reference_date = input.options.reference_date;
      const options = {};
      if (input.options.include_quantiles) options.include_quantiles = true;
      if (input.options.return_state_text) options.return_state_text = true;
      if (Object.keys(options).length) body.options = options;
    } else {
      body.questions = input.items;
    }
    if (input.images.length) body.images = input.images.map((image) => image.dataUrl);
    return {
      url: `${config.cloudflare.baseUrl}/accounts/${encodeURIComponent(config.cloudflare.accountId || "<account-id>")}/ai/run/${descriptor.model}`,
      headers: { Authorization: `Bearer ${config.cloudflare.apiToken}`, "Content-Type": "application/json" },
      body,
    };
  },

  parseResponse({ status, json }) {
    if (status < 200 || status >= 300 || json?.success === false) {
      throw upstreamError(status >= 400 ? status : 502, firstError(json), HINTS);
    }
    const result = json?.result ?? json;
    if (!result || typeof result !== "object" || !result.answers) {
      throw upstreamError(502, "Workers AI returned a response without answers.");
    }
    const { answers, usage = {}, model, ...rest } = result;
    return {
      model,
      answers,
      usage: { ...usage, input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
      meta: rest,
    };
  },
};
