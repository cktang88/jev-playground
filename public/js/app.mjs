import * as api from "./api.mjs";
import { $, clear, h } from "./dom.mjs";
import { blankItem, makeItem, renderAddButtons, renderItems, reviveItem, toApiItems } from "./editors.mjs";
import { customDescriptor, renderModelPicker } from "./models.mjs";
import { DECIDE_DEFAULT_ITEMS, DECIDE_PRESETS, EXTRACT_PRESETS } from "./presets.mjs";
import { renderRaw, renderResults } from "./results.mjs";
import * as store from "./store.mjs";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|webp)$/;
const PRESETS = { decide: DECIDE_PRESETS, extract: EXTRACT_PRESETS };

const state = {
  catalog: null,
  task: "decide",
  selected: { decide: new Set(), extract: new Set() },
  custom: [],
  states: {},
  items: {},
  options: { decide: {}, extract: {} },
  images: [],
  mock: false,
  query: "",
  running: false,
};

const el = {};

function taskSpec(task = state.task) {
  return state.catalog.tasks[task];
}

function allModels() {
  return [...state.catalog.models, ...state.custom];
}

// ---- persistence --------------------------------------------------------------

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.save({
      task: state.task,
      selected: Object.fromEntries(Object.entries(state.selected).map(([task, set]) => [task, [...set]])),
      custom: state.custom,
      states: state.states,
      items: state.items,
      options: state.options,
      mock: state.mock,
    });
  }, 250);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Saved state is untrusted: an older version, a type the server since changed, or a
// hand-edited value. Every piece is checked, and anything unusable falls back to defaults.
function restoreFrom(saved) {
  const tasks = Object.keys(state.catalog.tasks);
  state.task = tasks.includes(saved.task) ? saved.task : "decide";
  state.custom = Array.isArray(saved.custom)
    ? saved.custom.filter((row) => isObject(row) && tasks.includes(row.task) && typeof row.id === "string" && typeof row.model === "string" && Array.isArray(row.types))
    : [];
  for (const task of tasks) {
    const known = new Set(allModels().filter((model) => model.task === task).map((model) => model.id));
    state.options[task] = isObject(saved.options?.[task]) ? saved.options[task] : {};
    const remembered = Array.isArray(saved.selected?.[task]) ? saved.selected[task].filter((id) => known.has(id)) : [];
    state.selected[task] = new Set(remembered.length ? remembered : [state.catalog.defaults[task]].filter(Boolean));
    const spec = taskSpec(task);
    const savedState = saved.states?.[task];
    if (Array.isArray(saved.items?.[task]) && isObject(savedState) && typeof savedState.text === "string") {
      // An empty list is a valid choice (the user removed everything), not a reason to reset.
      state.items[task] = saved.items[task].map((item) => reviveItem(spec, item)).filter(Boolean);
      state.states[task] = { text: savedState.text, json: Boolean(savedState.json) };
    } else {
      applyPreset(task, PRESETS[task][0], { withItems: true });
    }
  }
  state.mock = Boolean(saved.mock);
}

function restore() {
  const saved = store.load();
  try {
    restoreFrom(isObject(saved) ? saved : {});
  } catch (failure) {
    console.warn("Ignoring unreadable saved playground state:", failure);
    store.clear();
    restoreFrom({});
  }
}

function applyPreset(task, preset, { withItems = false } = {}) {
  state.states[task] = { text: preset.state, json: Boolean(preset.json) };
  if (preset.options) state.options[task] = { ...preset.options };
  const source = preset.items || (withItems && task === "decide" ? DECIDE_DEFAULT_ITEMS : null);
  if (source) state.items[task] = source.map((item) => makeItem(taskSpec(task), item));
}

// ---- rendering ----------------------------------------------------------------

function renderBadges() {
  const badges = clear(el.badges);
  if (state.catalog.mock) badges.append(h("span", { class: "badge is-mock" }, h("span", { class: "dot" }), "server mock mode"));
  for (const provider of state.catalog.providers) {
    badges.append(h("span", { class: `badge ${provider.configured ? "is-live" : "is-off"}`, title: provider.hint || `${provider.label} is ready` },
      h("span", { class: "dot" }), `${provider.label}: ${provider.configured ? "ready" : `needs ${provider.missing.join(" + ")}`}`));
  }
  const live = state.catalog.models.filter((model) => model.source === "live").length;
  badges.append(h("span", { class: "badge is-unknown" }, h("span", { class: "dot" }), `${state.catalog.models.length} models${live ? ` (${live} live)` : ""}`));
}

