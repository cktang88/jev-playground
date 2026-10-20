import { clear, guidanceText, h, uid } from "./dom.mjs";

// Question / field editors, generated from the type specs the server publishes in
// /api/catalog. A decide type declares `criteria: { kind }`; an extract type
// declares `params: [{ key, kind, ... }]`. Supporting a new type means adding its
// spec on the server — nothing here needs to change.

// ---- conversions between the editor shape and the API shape ----------------

function emptyCriteria(spec) {
  switch (spec?.criteria?.kind) {
    case "pair": return { true: "", false: "" };
    case "map": return [{ key: "", value: "" }, { key: "", value: "" }];
    case "list": return ["", ""];
    default: return null;
  }
}

function criteriaFromApi(spec, criteria) {
  if (criteria === undefined || criteria === null) return emptyCriteria(spec);
  switch (spec?.criteria?.kind) {
    case "pair": return { true: guidanceText(criteria.true), false: guidanceText(criteria.false) };
    case "map": return Object.entries(criteria).map(([key, value]) => ({ key, value: guidanceText(value) }));
    case "list": return criteria.map(guidanceText);
    default: return null;
  }
}

export function makeItem(taskSpec, source) {
  const spec = taskSpec.types[source.type];
  return {
    uid: uid(),
    id: source.id,
    type: source.type,
    instructions: guidanceText(source.instructions),
    criteria: criteriaFromApi(spec, source.criteria),
    params: { ...(source.params || {}) },
  };
}

export function nextId(items, type) {
  const taken = new Set(items.map((item) => item.id));
  let index = 1;
  while (taken.has(`${type}_${index}`)) index += 1;
  return `${type}_${index}`;
}

function parseParam(param, raw) {
  if (param.kind === "bool") return raw ? true : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const text = String(raw).trim();
  switch (param.kind) {
    case "int":
    case "number": {
      const value = Number(text);
      return Number.isFinite(value) ? value : { error: `${param.label} must be a number.` };
    }
    case "number_or_date":
      return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : Number.isFinite(Number(text)) ? Number(text) : { error: `${param.label} must be a number or YYYY-MM-DD.` };
    case "step":
      return text === "month" || text === "year" ? text : Number.isFinite(Number(text)) ? Number(text) : { error: `${param.label} must be a number, month, or year.` };
    default:
      return text;
  }
}

// Returns { items: <API map>, errors: [string] }.
export function toApiItems(items, taskSpec) {
  const out = {};
  const errors = [];
  const seen = new Set();
  items.forEach((item, index) => {
    const label = `#${index + 1} (${item.id || "no id"})`;
    const id = item.id.trim();
    if (!id) errors.push(`${label}: give it an id.`);
    else if (seen.has(id)) errors.push(`${label}: id "${id}" is used twice.`);
    seen.add(id);
    const spec = taskSpec.types[item.type];
    const api = { type: item.type };
    if (item.instructions.trim()) api.instructions = item.instructions.trim();
    if (spec.criteria) {
      if (!api.instructions) errors.push(`${label}: add instructions.`);
      const kind = spec.criteria.kind;
      if (kind === "pair") {
        const t = item.criteria.true.trim();
        const f = item.criteria.false.trim();
        if (t && f) api.criteria = { true: t, false: f };
        else if (t || f) errors.push(`${label}: fill both "yes" and "no" descriptions, or neither.`);
      } else if (kind === "map") {
        const rows = item.criteria.filter((row) => row.key.trim());
        if (rows.length < (spec.criteria.min || 0)) errors.push(`${label}: needs at least ${spec.criteria.min} options.`);
        api.criteria = Object.fromEntries(rows.map((row) => [row.key.trim(), row.value.trim() || null]));
      } else if (kind === "list") {
        const levels = item.criteria.map((level) => level.trim()).filter(Boolean);
        if (levels.length < (spec.criteria.min || 0)) errors.push(`${label}: needs at least ${spec.criteria.min} levels.`);
        api.criteria = levels;
      }
    }
    for (const param of spec.params || []) {
      const value = parseParam(param, item.params[param.key]);
      if (value && typeof value === "object" && value.error) errors.push(`${label}: ${value.error}`);
      else if (value !== undefined) api[param.key] = value;
      else if (param.required) errors.push(`${label}: ${param.label} is required.`);
    }
    if (id) out[id] = api;
  });
  return { items: out, errors };
}

// ---- rendering --------------------------------------------------------------

function field(labelText, control, extra) {
  return h("label", { class: "field" }, h("span", { class: "lbl" }, labelText, extra), control);
}

function textInput(value, placeholder, onInput) {
  return h("input", { type: "text", value: value ?? "", placeholder: placeholder || "", oninput: (event) => onInput(event.target.value) });
}

