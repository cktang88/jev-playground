import { providers } from "./providers/index.mjs";

// The model catalog: every provider's curated rows, merged with live discovery
// where a provider supports it. Cached so the UI can poll it cheaply.

const TTL_MS = 10 * 60_000;

function merge(curated, live) {
  const liveById = new Map(live.map((row) => [row.id, row]));
  const ordered = curated.map((row) => {
    const fresh = liveById.get(row.id);
    liveById.delete(row.id);
    // Curated facts (types, notes, labels) win; live facts (pricing, context) refresh them.
    return fresh
      ? { ...row, context_length: fresh.context_length ?? row.context_length, pricing: { ...row.pricing, ...dropUndefined(fresh.pricing) }, source: "live" }
      : row;
  });
  const rest = [...liveById.values()].sort((a, b) => a.label.localeCompare(b.label));
  return [...ordered, ...rest];
}

function dropUndefined(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function createCatalog(config, { fetchImpl = fetch } = {}) {
  let cache = null;

  async function load({ refresh = false } = {}) {
    if (cache && !refresh && Date.now() - cache.at < TTL_MS) return cache;
    const models = [];
    const warnings = [];
    for (const provider of Object.values(providers)) {
      let rows = provider.curated();
      if (provider.discover && config[provider.id]?.discover !== false) {
        try {
          rows = merge(rows, await provider.discover(config, fetchImpl));
        } catch (failure) {
          warnings.push(`${provider.label} model discovery failed (${failure.message}); showing curated models only.`);
        }
      }
      models.push(...rows);
    }
    cache = { at: Date.now(), models, warnings };
    return cache;
  }

  async function find(providerId, modelId) {
    const { models } = await load();
    return models.find((row) => row.provider === providerId && row.model === modelId) || null;
  }

  return { load, find };
}