function renderTaskTabs() {
  clear(el.taskTabs);
  for (const spec of Object.values(state.catalog.tasks)) {
    el.taskTabs.append(h("button", { type: "button", "aria-pressed": String(spec.id === state.task), text: spec.label, onclick: () => switchTask(spec.id) }));
  }
  el.taskSummary.textContent = taskSpec().summary;
}

function renderModels() {
  renderModelPicker(el.modelList, {
    models: allModels(),
    providers: state.catalog.providers,
    task: state.task,
    selected: state.selected[state.task],
    query: state.query,
    mock: state.mock || state.catalog.mock,
    onToggle: (id) => {
      const set = state.selected[state.task];
      if (set.has(id)) set.delete(id);
      else set.add(id);
      renderSelectionLine();
      renderRunLabel();
      persist();
    },
    onRemoveCustom: (id) => {
      state.custom = state.custom.filter((model) => model.id !== id);
      state.selected[state.task].delete(id);
      renderModels();
      renderRunLabel();
      persist();
    },
  });
  renderSelectionLine();
}

// Rebuilt only when the task changes, so filtering or ticking models keeps the chosen provider.
function renderCustomProviders() {
  const previous = el.customProvider.value;
  clear(el.customProvider);
  for (const provider of state.catalog.providers.filter((entry) => entry.tasks.includes(state.task))) {
    el.customProvider.append(h("option", { value: provider.id, text: provider.label, selected: provider.id === previous }));
  }
}

function renderSelectionLine() {
  const count = state.selected[state.task].size;
  el.selectionLine.textContent = count === 0
    ? "Select at least one model."
    : count === 1 ? "1 model selected. Select more to compare them side by side." : `${count} models selected — they run in parallel and results line up per ${taskSpec().itemNoun}.`;
}

function renderPresets() {
  clear(el.presets).append(h("span", { class: "lbl", style: { margin: 0 }, text: "Presets:" }));
  for (const preset of PRESETS[state.task]) {
    el.presets.append(h("button", { type: "button", class: "tiny", text: preset.label, onclick: () => {
      applyPreset(state.task, preset);
      renderStateBox();
      renderTaskOptions();
      renderItemSection();
      persist();
    } }));
  }
}

function renderStateBox() {
  const current = state.states[state.task];
  el.stateInput.value = current.text ?? "";
  el.jsonToggle.checked = current.json;
  el.stateError.hidden = true;
}

function renderTaskOptions() {
  clear(el.taskOptions);
  const options = taskSpec().options || [];
  const values = state.options[state.task];
  for (const option of options) {
    if (option.kind === "bool") {
      el.taskOptions.append(h("label", { class: "checkline", style: { marginTop: 0 }, title: option.help },
        h("input", { type: "checkbox", checked: Boolean(values[option.key]), onchange: (event) => { values[option.key] = event.target.checked; persist(); } }),
        h("span", { text: option.label })));
    } else {
      el.taskOptions.append(h("label", { class: "field", title: option.help },
        h("span", { class: "lbl", text: option.label }),
        h("input", { type: option.kind === "date" ? "date" : "text", value: values[option.key] || "", oninput: (event) => { values[option.key] = event.target.value; persist(); } })));
    }
  }
}

function renderItemSection() {
  const spec = taskSpec();
  el.itemsHeading.textContent = `3 · ${spec.itemNoun === "field" ? "Fields" : "Questions"}`;
  const items = state.items[state.task];
  renderItems(el.itemList, items, spec, (structural) => {
    if (structural) renderItemSection();
    persist();
  });
  renderAddButtons(el.addRow, spec, (type) => {
    items.push(blankItem(spec, type, items));
    renderItemSection();
    persist();
  });
  el.itemsError.hidden = true;
}

function renderImages() {
  clear(el.imageList);
  state.images.forEach((image, index) => {
    el.imageList.append(h("div", { class: "thumb" },
      h("img", { src: image.dataUrl, alt: image.name }),
      h("button", { type: "button", class: "tiny", "aria-label": `Remove ${image.name}`, text: "×", onclick: () => { state.images.splice(index, 1); renderImages(); } }),
      h("span", { class: "cap", text: `${index + 1} · ${Math.round(image.bytes / 1024)} KB` }),
    ));
  });
}

