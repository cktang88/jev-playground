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
  env: { ...process.env, JEV_MOCK: "1", PORT: String(PORT) },
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
  check("page has the Ask Jev button", /Ask Jev/i.test(html));
  check("page loads no external scripts", !/<script[^>]+src=["']https?:/i.test(html));

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

  console.log("\nValidation (expect 400)");
  const cases = [
    ["missing state", { questions: threeQuestions }],
    ["empty state", { state: "   ", questions: threeQuestions }],
    ["missing questions", { state: sampleState }],
    ["empty questions", { state: sampleState, questions: {} }],
    ["bad type", { state: sampleState, questions: { q: { type: "chat", instructions: "hi" } } }],
    ["choice with one option", { state: sampleState, questions: { q: { type: "choice", instructions: "pick", criteria: { only: "x" } } } }],
    ["score with one level", { state: sampleState, questions: { q: { type: "score", instructions: "rate", criteria: ["only"] } } }],
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
