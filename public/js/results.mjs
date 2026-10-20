import { clear, formatCost, formatMs, guidanceText, h } from "./dom.mjs";
import { headline, renderAnswer } from "./renderers.mjs";

// Results for one run across N models: a per-model summary table, then one card
// per question/field with every model's answer stacked inside it.

const KEY_VARS = { openrouter: "$OPENROUTER_API_KEY", cloudflare: "$CLOUDFLARE_API_TOKEN" };

export function curlFor(payload) {
  const upstream = payload?.upstream;
  if (!upstream) return "";
  const url = upstream.url.replace(/\/accounts\/[^/]+\//, "/accounts/$CLOUDFLARE_ACCOUNT_ID/");
  const lines = [`curl ${url.includes("$") ? `"${url}"` : url} \\`, "  -X POST \\"];
  for (const [key, value] of Object.entries(upstream.headers || {})) {
    const shown = /^authorization$/i.test(key) ? `Bearer ${KEY_VARS[payload.provider] || "$API_KEY"}` : value;
    lines.push(`  -H "${key}: ${shown}" \\`);
  }
  lines.push(`  -d '${JSON.stringify(upstream.body, null, 2).replace(/'/g, "'\\''")}'`);
  return lines.join("\n");
}

function statusCell(result) {
  if (result.pending) return h("td", { class: "status-pending", text: "running…" });
  const payload = result.payload;
  if (payload.ok) return h("td", null, h("span", { class: "status-ok", text: payload.mock ? "ok (mock)" : "ok" }));
  return h("td", null,
    h("span", { class: "status-err", text: `${payload.status || "error"} · ${payload.error}` }),
    payload.hint ? h("div", { class: "small", text: payload.hint }) : null,
  );
}

function runTable(results) {
  return h("table", { class: "runs" },
    h("thead", null, h("tr", null, ["Model", "Status", "Latency", "Input tokens", "Cost", "Served by"].map((label) => h("th", { text: label })))),
    h("tbody", null, results.map((result) => {
      const payload = result.payload || {};
      const usage = payload.usage || {};
      return h("tr", null,
        h("td", null, h("strong", { text: result.label }), h("div", { class: "small", text: result.target })),
        statusCell(result),
        h("td", { class: "num", text: result.pending ? "" : formatMs(payload.latency_ms) }),
        h("td", { class: "num", text: payload.ok ? String(usage.input_tokens ?? "—") : "" }),
        h("td", { class: "num", title: usage.cost_estimated ? "Estimated from the catalog's input price" : "", text: payload.ok ? `${formatCost(usage.cost)}${usage.cost_estimated ? " est." : ""}` : "" }),
        h("td", { class: "small", text: payload.ok ? [payload.model, payload.meta?.served_by].filter(Boolean).join(" · ") : "" }),
      );
    })),
  );
}

function consensus(answers) {
  const heads = answers.map(headline).filter((value) => value !== null);
  if (heads.length < 2 || heads.length !== answers.length) return null;
  const counts = new Map();
  for (const value of heads) counts.set(value, (counts.get(value) || 0) + 1);
  if (counts.size === 1) return h("p", { class: "consensus agree", text: `All ${heads.length} models agree: ${heads[0]}` });
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${value} ×${count}`);
  return h("p", { class: "consensus", text: `Models disagree: ${parts.join(" · ")}` });
}

function itemCard(id, item, results, ctx) {
  const done = results.filter((result) => result.payload?.ok);
  const multi = results.length > 1;
  const blocks = done.map((result) => h("div", { class: "model-block" },
    multi ? h("p", { class: "model-label" }, h("span", { text: result.label }), h("span", { class: "mono", text: formatMs(result.payload.latency_ms) })) : null,
    renderAnswer(result.payload.answers?.[id], { item, images: ctx.images, stateText: result.payload.meta?.state_text || ctx.stateText }),
  ));
  return h("article", { class: "card" },
    h("div", { class: "card-head" }, h("h3", { class: "card-title", text: id }), h("span", { class: "pill", text: item.type })),
    item.instructions ? h("p", { class: "card-sub", text: guidanceText(item.instructions) }) : null,
    consensus(done.map((result) => result.payload.answers?.[id])),
    blocks.length ? blocks : h("p", { class: "empty", text: results.some((result) => result.pending) ? "Waiting for answers…" : "No model answered — see the errors above." }),
  );
}

export function renderResults({ tableEl, cardsEl, results, items, images, stateText }) {
  clear(tableEl).append(runTable(results));
  clear(cardsEl).append(...Object.entries(items).map(([id, item]) => itemCard(id, item, results, { images, stateText })));
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const before = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = before; }, 1200);
  } catch {
    button.textContent = "Copy failed";
  }
}

export function renderRaw(container, results) {
  clear(container);
  if (!results.length) {
    container.append(h("pre", { text: "Nothing received yet." }));
    return;
  }
  for (const result of results) {
    const payload = result.payload;
    const curlButton = h("button", { type: "button", class: "tiny", text: "Copy as curl" });
    curlButton.addEventListener("click", () => copy(curlFor(payload), curlButton));
    const jsonButton = h("button", { type: "button", class: "tiny", text: "Copy response JSON" });
    jsonButton.addEventListener("click", () => copy(JSON.stringify(payload, null, 2), jsonButton));
    container.append(h("details", { class: "raw raw-model", style: { boxShadow: "none" } },
      h("summary", { text: `${result.label} — ${result.pending ? "running" : payload.ok ? "ok" : `error ${payload.status}`}` }),
      h("div", { class: "raw-body" },
        payload?.upstream ? h("div", null, h("span", { class: "lbl", style: { marginTop: "10px" }, text: "Upstream request (key and image data redacted)" }), h("pre", { text: JSON.stringify(payload.upstream, null, 2) })) : null,
        h("span", { class: "lbl", style: { marginTop: "10px" }, text: "Response from this server" }),
        h("pre", { text: result.pending ? "…" : JSON.stringify({ ...payload, upstream: undefined }, null, 2) }),
        payload?.upstream ? h("div", { class: "raw-actions" }, curlButton, jsonButton) : null,
      ),
    ));
  }
}