function renderRunLabel() {
  const count = state.selected[state.task].size;
  el.runLabel.textContent = state.running ? "Running…" : count > 1 ? `Run on ${count} models` : "Run";
  el.runButton.disabled = state.running || count === 0;
  el.spinner.hidden = !state.running;
}

function renderAll() {
  renderBadges();
  renderTaskTabs();
  el.mockToggle.checked = state.mock || state.catalog.mock;
  el.mockToggle.disabled = state.catalog.mock;
  renderModels();
  renderCustomProviders();
  renderPresets();
  renderStateBox();
  renderTaskOptions();
  renderItemSection();
  renderRunLabel();
  el.warnings.hidden = !state.catalog.warnings?.length;
  el.warnings.textContent = (state.catalog.warnings || []).join(" ");
}

function switchTask(task) {
  state.task = task;
  renderAll();
  persist();
}

// ---- images -----------------------------------------------------------------------

// Limits are checked synchronously against loaded *and* still-loading images, so
// picking many files at once can't slip past them while FileReader runs.
const pendingImages = { count: 0, bytes: 0 };

function addFiles(files) {
  const problems = [];
  for (const file of files) {
    const count = state.images.length + pendingImages.count;
    const bytes = state.images.reduce((sum, image) => sum + image.bytes, 0) + pendingImages.bytes;
    if (!IMAGE_TYPES.test(file.type)) {
      problems.push(`${file.name || "pasted image"} is ${file.type || "an unknown type"}; use PNG, JPEG or WebP.`);
    } else if (count >= MAX_IMAGES) {
      problems.push(`Skipped ${file.name}: at most ${MAX_IMAGES} images.`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      problems.push(`${file.name} is larger than 4 MiB.`);
    } else if (bytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      problems.push(`Skipped ${file.name}: images would exceed 8 MiB in total.`);
    } else {
      pendingImages.count += 1;
      pendingImages.bytes += file.size;
      const reader = new FileReader();
      const settle = () => { pendingImages.count -= 1; pendingImages.bytes -= file.size; };
      reader.onload = () => {
        settle();
        state.images.push({ name: file.name || "pasted image", bytes: file.size, dataUrl: reader.result });
        renderImages();
      };
      reader.onerror = () => {
        settle();
        showError({ error: `Could not read ${file.name}.` });
      };
      reader.readAsDataURL(file);
    }
  }
  if (problems.length) showError({ error: problems.join(" "), hint: "Downscale or remove images to fit: 4 images, 4 MiB each, 8 MiB total." });
}

// ---- running ----------------------------------------------------------------------

function showError(payload) {
  clear(el.errorPanel).append(h("div", { class: "error-box", role: "alert" },
    h("h3", { text: payload.error || "Something went wrong" }),
    payload.hint ? h("p", { text: payload.hint }) : null,
    payload.status ? h("p", { class: "meta", text: `HTTP ${payload.status}` }) : null,
  ));
  el.errorPanel.hidden = false;
}

function readState() {
  const { text, json } = state.states[state.task];
  if (!json) return { value: text };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object") return { error: "JSON state must be an object or array." };
    return { value };
  } catch (failure) {
    return { error: `State is not valid JSON: ${failure.message}` };
  }
}

function labelFor(target) {
  return allModels().find((model) => model.id === target)?.label || target;
}

async function runAll() {
  if (state.running) return;
  el.errorPanel.hidden = true;
  const spec = taskSpec();
  const parsedState = readState();
  el.stateError.hidden = !parsedState.error;
  el.stateError.textContent = parsedState.error || "";
  const { items, errors } = toApiItems(state.items[state.task], spec);
  el.itemsError.hidden = errors.length === 0;
  el.itemsError.textContent = errors.join(" ");
  if (parsedState.error || errors.length) return;
  if (Object.keys(items).length === 0) return showError({ error: `Add at least one ${spec.itemNoun}.` });
  const targets = [...state.selected[state.task]];
  if (!targets.length) return showError({ error: "Select at least one model." });

  const options = Object.fromEntries(Object.entries(state.options[state.task]).filter(([, value]) => value !== "" && value !== false && value !== undefined));
  const body = { task: state.task, state: parsedState.value, [spec.itemsKey]: items };
  if (state.images.length) body.images = state.images.map((image) => image.dataUrl);
  if (Object.keys(options).length) body.options = options;
  if (state.mock) body.mock = true;

  el.requestJson.textContent = JSON.stringify(
    { ...body, images: body.images?.map((image) => `${image.slice(0, 30)}…`), target: targets.length === 1 ? targets[0] : `(one request per model: ${targets.join(", ")})` },
    null,
    2,
  );

  const stateText = typeof parsedState.value === "string" ? parsedState.value : JSON.stringify(parsedState.value, null, 2);
  const results = targets.map((target) => ({ target, label: labelFor(target), pending: true, payload: null }));
  const view = () => {
    renderResults({ tableEl: el.runTable, cardsEl: el.answerCards, results, items, images: body.images, stateText });
    renderRaw(el.rawList, results);
  };
  el.results.hidden = false;
  state.running = true;
  renderRunLabel();
  view();

  await Promise.all(results.map(async (result) => {
    result.payload = await api.run({ ...body, target: result.target });
    result.pending = false;
    view();
  }));
  state.running = false;
  renderRunLabel();
  persist();
}