function criteriaEditor(item, spec, changed) {
  const kind = spec.criteria?.kind;
  if (!kind || kind === "none") return null;
  const box = h("fieldset", { class: "criteria" }, h("legend", { text: "Criteria" }));
  if (kind === "pair") {
    box.append(
      h("p", { class: "criteria-note", text: "Optional. Describe what a yes and a no look like." }),
      field(spec.criteria.labels[0], textInput(item.criteria.true, "Describes broken behavior.", (value) => { item.criteria.true = value; changed(); })),
      field(spec.criteria.labels[1], textInput(item.criteria.false, "Asking a how-to question.", (value) => { item.criteria.false = value; changed(); })),
    );
  } else if (kind === "map") {
    box.append(h("p", { class: "criteria-note", text: `At least ${spec.criteria.min} options. The key is what comes back as the answer.` }));
    item.criteria.forEach((row, index) => {
      box.append(
        h("div", { class: "opt-row" },
          textInput(row.key, "option_key", (value) => { row.key = value; changed(); }),
          textInput(row.value, spec.criteria.valueLabel, (value) => { row.value = value; changed(); }),
          h("button", { type: "button", class: "tiny danger", "aria-label": "Remove option", text: "×", onclick: () => { item.criteria.splice(index, 1); changed(true); } }),
        ),
      );
    });
    box.append(h("button", { type: "button", class: "tiny", text: "+ Option", onclick: () => { item.criteria.push({ key: "", value: "" }); changed(true); } }));
  } else if (kind === "list") {
    box.append(h("p", { class: "criteria-note", text: "Ordered, lowest first. Levels are indexed from 0." }));
    item.criteria.forEach((level, index) => {
      box.append(
        h("div", { class: "opt-row", style: { gridTemplateColumns: "auto 1fr auto" } },
          h("span", { class: "pill", text: index }),
          textInput(level, `Level ${index}`, (value) => { item.criteria[index] = value; changed(); }),
          h("button", { type: "button", class: "tiny danger", "aria-label": "Remove level", text: "×", onclick: () => { item.criteria.splice(index, 1); changed(true); } }),
        ),
      );
    });
    box.append(h("button", { type: "button", class: "tiny", text: "+ Level", onclick: () => { item.criteria.push(""); changed(true); } }));
  }
  return box;
}

function paramControl(item, param, changed) {
  const value = item.params[param.key];
  const set = (next) => { item.params[param.key] = next; changed(); };
  if (param.kind === "bool") {
    return h("label", { class: "bool" }, h("input", { type: "checkbox", checked: Boolean(value), onchange: (event) => set(event.target.checked) }), param.label);
  }
  let control;
  if (param.kind === "enum") {
    control = h("select", { onchange: (event) => set(event.target.value) },
      param.required ? null : h("option", { value: "", text: "(default)" }),
      param.options.map((option) => h("option", { value: option, text: option, selected: option === value })),
    );
    if (param.required && !value) item.params[param.key] = param.options[0];
  } else {
    const hint = param.placeholder || (param.kind === "number_or_date" ? "number or YYYY-MM-DD" : param.min !== undefined ? `${param.min}–${param.max ?? "…"}` : "");
    control = textInput(value, hint, set);
    if (param.kind === "int" || param.kind === "number") control.inputMode = "decimal";
  }
  const label = field(param.label, control, param.required ? h("span", { class: "req", text: " *" }) : null);
  if (param.help) label.title = param.help;
  return label;
}

function paramsEditor(item, spec, changed) {
  if (!spec.params?.length) return null;
  return h("fieldset", { class: "criteria" }, h("legend", { text: "Parameters" }), h("div", { class: "param-grid" }, spec.params.map((param) => paramControl(item, param, changed))));
}

function itemCard(item, index, taskSpec, onChange, onRemove) {
  const spec = taskSpec.types[item.type];
  const changed = (structural = false) => onChange(structural);
  const typeSelect = h("select", {
    "aria-label": "Type",
    onchange: (event) => {
      item.type = event.target.value;
      item.criteria = emptyCriteria(taskSpec.types[item.type]);
      item.params = {};
      changed(true);
    },
  }, Object.entries(taskSpec.types).map(([key, type]) => h("option", { value: key, text: `${key} — ${type.label}${type.experimental ? " (experimental)" : ""}`, selected: key === item.type })));

  const editor = spec.criteria ? criteriaEditor(item, spec, changed) : paramsEditor(item, spec, changed);
  return h("div", { class: "qcard", "data-uid": item.uid },
    h("div", { class: "qcard-head" },
      h("span", { class: "qnum", text: `${taskSpec.itemNoun} ${index + 1}` }),
      h("button", { type: "button", class: "tiny danger", text: "Remove", onclick: onRemove }),
    ),
    h("div", { class: "qcard-basic" },
      h("div", { class: "grid-2" },
        field("Id", textInput(item.id, "my_id", (value) => { item.id = value; changed(); })),
        field("Type", typeSelect),
      ),
      h("p", { class: "type-help", text: spec.summary + (spec.needsImage ? " Needs an image." : "") }),
      field(spec.criteria ? "Instructions" : "Instructions (optional)",
        h("textarea", { rows: 2, style: { minHeight: "64px" }, value: item.instructions, placeholder: spec.criteria ? "Ask one clear question." : "What the field should contain.", oninput: (event) => { item.instructions = event.target.value; changed(); } })),
    ),
    editor,
  );
}

export function renderItems(container, items, taskSpec, onChange) {
  clear(container);
  container.id = "question-list";
  items.forEach((item, index) => {
    container.append(itemCard(item, index, taskSpec, onChange, () => {
      items.splice(index, 1);
      onChange(true);
    }));
  });
  if (items.length === 0) container.append(h("p", { class: "empty", text: `No ${taskSpec.itemNoun}s yet — add one below.` }));
}

export function renderAddButtons(container, taskSpec, onAdd) {
  clear(container);
  container.append(h("span", { class: "lbl", style: { margin: 0 }, text: `Add a ${taskSpec.itemNoun}:` }));
  for (const [key, type] of Object.entries(taskSpec.types)) {
    container.append(h("button", { type: "button", class: "tiny", title: type.summary, text: `+ ${type.label}`, onclick: () => onAdd(key) }));
  }
}

export function blankItem(taskSpec, type, items) {
  return makeItem(taskSpec, { id: nextId(items, type), type });
}
