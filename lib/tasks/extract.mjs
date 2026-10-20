import { badRequest } from "../errors.mjs";
import { isPlainObject, parseImages, randomUnit, round, validateItemMap, validateState } from "./shared.mjs";

// The "extract" task: state + typed fields -> typed values with confidence,
// null probabilities, spans, and calibrated intervals. Modelled on Cloudflare's
// Clairic (System One extraction), but nothing here is Clairic-specific.

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];
const INTERVALS = ["step", "minute", "hour", "day", "week", "month", "quarter", "year"];
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar date in YYYY-MM-DD form (rejects 2026-13-45, 2026-02-30, ...).
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const nullThreshold = { key: "null_threshold", label: "Null threshold", kind: "number", min: 0, max: 1, placeholder: "0.5", help: "p_null above this returns null." };
const decimals = { key: "decimals", label: "Decimals", kind: "int", min: 0, max: 6 };
const scale = { key: "scale", label: "Scale", kind: "enum", options: ["linear", "log"] };

// Each type lists its parameters so the UI can build an editor without knowing the type.
export const types = {
  text: { label: "Text", summary: "A verbatim span of the input, with character offsets.", params: [nullThreshold] },
  number: {
    label: "Number",
    summary: "A number read from or computed from the input.",
    params: [{ key: "unit", label: "Unit", kind: "text", placeholder: "USD" }, decimals, { key: "integer", label: "Integer", kind: "bool" }, nullThreshold],
  },
  date: { label: "Date", summary: "An ISO date (YYYY-MM-DD), read or computed.", params: [nullThreshold] },
  time: { label: "Time", summary: "An ISO time of day.", params: [nullThreshold] },
  datetime: { label: "Datetime", summary: "An ISO date and time.", params: [nullThreshold] },
  duration: {
    label: "Duration",
    summary: "A length of time in the unit you choose.",
    params: [{ key: "unit", label: "Unit", kind: "enum", options: DURATION_UNITS }, { key: "integer", label: "Integer", kind: "bool" }, decimals, nullThreshold],
  },
  list: {
    label: "List",
    summary: "Every matching item, in input order, with spans.",
    params: [{ key: "items", label: "Items", kind: "enum", options: ["text", "number", "date"], required: true }, decimals],
  },
  estimate: {
    label: "Estimate",
    summary: "A distribution inside [min, max]: median, mean, and an 80% interval.",
    params: [
      { key: "min", label: "Min", kind: "number_or_date", required: true },
      { key: "max", label: "Max", kind: "number_or_date", required: true },
      { key: "step", label: "Step", kind: "step", placeholder: "1, month, year" },
      scale,
      { key: "unit", label: "Unit", kind: "text" },
    ],
  },
  forecast: {
    label: "Forecast",
    summary: "One estimate per future step of a series in the state.",
    params: [
      { key: "horizon", label: "Horizon", kind: "int", min: 1, max: 64, required: true },
      { key: "interval", label: "Interval", kind: "enum", options: INTERVALS },
      { key: "min", label: "Min", kind: "number", required: true },
      { key: "max", label: "Max", kind: "number", required: true },
      scale,
      { key: "unit", label: "Unit", kind: "text" },
    ],
  },
};


function checkParam(id, param, value) {
  const where = `Field "${id}" ${param.key}`;
  switch (param.kind) {
    case "text":
      return typeof value === "string" ? null : `${where} must be a string.`;
    case "bool":
      return typeof value === "boolean" ? null : `${where} must be true or false.`;
    case "enum":
      return param.options.includes(value) ? null : `${where} must be one of ${param.options.join(", ")}.`;
    case "int":
      if (!Number.isInteger(value)) return `${where} must be an integer.`;
      if (param.min !== undefined && value < param.min) return `${where} must be at least ${param.min}.`;
      if (param.max !== undefined && value > param.max) return `${where} must be at most ${param.max}.`;
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${where} must be a number.`;
      if (param.key === "null_threshold" && (value <= 0 || value > 1)) return `${where} must be in (0, 1].`;
      return null;
    case "number_or_date":
      return (typeof value === "number" && Number.isFinite(value)) || isIsoDate(value)
        ? null
        : `${where} must be a number or an ISO date.`;
    case "step":
      return (typeof value === "number" && Number.isFinite(value) && value > 0) || value === "month" || value === "year"
        ? null
        : `${where} must be a positive number, "month", or "year".`;
    default:
      return null;
  }
}

function validateField(id, field) {
  if (!FIELD_NAME.test(id)) {
    return `Field name "${id}" must start with a letter or _, and use only letters, digits, _ . - (max 64).`;
  }
  const spec = Object.hasOwn(types, field.type) ? types[field.type] : null;
  if (!spec) return `Field "${id}" has invalid type ${JSON.stringify(field.type)}; expected ${Object.keys(types).join(", ")}.`;
  if (field.instructions !== undefined && typeof field.instructions !== "string") return `Field "${id}" instructions must be a string.`;
  const allowed = new Set(["type", "instructions", ...spec.params.map((param) => param.key)]);
  for (const key of Object.keys(field)) {
    if (!allowed.has(key)) return `Field "${id}" (${field.type}) does not take a "${key}" parameter.`;
  }
  for (const param of spec.params) {
    const value = field[param.key];
    if (value === undefined || value === null || value === "") {
      if (param.required) return `Field "${id}" (${field.type}) requires \`${param.key}\`.`;
      continue;
    }
    const problem = checkParam(id, param, value);
    if (problem) return problem;
  }
  if (field.type === "estimate" || field.type === "forecast") {
    const bothDates = typeof field.min === "string" && typeof field.max === "string";
    const bothNumbers = typeof field.min === "number" && typeof field.max === "number";
    if (!bothDates && !bothNumbers) return `Field "${id}" min and max must both be numbers or both be ISO dates.`;
    // ISO dates compare correctly as strings.
    if (field.min >= field.max) return `Field "${id}" min must be less than max.`;
    if (field.scale === "log" && bothNumbers && field.min <= 0) return `Field "${id}" uses a log scale, so min must be above 0.`;
  }
  return null;
}

