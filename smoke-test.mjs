// End-to-end smoke test. Runs the server in mock mode and checks the contract.
// Usage: node smoke-test.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

function isUnitInterval(value) {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function sumsToAboutOne(probabilities) {
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  return Math.abs(total - 1) < 0.05;
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PLAYGROUND_MOCK: "1", OPENROUTER_DISCOVER: "0", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

const serverLog = [];
server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // server not up yet
    }
    await sleep(200);
  }
  throw new Error(`server never became healthy.\n${serverLog.join("")}`);
}

const sampleState = "My checkout page shows a blank screen after I click Pay. Tried two browsers.";

const threeQuestions = {
  is_bug: {
    type: "noul",
    instructions: "Is the customer reporting a software defect?",
    criteria: { true: "Describes broken behavior.", false: "Asking a question." },
  },
  team: {
    type: "choice",
    instructions: "Which team should own this ticket?",
    criteria: { frontend: "Rendering or layout.", payments: "Checkout or billing." },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this ticket?",
    criteria: ["Can wait", "Should be fixed this week", "Blocking revenue"],
  },
};

try {
  console.log("\nStarting server in mock mode...\n");
  const health = await waitForHealth();

  console.log("GET /api/health");
  check("health returns ok:true", health.ok === true, JSON.stringify(health));
  check("health reports mock mode", health.mock === true, JSON.stringify(health));
  check("health reports the model", typeof health.model === "string" && health.model.length > 0);
  check("health does not leak a key", !JSON.stringify(health).includes("sk-or-"));

  console.log("\nGET / (static)");
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check("index.html is served", page.status === 200, `status=${page.status}`);
  check("page has the run button", /id="run-button"/.test(html));
  check("page loads no external scripts", !/<script[^>]+src=["']https?:/i.test(html));
  const appJs = await fetch(`${BASE}/js/app.mjs`);
  check("ES module app is served as JavaScript", appJs.status === 200 && /javascript/.test(appJs.headers.get("content-type") || ""));

  console.log("\nGET /api/catalog");
  const catalog = await (await fetch(`${BASE}/api/catalog`)).json();
  check("catalog lists both tasks", Boolean(catalog.tasks?.decide && catalog.tasks?.extract));
  check("catalog publishes extract field types", Object.keys(catalog.tasks?.extract?.types || {}).length === 9);
  check("catalog lists both providers", ["openrouter", "cloudflare"].every((id) => catalog.providers?.some((p) => p.id === id)));
  check("catalog includes Clairic", catalog.models?.some((m) => m.id === "cloudflare:@cf/cloudflare/clairic" && m.task === "extract"));
  check("catalog includes GPT-6 Luna decisions", catalog.models?.some((m) => m.id === "openrouter:openai/gpt-6-luna-decisions"));
  check("catalog does not leak keys", !JSON.stringify(catalog).includes("sk-or-"));

  console.log("\nPOST /api/decide (all three types)");
  const ok = await post("/api/decide", { state: sampleState, questions: threeQuestions });
  check("returns 200", ok.status === 200, `status=${ok.status} body=${JSON.stringify(ok.json)?.slice(0, 300)}`);
  check("envelope has ok:true", ok.json?.ok === true);
  check("envelope has latency_ms", typeof ok.json?.latency_ms === "number");
  check("envelope has usage tokens", typeof ok.json?.usage?.input_tokens === "number");
  check("envelope flags mock", ok.json?.mock === true);

  const answers = ok.json?.answers || {};
  check("answer for noul present", answers.is_bug?.type === "noul");
  check("noul value is 0..1", isUnitInterval(answers.is_bug?.noul), JSON.stringify(answers.is_bug));
  check("answer for choice present", answers.team?.type === "choice");
  check("choice picked a valid option", ["frontend", "payments"].includes(answers.team?.choice));
  check("choice probabilities sum to ~1", sumsToAboutOne(answers.team?.probabilities || {}));
  check("choice has confidence", isUnitInterval(answers.team?.confidence));
  check("answer for score present", answers.urgency?.type === "score");
  check("score is within level range", answers.urgency?.score >= 0 && answers.urgency?.score <= 2);
  check("score legend has all levels", Object.keys(answers.urgency?.legend || {}).length === 3);
  check("score probabilities sum to ~1", sumsToAboutOne(answers.urgency?.probabilities || {}));
  check("score has confidence", isUnitInterval(answers.urgency?.confidence));

  console.log("\nPOST /api/decide (JSON object state)");
  const jsonState = await post("/api/decide", {
    state: { customer_tier: "enterprise", ticket: sampleState },
    questions: { is_bug: threeQuestions.is_bug },
  });
  check("accepts object state", jsonState.status === 200, JSON.stringify(jsonState.json)?.slice(0, 200));

  console.log("\nPOST /api/run (one request, several providers)");
  for (const target of ["openrouter:typesafe/jev-1.14", "openrouter:openai/gpt-6-luna-decisions", "cloudflare:@cf/cloudflare/clef"]) {
    const result = await post("/api/run", { task: "decide", target, state: sampleState, questions: threeQuestions });
    check(`${target} -> 200`, result.status === 200, JSON.stringify(result.json)?.slice(0, 200));
    check(`${target} -> echoes target`, result.json?.target === target);
    check(`${target} -> shows upstream preview`, typeof result.json?.upstream?.url === "string");
  }

  console.log("\nPOST /api/extract (Clairic)");
  const extract = await post("/api/extract", {
    target: "cloudflare:@cf/cloudflare/clairic",
    state: "Invoice INV-2291 from Northwind Supply, issued 2026-09-02, net 30. 4 pallets at $250.00 each.",
    fields: {
      invoice_number: { type: "text" },
      total: { type: "number", decimals: 2, unit: "USD" },
      contacts: { type: "list", items: "text" },
      days_to_pay: { type: "estimate", min: 0, max: 120, step: 1 },
      next: { type: "forecast", horizon: 3, interval: "day", min: 1, max: 100 },
    },
    options: { include_quantiles: true },
  });
  const fields = extract.json?.answers || {};
  check("extract returns 200", extract.status === 200, JSON.stringify(extract.json)?.slice(0, 300));
  check("text answer has span + p_null", Array.isArray(fields.invoice_number?.span) && typeof fields.invoice_number?.p_null === "number");
  check("list answer has spans", Array.isArray(fields.contacts?.spans));
  check("estimate inside [min, max]", fields.days_to_pay?.p10 >= 0 && fields.days_to_pay?.p90 <= 120);
  check("estimate quantiles on request", fields.days_to_pay?.quantiles?.length === 99);
  check("forecast has one value per step", fields.next?.value?.length === 3);

  console.log("\nValidation (expect 400)");
  const cases = [
    ["missing state", { questions: threeQuestions }],
    ["empty state", { state: "   ", questions: threeQuestions }],
    ["missing questions", { state: sampleState }],
    ["empty questions", { state: sampleState, questions: {} }],
    ["bad type", { state: sampleState, questions: { q: { type: "chat", instructions: "hi" } } }],
    ["choice with one option", { state: sampleState, questions: { q: { type: "choice", instructions: "pick", criteria: { only: "x" } } } }],
    ["score with one level", { state: sampleState, questions: { q: { type: "score", instructions: "rate", criteria: ["only"] } } }],
    ["missing instructions", { state: sampleState, questions: { q: { type: "noul" } } }],
    ["box without image", { state: sampleState, questions: { q: { type: "box", instructions: "the mug" } } }],
    ["extract model on decide", { target: "cloudflare:@cf/cloudflare/clairic", state: sampleState, questions: threeQuestions }],
    ["unknown provider", { target: "nope:model", state: sampleState, questions: threeQuestions }],
  ];
  for (const [name, body] of cases) {
    const result = await post("/api/decide", body);
    check(`${name} -> 400`, result.status === 400, `got ${result.status}`);
    check(`${name} -> ok:false`, result.json?.ok === false, JSON.stringify(result.json)?.slice(0, 200));
    check(`${name} -> has hint`, typeof result.json?.hint === "string" && result.json.hint.length > 0);
  }

  console.log("\nMisc");
  const notFound = await fetch(`${BASE}/nope.html`);
  check("missing static file -> 404", notFound.status === 404, `status=${notFound.status}`);
  const badJson = await fetch(`${BASE}/api/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  check("malformed JSON -> 400", badJson.status === 400, `status=${badJson.status}`);
  const noRoute = await fetch(`${BASE}/api/nope`);
  check("unknown API route -> 404 JSON", noRoute.status === 404 && (await noRoute.json()).ok === false);
} catch (error) {
  failed += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  if (!server.killed) server.kill("SIGKILL");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
