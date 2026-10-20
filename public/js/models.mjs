import { clear, h } from "./dom.mjs";

// The model picker: catalog rows for the current task, grouped by provider, with
// a filter and multi-select. Selecting several models turns a run into a comparison.

function priceTag(model) {
  const price = model.pricing?.input_per_mtok;
  if (typeof price !== "number") return null;
  return h("span", { class: "tag", title: "Input price per million tokens", text: price === 0 ? "free" : `$${price}/M in` });
}

function contextTag(model) {
  if (!model.context_length) return null;
  const k = model.context_length >= 1_000_000 ? `${(model.context_length / 1_000_000).toFixed(1)}M` : `${Math.round(model.context_length / 1024)}k`;
  return h("span", { class: "tag", title: "Context window", text: `${k} ctx` });
}

function matches(model, query) {
  if (!query) return true;
  const haystack = `${model.label} ${model.model} ${model.provider} ${model.notes || ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

export function renderModelPicker(container, { models, providers, task, selected, query, mock, onToggle, onRemoveCustom }) {
  clear(container);
  const visible = models.filter((model) => model.task === task && matches(model, query));
  const byProvider = new Map();
  for (const model of visible) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    byProvider.get(model.provider).push(model);
  }
  if (visible.length === 0) {
    container.append(h("p", { class: "empty", text: query ? "No models match that filter." : "No models for this task yet." }));
    return;
  }
  for (const [providerId, rows] of byProvider) {
    const provider = providers.find((entry) => entry.id === providerId) || { label: providerId, configured: false, missing: [] };
    const state = mock
      ? h("span", { class: "tag warn", text: "mock" })
      : provider.configured
        ? h("span", { class: "tag good", text: "key set" })
        : h("span", { class: "tag warn", title: provider.hint || "", text: `needs ${provider.missing.join(" + ")}` });
    const group = h("div", { class: "model-group" }, h("h3", null, provider.label, state, h("span", { class: "state", text: `${rows.length} model${rows.length === 1 ? "" : "s"}` })));
    for (const model of rows) {
      const isSelected = selected.has(model.id);
      const extraTypes = model.types.filter((type) => !["noul", "choice", "score"].includes(type) && task === "decide");
      group.append(
        h("label", { class: `model-row${isSelected ? " is-selected" : ""}` },
          h("input", { type: "checkbox", checked: isSelected, onchange: (event) => {
            // Update in place (no re-render) so keyboard focus stays on this checkbox.
            event.target.closest(".model-row").classList.toggle("is-selected", event.target.checked);
            onToggle(model.id);
          } }),
          h("div", null,
            h("div", { class: "name", text: model.label }),
            h("div", { class: "mid", text: model.model }),
            model.notes ? h("div", { class: "note", text: model.notes }) : null,
          ),
          h("div", { class: "tags" },
            model.vision ? h("span", { class: "tag", text: "vision" }) : null,
            extraTypes.length ? h("span", { class: "tag", text: `+${extraTypes.join(", ")}` }) : null,
            contextTag(model),
            priceTag(model),
            model.source === "custom"
              ? h("button", { type: "button", class: "tiny danger", text: "×", title: "Remove custom model", onclick: (event) => { event.preventDefault(); onRemoveCustom(model.id); } })
              : h("span", { class: "tag", title: model.source === "live" ? "Listed by the provider's models API just now" : "Curated in this repo", text: model.source }),
          ),
        ),
      );
    }
    container.append(group);
  }
}

export function customDescriptor({ provider, model, task, types }) {
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    label: model,
    task,
    types,
    vision: true,
    pricing: {},
    limits: {},
    notes: "Custom model id",
    source: "custom",
  };
}