// Extraction models read text, so structured state is serialized for them.
export function stateToText(state) {
  if (state === undefined || state === null) return "";
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

export function validate(body) {
  const images = parseImages(body.images);
  validateState(body.state, { allowEmpty: images.length > 0 });
  const ids = validateItemMap(body.fields, { key: "fields", noun: "field", maxIdLength: 64 });
  for (const id of ids) {
    const problem = validateField(id, body.fields[id]);
    if (problem) throw badRequest(problem, "See docs/CONTRACT.md for the parameters each field type takes.");
  }
  const options = isPlainObject(body.options) ? body.options : {};
  if (options.reference_date !== undefined && !isIsoDate(options.reference_date)) {
    throw badRequest("`options.reference_date` must be an ISO date.", "Example: 2026-10-20");
  }
  return { state: stateToText(body.state), items: body.fields, images, options };
}

// ---- mock answers ----------------------------------------------------------
// The mock reads the real state so spans point at real text and the demo makes sense.

function findAll(pattern, text) {
  return [...text.matchAll(pattern)].map((match) => ({ text: match[0], span: [match.index, match.index + match[0].length] }));
}

function pick(list) {
  return list[Math.floor(randomUnit() * list.length)];
}

function scalar(type, value, guess, extra = {}) {
  const pNull = value === null ? round(0.6 + randomUnit() * 0.4, 4) : round(randomUnit() * 0.02, 6);
  return { type, p_null: pNull, ...extra, guess, confidence: round(0.7 + randomUnit() * 0.3, 4), value };
}

function finish(value, field) {
  if (field.integer) return Math.round(value);
  return round(value, field.decimals ?? 2);
}

function addDays(iso, days) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.round(days));
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
}

// Draws a plausible distribution inside [min, max] and returns it on that scale.
function distribution(field) {
  const isDate = typeof field.min === "string";
  const lo = isDate ? 0 : field.min;
  const hi = isDate ? daysBetween(field.min, field.max) : field.max;
  const log = field.scale === "log" && !isDate;
  const toUnit = (value) => (log ? Math.log(value / lo) / Math.log(hi / lo) : (value - lo) / (hi - lo));
  const fromUnit = (unit) => (log ? lo * Math.pow(hi / lo, unit) : lo + unit * (hi - lo));
  const center = 0.25 + randomUnit() * 0.5;
  const width = 0.05 + randomUnit() * 0.12;
  const numericStep = typeof field.step === "number" ? field.step : 0;
  // Snap to the step grid counted from min, then clamp, so mock values stay in [min, max].
  const snap = (raw) => {
    if (!numericStep) return raw;
    return Math.min(hi, Math.max(lo, lo + Math.round((raw - lo) / numericStep) * numericStep));
  };
  const at = (unit) => {
    const raw = snap(fromUnit(Math.max(0, Math.min(1, unit))));
    if (!isDate) return round(raw, numericStep ? 6 : 3);
    const date = addDays(field.min, raw);
    if (field.step !== "month" && field.step !== "year") return date;
    const aligned = field.step === "year" ? `${date.slice(0, 4)}-01-01` : `${date.slice(0, 7)}-01`;
    return aligned < field.min ? field.min : aligned > field.max ? field.max : aligned;
  };
  return { at, center, width, toUnit };
}

