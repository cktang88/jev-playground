import { formatNumber, formatPercent, formatValue, guidanceText, h, svg } from "./dom.mjs";

// One renderer per answer type. Each takes (answer, ctx) where ctx carries the
// API item that asked for it, the images sent, and the state text spans index into.
// Unknown types fall back to a JSON view, so a new type still shows up.

// ---- shared pieces ------------------------------------------------------------

function bar(name, probability, { winner = false, desc } = {}) {
  const fill = h("div", { class: `bar-fill${winner ? " is-winner" : ""}` });
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(0, Math.min(1, probability || 0)) * 100}%`; }));
  return h("div", { class: "bar-row" },
    h("div", { class: "bar-label" }, h("span", null, h("span", { class: "name", text: name }), desc ? h("span", { class: "opt-desc", text: ` — ${desc}` }) : null), h("span", { class: "pct", text: formatPercent(probability) })),
    h("div", { class: "bar-track" }, fill),
  );
}

function confidenceNote(confidence) {
  if (typeof confidence !== "number") return null;
  const advice = confidence >= 0.8 ? "safe to automate in most flows" : confidence >= 0.5 ? "consider a second check" : "route to a human";
  return h("p", { class: "conf-note" }, h("strong", { text: `Confidence ${formatPercent(confidence)}` }), ` — how sure the model is, separate from the probability: ${advice}.`);
}

function kv(pairs) {
  return h("dl", { class: "kv" }, pairs.filter(([, value]) => value !== undefined && value !== null).flatMap(([key, value]) => [h("dt", { text: key }), h("dd", { text: value })]));
}

// Shows the state around one or more [start, end) spans with the spans highlighted.
function snippet(text, spans) {
  if (!text || !spans?.length) return null;
  const valid = spans.filter((span) => Array.isArray(span) && span[0] >= 0 && span[1] <= text.length && span[0] < span[1]).sort((a, b) => a[0] - b[0]);
  if (!valid.length) return null;
  const from = Math.max(0, valid[0][0] - 60);
  const to = Math.min(text.length, valid[valid.length - 1][1] + 60);
  const parts = [from > 0 ? "…" : ""];
  let cursor = from;
  for (const [start, end] of valid) {
    if (start < cursor) continue;
    parts.push(text.slice(cursor, start), h("mark", { text: text.slice(start, end) }));
    cursor = end;
  }
  parts.push(text.slice(cursor, to), to < text.length ? "…" : "");
  return h("div", { class: "snippet", title: "Where the answer was found in the state" }, parts);
}

function unitSuffix(item) {
  return item?.unit ? ` ${item.unit}` : "";
}

// ---- decide -------------------------------------------------------------------

function noulVerdict(p) {
  if (p >= 0.85) return "Very likely yes";
  if (p >= 0.6) return "Leaning yes";
  if (p > 0.4) return "Too close to call";
  if (p > 0.15) return "Leaning no";
  return "Very likely no";
}

function renderNoul(answer, { item }) {
  const p = answer.noul;
  return h("div", null,
    h("div", { class: "big-number", text: formatPercent(p) }),
    h("p", { class: "verdict", text: `${noulVerdict(p)} — probability the answer is yes.` }),
    bar("yes", p, { winner: p >= 0.5, desc: guidanceText(item?.criteria?.true) || undefined }),
    h("p", { class: "conf-note", text: "Noul answers carry no separate confidence: distance from 50% is the certainty." }),
  );
}

function renderChoice(answer, { item }) {
  const descriptions = item?.criteria || {};
  // Probabilities are optional on some providers: show the winner alone rather than inventing 100%.
  const rows = answer.probabilities ? Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]) : [];
  return h("div", null,
    h("div", { class: "winner" }, h("div", { class: "k", text: "Choice" }), h("div", { class: "v", text: answer.choice })),
    rows.length
      ? rows.map(([name, p]) => bar(name, p, { winner: name === answer.choice, desc: guidanceText(descriptions[name]) || undefined }))
      : h("p", { class: "small", text: "This model returned no per-option probabilities." }),
    confidenceNote(answer.confidence),
  );
}

function renderScore(answer, { item }) {
  const legend = answer.legend || Object.fromEntries((item?.criteria || []).map((label, index) => [String(index), label]));
  const levels = Object.keys(answer.probabilities || legend).sort((a, b) => Number(a) - Number(b));
  const max = Math.max(levels.length - 1, 1);
  const nearest = String(Math.round(answer.score));
  return h("div", null,
    h("div", { class: "big-number" }, formatNumber(answer.score, 2), h("span", { class: "small", text: ` / ${max}` })),
    h("p", { class: "verdict", text: `Closest level: ${guidanceText(legend[nearest]) || nearest}` }),
    levels.map((level) => bar(`${level} · ${guidanceText(legend[level])}`, answer.probabilities?.[level], { winner: level === nearest })),
    confidenceNote(answer.confidence),
  );
}

function renderBox(answer, { images }) {
  const box = answer.box || {};
  const image = images?.[0];
  const view = image
    ? h("div", { class: "box-view" },
      h("img", { src: image, alt: "First image sent, with the answer's box drawn on it" }),
      h("div", { class: "rect", style: { left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${(box.right - box.left) * 100}%`, height: `${(box.bottom - box.top) * 100}%` } }))
    : null;
  return h("div", null,
    view,
    kv([["left", formatNumber(box.left)], ["top", formatNumber(box.top)], ["right", formatNumber(box.right)], ["bottom", formatNumber(box.bottom)]]),
    h("p", { class: "small", text: "Edges are fractions of the image width/height from the top-left. A box is always returned — pair it with a noul asking whether the target is there." }),
    confidenceNote(answer.confidence),
  );
}

