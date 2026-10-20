import { newReference, perMillion, upstreamError } from "./shared.mjs";

// OpenRouter's alpha Decisions router: one endpoint, many System One decision
// models (TypeSafe Jev, OpenAI Luna, Cloudflare Clef, Perplexity, ...).
// Request:  POST {base}/api/alpha/decisions  { model, state, questions, assets?, session_id?, provider? }
// Response: { model, provider?, id?, answers, usage: { input_tokens, output_tokens, cost? } }

const DECIDE_BASIC = ["noul", "choice", "score"];
const DECIDE_ALL = [...DECIDE_BASIC, "box"];

// Hand-curated rows: shown even when live discovery is off or fails, and used to
// enrich live rows with facts the models API does not expose (supported types, notes).
const CURATED = [
  {
    model: "typesafe/jev-1.14",
    label: "TypeSafe: Jev 1.14",
    types: DECIDE_ALL,
    vision: true,
    context_length: 262144,
    pricing: { input_per_mtok: 0.042 },
    notes: "Latest Jev. The only model documented to answer Box questions.",
  },
  {
    model: "typesafe/jev-1.13",
    label: "TypeSafe: Jev 1.13",
    types: DECIDE_BASIC,
    vision: true,
    context_length: 262144,
    pricing: { input_per_mtok: 0.042 },
  },
  {
    model: "~typesafe/jev-latest",
    label: "TypeSafe: Jev Latest (alias)",
    types: DECIDE_ALL,
    vision: true,
    pricing: { input_per_mtok: 0.042 },
    notes: "Router alias. Its endpoint list has been empty before; prefer a pinned version if it 404s.",
  },
  {
    model: "openai/gpt-6-luna-decisions",
    label: "OpenAI: GPT-6 Luna Decisions",
    types: DECIDE_BASIC,
    vision: true,
    context_length: 1050000,
    pricing: { input_per_mtok: 0.1 },
  },
  {
    model: "cloudflare/clef",
    label: "Cloudflare: Clef (via OpenRouter)",
    types: DECIDE_BASIC,
    vision: true,
    context_length: 65537,
    pricing: { input_per_mtok: 0.24 },
  },
  {
    model: "cloudflare/clef-flash",
    label: "Cloudflare: Clef Flash (via OpenRouter)",
    types: DECIDE_BASIC,
    vision: true,
    context_length: 24576,
    pricing: { input_per_mtok: 0.038 },
  },
  {
    model: "perplexity/pplx-decider-v1.2",
    label: "Perplexity: Decider v1.2",
    types: DECIDE_BASIC,
    vision: true,
    context_length: 262144,
    pricing: { input_per_mtok: 0.02 },
  },
];

const HINTS = {
  401: "Set OPENROUTER_API_KEY in the server environment.",
  402: "OpenRouter credits are exhausted; top up the account.",
  403: "The API key lacks permission for this model.",
  404: "OpenRouter does not know this model id, or it has no live endpoint. Pick a pinned model from the catalog.",
};

function describe(row, source) {
  return {
    id: `openrouter:${row.model}`,
    provider: "openrouter",
    model: row.model,
    label: row.label || row.model,
    task: "decide",
    types: row.types || DECIDE_BASIC,
    vision: Boolean(row.vision),
    context_length: row.context_length,
    pricing: row.pricing || {},
    limits: row.limits || {},
    notes: row.notes,
    source,
  };
}

// Images use TypeSafe's `assets` format: each image gets a unique reference string
// and that reference is placed in the state where the image belongs.
function attachImages(state, images) {
  if (images.length === 0) return { state, assets: undefined };
  const assets = {};
  const refs = images.map((image) => {
    const ref = newReference();
    assets[ref] = { type: "image", format: image.mime === "image/png" ? "png" : "jpg", data_base64: image.base64 };
    return ref;
  });
  if (Array.isArray(state)) return { state: [...state, ...refs], assets };
  const base = typeof state === "string" ? { text: state } : { ...state };
  refs.forEach((ref, index) => {
    let key = `image_${index + 1}`;
    while (key in base) key = `_${key}`;
    base[key] = ref;
  });
  return { state: base, assets };
}

export default {
  id: "openrouter",
  label: "OpenRouter",
  tasks: ["decide"],
  docs: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request",

  status(config) {
    const configured = Boolean(config.openrouter.apiKey);
    return {
      configured,
      missing: configured ? [] : ["OPENROUTER_API_KEY"],
      hint: configured ? undefined : "Get a key at https://openrouter.ai/settings/keys and set OPENROUTER_API_KEY.",
    };
  },

  curated() {
    return CURATED.map((row) => describe(row, "curated"));
  },

  // The models API is public, so discovery works without a key.
  async discover(config, fetchImpl = fetch) {
    const response = await fetchImpl(`${config.openrouter.baseUrl}/api/v1/models?output_modalities=decisions`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`models API returned ${response.status}`);
    const payload = await response.json();
    const curated = new Map(CURATED.map((row) => [row.model, row]));
    return (payload.data || []).map((entry) => {
      const known = curated.get(entry.id) || {};
      return describe(
        {
          ...known,
          model: entry.id,
          label: known.label || entry.name,
          vision: (entry.architecture?.input_modalities || []).includes("image"),
          context_length: entry.context_length || known.context_length,
          pricing: { input_per_mtok: perMillion(entry.pricing?.prompt) ?? known.pricing?.input_per_mtok },
        },
        "live",
      );
    });
  },

  describeCustom(model) {
    return describe({ model, label: model, types: DECIDE_ALL, notes: "Custom model id — not in the catalog." }, "custom");
  },

  validate(input) {
    if (input.images.some((image) => image.mime === "image/webp")) {
      return { message: "OpenRouter decisions accept PNG and JPEG images only.", hint: "Convert WebP images to PNG or JPEG." };
    }
    return null;
  },

  buildRequest({ descriptor, input, config }) {
    const { state, assets } = attachImages(input.state, input.images);
    const body = { model: descriptor.model, state, questions: input.items };
    if (assets) body.assets = assets;
    if (typeof input.options.session_id === "string") body.session_id = input.options.session_id;
    if (input.options.provider && typeof input.options.provider === "object") body.provider = input.options.provider;
    const headers = {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.openrouter.referer,
      "X-Title": config.openrouter.title,
    };
    const usesBox = Object.values(input.items).some((item) => item.type === "box");
    if (assets || usesBox) headers["TypeSafe-Danger-Zone-Images"] = "true";
    return { url: `${config.openrouter.baseUrl}/api/alpha/decisions`, headers, body };
  },

  parseResponse({ status, json }) {
    if (status < 200 || status >= 300) {
      throw upstreamError(status, json?.error?.message || json?.message, HINTS);
    }
    if (!json || typeof json !== "object" || !json.answers) {
      throw upstreamError(502, "OpenRouter returned a response without answers.");
    }
    return {
      model: json.model,
      answers: json.answers,
      usage: {
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: json.usage?.output_tokens ?? 0,
        cost: json.usage?.cost,
      },
      meta: { id: json.id, served_by: json.provider },
    };
  },
};