function mockEstimate(field, options) {
  const { at, center, width } = distribution(field);
  const answer = {
    type: "estimate",
    value: at(center),
    mean: typeof field.min === "string" ? at(center) : at(center + width * 0.05),
    median: at(center),
    p10: at(center - width * 1.28),
    p90: at(center + width * 1.28),
    p_below: round(randomUnit() * 0.01, 6),
    p_above: round(randomUnit() * 0.01, 6),
  };
  if (options.include_quantiles) {
    answer.quantiles = Array.from({ length: 99 }, (_, index) => at(center + width * 2.6 * ((index + 1) / 100 - 0.5)));
  }
  return answer;
}

function mockForecast(field) {
  const { at, center, width } = distribution(field);
  const value = [];
  const p10 = [];
  const p90 = [];
  let drift = center;
  for (let step = 0; step < field.horizon; step += 1) {
    drift = Math.max(0.05, Math.min(0.95, drift + (randomUnit() - 0.5) * 0.06));
    const spread = width * (1 + step * 0.08);
    value.push(at(drift));
    p10.push(at(drift - spread * 1.28));
    p90.push(at(drift + spread * 1.28));
  }
  return { type: "forecast", value, median: [...value], p10, p90 };
}

function mockField(field, text, options) {
  const words = findAll(/\b[A-Z][A-Za-z0-9-]{2,}(?:\s[A-Z][A-Za-z0-9-]+)?/g, text);
  // Prefer currency amounts so mock numbers look like the values people ask for.
  const money = findAll(/(?<=\$)\d[\d,]*(?:\.\d+)?/g, text);
  const numbers = money.length ? money : findAll(/\d[\d,]*(?:\.\d+)?/g, text);
  const dates = findAll(/\b\d{4}-\d{2}-\d{2}\b/g, text);
  const missing = randomUnit() < 0.12;
  switch (field.type) {
    case "text": {
      const hit = words.length ? pick(words) : { text: text.slice(0, 12), span: [0, Math.min(12, text.length)] };
      return scalar("text", missing ? null : hit.text, hit.text, { span: hit.span });
    }
    case "number": {
      const hit = numbers.length ? Number(pick(numbers).text.replace(/,/g, "")) : randomUnit() * 1000;
      const value = finish(hit, field);
      return scalar("number", missing ? null : value, value);
    }
    case "date": {
      const value = dates.length ? pick(dates).text : options.reference_date || new Date().toISOString().slice(0, 10);
      return scalar("date", missing ? null : value, value);
    }
    case "time": {
      const value = `${String(8 + Math.floor(randomUnit() * 10)).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}:00`;
      return scalar("time", missing ? null : value, value);
    }
    case "datetime": {
      const day = dates.length ? pick(dates).text : new Date().toISOString().slice(0, 10);
      const value = `${day}T${String(8 + Math.floor(randomUnit() * 10)).padStart(2, "0")}:00:00`;
      return scalar("datetime", missing ? null : value, value);
    }
    case "duration": {
      const value = finish(1 + randomUnit() * 60, field);
      return scalar("duration", missing ? null : value, value);
    }
    case "list": {
      const pool = field.items === "number" ? numbers : field.items === "date" ? dates : words;
      const chosen = pool.slice(0, Math.min(pool.length, 1 + Math.floor(randomUnit() * 3)));
      const value = chosen.map((hit) => (field.items === "number" ? finish(Number(hit.text.replace(/,/g, "")), field) : hit.text));
      return { type: "list", value, spans: chosen.map((hit) => hit.span), confidence: round(0.7 + randomUnit() * 0.3, 4) };
    }
    case "estimate":
      return mockEstimate(field, options);
    case "forecast":
      return mockForecast(field);
    default:
      return { type: field.type, value: null };
  }
}

export function mockAnswers(input) {
  const answers = {};
  for (const [id, field] of Object.entries(input.items)) answers[id] = mockField(field, input.state || "", input.options);
  return answers;
}

export function mockMeta(input) {
  const meta = { truncated: false };
  if (input.options.return_state_text) meta.state_text = input.state;
  return meta;
}

export default {
  id: "extract",
  label: "Extract",
  summary: "Typed fields in, typed values out — with spans, null probabilities, and intervals.",
  itemsKey: "fields",
  itemNoun: "field",
  types,
  options: [
    { key: "reference_date", label: "Reference date", kind: "date", help: "Anchors dates written without a year." },
    { key: "include_quantiles", label: "Include 99 quantiles", kind: "bool", help: "Adds every percentile to estimates." },
    { key: "return_state_text", label: "Return state text", kind: "bool", help: "Echo the text that spans index into." },
  ],
  validate,
  mockAnswers,
  mockMeta,
};