// ---- extract --------------------------------------------------------------------

function renderScalar(answer, { item, stateText }) {
  const isNull = answer.value === null || answer.value === undefined;
  return h("div", null,
    h("div", { class: `value-big${isNull ? " value-null" : ""}`, text: isNull ? "null" : `${formatValue(answer.value)}${unitSuffix(item)}` }),
    isNull && answer.guess !== undefined && answer.guess !== null
      ? h("p", { class: "verdict", text: `Not in the input. Its best guess would have been: ${formatValue(answer.guess)}` })
      : null,
    typeof answer.p_null === "number" ? bar("p(null) — the value is not in the input", answer.p_null) : null,
    snippet(stateText, answer.span ? [answer.span] : null),
    kv([["span", answer.span ? `[${answer.span.join(", ")}]` : undefined]]),
    confidenceNote(answer.confidence),
  );
}

function renderList(answer, { item, stateText }) {
  const values = Array.isArray(answer.value) ? answer.value : [];
  return h("div", null,
    values.length
      ? h("div", { class: "chips" }, values.map((value) => h("span", { class: "chip", text: `${formatValue(value)}${unitSuffix(item)}` })))
      : h("p", { class: "value-null", text: "Empty list — nothing matched." }),
    snippet(stateText, answer.spans),
    confidenceNote(answer.confidence),
  );
}

const toDays = (value) => (typeof value === "string" ? Date.parse(`${value.slice(0, 10)}T00:00:00Z`) / 86_400_000 : value);

function scaler(item, values) {
  const nums = values.map(toDays).filter(Number.isFinite);
  let lo = Number.isFinite(toDays(item?.min)) ? toDays(item.min) : Math.min(...nums);
  let hi = Number.isFinite(toDays(item?.max)) ? toDays(item.max) : Math.max(...nums);
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const log = item?.scale === "log" && lo > 0;
  return (value) => {
    const x = toDays(value);
    const unit = log ? Math.log(x / lo) / Math.log(hi / lo) : (x - lo) / (hi - lo);
    return Math.max(0, Math.min(1, unit));
  };
}

function renderEstimate(answer, { item }) {
  const median = answer.median ?? answer.value;
  const at = scaler(item, [answer.p10, answer.p90, median]);
  const pos = (value) => `${at(value) * 100}%`;
  return h("div", null,
    h("div", { class: "value-big", text: `${formatValue(median)}${unitSuffix(item)}` }),
    h("p", { class: "verdict", text: `80% interval: ${formatValue(answer.p10)} – ${formatValue(answer.p90)}` }),
    h("div", { class: "interval", title: `p10–p90 band within [${formatValue(item?.min)}, ${formatValue(item?.max)}]${item?.scale === "log" ? " (log scale)" : ""}` },
      h("div", { class: "track" }),
      h("div", { class: "band", style: { left: pos(answer.p10), width: `${Math.max(0.5, (at(answer.p90) - at(answer.p10)) * 100)}%` } }),
      h("div", { class: "tick", style: { left: pos(median) } }),
    ),
    h("div", { class: "interval-labels" }, h("span", { text: formatValue(item?.min) }), h("span", { text: item?.scale === "log" ? "log scale" : "" }), h("span", { text: formatValue(item?.max) })),
    kv([
      ["value", formatValue(answer.value)],
      ["mean", answer.mean !== undefined ? formatValue(answer.mean) : undefined],
      ["p10 / p90", `${formatValue(answer.p10)} / ${formatValue(answer.p90)}`],
      ["p(below min)", answer.p_below !== undefined ? formatPercent(answer.p_below) : undefined],
      ["p(above max)", answer.p_above !== undefined ? formatPercent(answer.p_above) : undefined],
      ["quantiles", Array.isArray(answer.quantiles) ? `${answer.quantiles.length} returned` : undefined],
    ]),
  );
}