// ---- boot -------------------------------------------------------------------------

function bind() {
  el.badges = $("#provider-badges");
  el.taskTabs = $("#task-tabs");
  el.taskSummary = $("#task-summary");
  el.modelSearch = $("#model-search");
  el.modelList = $("#model-list");
  el.mockToggle = $("#mock-toggle");
  el.customProvider = $("#custom-provider");
  el.customModel = $("#custom-model");
  el.customAdd = $("#custom-add");
  el.selectionLine = $("#selection-line");
  el.warnings = $("#catalog-warnings");
  el.presets = $("#presets");
  el.stateInput = $("#state-input");
  el.jsonToggle = $("#json-state-toggle");
  el.stateError = $("#state-error");
  el.dropzone = $("#dropzone");
  el.imageInput = $("#image-input");
  el.imageList = $("#image-list");
  el.taskOptions = $("#task-options");
  el.itemsHeading = $("#items-heading");
  el.itemList = $("#question-list");
  el.addRow = $("#add-row");
  el.itemsError = $("#items-error");
  el.runButton = $("#run-button");
  el.runLabel = $("#run-label");
  el.spinner = $("#spinner");
  el.errorPanel = $("#error-panel");
  el.results = $("#results");
  el.runTable = $("#run-table-wrap");
  el.answerCards = $("#answer-cards");
  el.requestJson = $("#request-json");
  el.rawList = $("#raw-list");

  el.modelSearch.addEventListener("input", () => { state.query = el.modelSearch.value; renderModels(); });
  el.mockToggle.addEventListener("change", () => { state.mock = el.mockToggle.checked; renderModels(); persist(); });
  el.customAdd.addEventListener("click", () => {
    const model = el.customModel.value.trim();
    if (!model) return;
    const descriptor = customDescriptor({ provider: el.customProvider.value, model, task: state.task, types: Object.keys(taskSpec().types) });
    // Cloudflare serves both tasks, so the same id can exist once per task.
    if (!allModels().some((row) => row.id === descriptor.id && row.task === state.task)) state.custom.push(descriptor);
    state.selected[state.task].add(descriptor.id);
    el.customModel.value = "";
    renderModels();
    renderRunLabel();
    persist();
  });
  el.stateInput.addEventListener("input", () => { state.states[state.task].text = el.stateInput.value; persist(); });
  el.jsonToggle.addEventListener("change", () => { state.states[state.task].json = el.jsonToggle.checked; persist(); });
  $("#image-pick").addEventListener("click", () => el.imageInput.click());
  el.imageInput.addEventListener("change", () => { addFiles(el.imageInput.files); el.imageInput.value = ""; });
  el.dropzone.addEventListener("dragover", (event) => { event.preventDefault(); el.dropzone.classList.add("is-over"); });
  el.dropzone.addEventListener("dragleave", () => el.dropzone.classList.remove("is-over"));
  el.dropzone.addEventListener("drop", (event) => { event.preventDefault(); el.dropzone.classList.remove("is-over"); addFiles(event.dataTransfer.files); });
  document.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) addFiles(files);
  });
  el.runButton.addEventListener("click", runAll);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runAll();
    }
  });
}

async function boot() {
  bind();
  const catalog = await api.getCatalog();
  if (!catalog.ok) {
    showError(catalog);
    return;
  }
  state.catalog = catalog;
  restore();
  renderAll();
}

boot();