// Forecasts arrive either as parallel arrays (value/median/p10/p90) or as `steps`.
function forecastSeries(answer) {
  if (Array.isArray(answer.steps)) {
    return {
      median: answer.steps.map((step) => step.median ?? step.value),
      p10: answer.steps.map((step) => step.p10),
      p90: answer.steps.map((step) => step.p90),
    };
  }
  const median = answer.median || answer.value || [];
  return { median, p10: answer.p10 || median, p90: answer.p90 || median };
}

function renderForecast(answer, { item }) {
  const { median, p10, p90 } = forecastSeries(answer);
  if (!median.length) return h("pre", { text: JSON.stringify(answer, null, 2) });
  const width = 420;
  const height = 150;
  const pad = { left: 8, right: 8, top: 10, bottom: 18 };
  const lo = Math.min(...p10.map(toDays));
  const hi = Math.max(...p90.map(toDays));
  const y = (value) => {
    const unit = hi > lo ? (toDays(value) - lo) / (hi - lo) : 0.5;
    return pad.top + (1 - unit) * (height - pad.top - pad.bottom);
  };
  const x = (index) => pad.left + (median.length === 1 ? 0.5 : index / (median.length - 1)) * (width - pad.left - pad.right);
  const band = [...p90.map((value, index) => `${x(index)},${y(value)}`), ...p10.map((value, index) => `${x(index)},${y(value)}`).reverse()].join(" ");
  const chart = svg("svg", { class: "fan", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Forecast median with 80% interval band" },
    svg("line", { class: "axis", x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }),
    median.length > 1 ? svg("polygon", { class: "band", points: band }) : svg("line", { class: "line", x1: x(0), x2: x(0), y1: y(p10[0]), y2: y(p90[0]) }),
    median.length > 1 ? svg("polyline", { class: "line", points: median.map((value, index) => `${x(index)},${y(value)}`).join(" ") }) : null,
    median.map((value, index) => svg("circle", { class: "dot", cx: x(index), cy: y(value), r: 3 })),
    svg("text", { x: pad.left, y: height - 4, text: "step 1" }),
    median.length > 1 ? svg("text", { x: width - pad.right, y: height - 4, "text-anchor": "end", text: `step ${median.length}` }) : null,
  );
  return h("div", null,
    h("div", { class: "value-big", text: `${formatValue(median[0])}${unitSuffix(item)}` }),
    h("p", { class: "verdict", text: `Next ${item?.interval || "step"}: 80% interval ${formatValue(p10[0])} – ${formatValue(p90[0])}` }),
    chart,
    h("table", { class: "runs", style: { marginTop: "10px", boxShadow: "none" } },
      h("thead", null, h("tr", null, h("th", { text: "Step" }), h("th", { text: "Median" }), h("th", { text: "p10 – p90" }))),
      h("tbody", null, median.map((value, index) => h("tr", null, h("td", { text: index + 1 }), h("td", { class: "num", text: formatValue(value) }), h("td", { class: "num", text: `${formatValue(p10[index])} – ${formatValue(p90[index])}` })))),
    ),
  );
}

function renderUnknown(answer) {
  return h("pre", { text: JSON.stringify(answer, null, 2) });
}

const RENDERERS = {
  noul: renderNoul,
  choice: renderChoice,
  score: renderScore,
  box: renderBox,
  text: renderScalar,
  number: renderScalar,
  date: renderScalar,
  time: renderScalar,
  datetime: renderScalar,
  duration: renderScalar,
  list: renderList,
  estimate: renderEstimate,
  forecast: renderForecast,
};

export function renderAnswer(answer, ctx) {
  if (!answer || typeof answer !== "object") return h("p", { class: "empty", text: "No answer returned for this item." });
  try {
    return (RENDERERS[answer.type] || renderUnknown)(answer, ctx);
  } catch {
    return renderUnknown(answer);
  }
}

// A short comparable value per answer, used to show agreement across models.
export function headline(answer) {
  if (!answer) return null;
  switch (answer.type) {
    case "noul": return typeof answer.noul === "number" ? (answer.noul >= 0.5 ? "yes" : "no") : null;
    case "choice": return answer.choice ?? null;
    case "score": return typeof answer.score === "number" ? `level ${Math.round(answer.score)}` : null;
    case "list": return Array.isArray(answer.value) ? answer.value.map(formatValue).join(", ") || "(empty)" : null;
    case "estimate": return formatValue(answer.median ?? answer.value);
    case "forecast": return null;
    case "box": return null;
    default: return answer.value === undefined ? null : formatValue(answer.value);
  }
}
