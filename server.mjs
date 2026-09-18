import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const UPSTREAM_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1_000_000;

const MODEL = process.env.JEV_MODEL || DEFAULT_MODEL;
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || "127.0.0.1";
const MOCK = process.env.JEV_MOCK === "1";
const API_KEY = process.env.OPENROUTER_API_KEY || "";

const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, status, error, hint, details) {
  const payload = { ok: false, error, status };
  if (hint) payload.hint = hint;
  if (details !== undefined) payload.details = details;
  sendJson(response, status, payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJsonBody(raw) {
  if (!raw.trim()) {
    throw Object.assign(new Error("Request body is empty"), {
      status: 400,
      hint: "Send a JSON body with `state` and `questions`.",
    });
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), {
      status: 400,
      hint: "Check for trailing commas or unquoted keys.",
    });
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateState(state) {
  if (state === undefined || state === null) {
    return { error: "Missing `state`.", hint: "Provide the facts Jev should reason over as a string, object, or array." };
  }
  if (typeof state === "string") {
    if (!isNonEmptyString(state)) {
      return { error: "`state` is empty.", hint: "Give Jev at least a sentence of context." };
    }
    return null;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) {
      return { error: "`state` array is empty.", hint: "Include at least one item of context." };
    }
    return null;
  }
  if (typeof state === "object") {
    if (Object.keys(state).length === 0) {
      return { error: "`state` object is empty.", hint: "Include at least one key of context." };
    }
    return null;
  }
  return { error: "`state` must be a string, object, or array.", hint: `Received ${typeof state}.` };
}

function validateQuestion(id, question) {
  if (question === null || typeof question !== "object" || Array.isArray(question)) {
    return `Question "${id}" must be an object.`;
  }
  if (!QUESTION_TYPES.has(question.type)) {
    return `Question "${id}" has invalid type ${JSON.stringify(question.type)}; expected "noul", "choice", or "score".`;
  }

  const criteria = question.criteria;

  if (question.type === "choice") {
    if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
      return `Question "${id}" (choice) requires a criteria object of at least 2 options.`;
    }
    if (Object.keys(criteria).length < 2) {
      return `Question "${id}" (choice) needs at least 2 options in criteria.`;
    }
  }

  if (question.type === "score") {
    if (!Array.isArray(criteria) || criteria.length < 2) {
      return `Question "${id}" (score) requires a criteria array of at least 2 ordered levels.`;
    }
  }

  if (question.type === "noul" && criteria !== undefined && criteria !== null) {
    if (typeof criteria !== "object" || Array.isArray(criteria)) {
      return `Question "${id}" (noul) criteria must be an object with optional "true"/"false".`;
    }
  }

  return null;
}

function validateRequest(body) {
  const stateProblem = validateState(body.state);
  if (stateProblem) return stateProblem;

  if (body.questions === null || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return { error: "Missing or invalid `questions`.", hint: "Send an object mapping ids to question definitions." };
  }
  const ids = Object.keys(body.questions);
  if (ids.length === 0) {
    return { error: "`questions` is empty.", hint: "Add at least one question." };
  }

  for (const id of ids) {
    const problem = validateQuestion(id, body.questions[id]);
    if (problem) {
      return { error: problem, hint: "See CONTRACT.md for the exact shape of each question type." };
    }
  }

  return null;
}

function randomUnit() {
  return crypto.randomInt(0, 10_000) / 10_000;
}

function normalize(weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((sum, key) => sum + weights[key], 0);
  const probabilities = {};
  let assigned = 0;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      probabilities[key] = Number((1 - assigned).toFixed(4));
      return;
    }
    const share = Number((weights[key] / total).toFixed(4));
    probabilities[key] = share;
    assigned += share;
  });
  return probabilities;
}

function pickWinner(probabilities) {
  return Object.keys(probabilities).reduce((best, key) =>
    probabilities[key] > probabilities[best] ? key : best,
  );
}

// Confidence tracks how spread out the distribution is: one dominant option means
// high confidence, an even split means low. Mirrors the calibrated confidence Jev
// returns, so the mock demo teaches the same relationship as the real API.
function confidenceFrom(probabilities) {
  const values = Object.values(probabilities).filter((value) => value > 0);
  if (values.length < 2) return 1;
  const entropy = -values.reduce((sum, value) => sum + value * Math.log(value), 0);
  const maxEntropy = Math.log(values.length);
  return Number(Math.max(0, Math.min(1, 1 - entropy / maxEntropy)).toFixed(3));
}

function mockNoul() {
  return { type: "noul", noul: Number((0.05 + randomUnit() * 0.9).toFixed(3)) };
}

function mockChoice(question) {
  const options = Object.keys(question.criteria);
  const weights = {};
  for (const option of options) weights[option] = 0.2 + randomUnit();
  const probabilities = normalize(weights);
  return {
    type: "choice",
    choice: pickWinner(probabilities),
    probabilities,
    confidence: confidenceFrom(probabilities),
  };
}

function mockScore(question) {
  const levels = question.criteria.map((_, index) => String(index));
  const weights = {};
  for (const level of levels) weights[level] = 0.2 + randomUnit();
  const probabilities = normalize(weights);
  const score = levels.reduce((sum, level) => sum + Number(level) * probabilities[level], 0);
  const legend = {};
  question.criteria.forEach((label, index) => {
    legend[String(index)] = label;
  });
  return {
    type: "score",
    score: Number(score.toFixed(3)),
    legend,
    probabilities,
    confidence: confidenceFrom(probabilities),
  };
}

function mockAnswers(questions) {
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") answers[id] = mockNoul();
    else if (question.type === "choice") answers[id] = mockChoice(question);
    else answers[id] = mockScore(question);
  }
  return answers;
}

function upstreamHint(status) {
  if (status === 401) return "Set OPENROUTER_API_KEY in the server environment.";
  if (status === 402) return "OpenRouter credits are exhausted; top up the account.";
  if (status === 403) return "The API key lacks permission for this model.";
  if (status === 429) return "Rate limited upstream; retry with backoff.";
  if (status === 529) return "Upstream is overloaded; retry with backoff.";
  return undefined;
}

function upstreamMessage(status, upstreamBody) {
  const fromUpstream = upstreamBody?.error?.message || upstreamBody?.message;
  if (isNonEmptyString(fromUpstream)) return fromUpstream;
  return `Upstream request failed with status ${status}.`;
}

async function callUpstream({ model, state, questions }) {
  return fetch(UPSTREAM_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, state, questions }),
  });
}

async function handleDecide(request, response) {
  const startedAt = Date.now();
  let body;
  try {
    body = parseJsonBody(await readBody(request));
  } catch (problem) {
    sendError(response, problem.status || 400, problem.message, problem.hint, {});
    return { status: problem.status || 400, startedAt };
  }

  const problem = validateRequest(body);
  if (problem) {
    sendError(response, 400, problem.error, problem.hint, {});
    return { status: 400, startedAt };
  }

  const model = isNonEmptyString(body.model) ? body.model : MODEL;
  const questions = body.questions;

  if (MOCK) {
    const answers = mockAnswers(questions);
    const usage = {
      input_tokens: JSON.stringify(body.state).length,
      output_tokens: JSON.stringify(answers).length,
      cost: 0,
    };
    sendJson(response, 200, {
      ok: true,
      model,
      answers,
      usage,
      latency_ms: Date.now() - startedAt,
      mock: true,
    });
    return { status: 200, startedAt };
  }

  if (!API_KEY) {
    sendError(
      response,
      401,
      "Server has no OpenRouter API key.",
      "Set OPENROUTER_API_KEY, or run with JEV_MOCK=1 to try the demo offline.",
      {},
    );
    return { status: 401, startedAt };
  }

  let upstream;
  try {
    upstream = await callUpstream({ model, state: body.state, questions });
  } catch (failure) {
    const timedOut = failure?.name === "AbortError" || failure?.name === "TimeoutError";
    const status = timedOut ? 504 : 502;
    sendError(
      response,
      status,
      timedOut ? "Upstream request timed out." : "Could not reach OpenRouter.",
      timedOut ? "Try again, or simplify the request." : "Check the server's network access.",
      {},
    );
    return { status, startedAt };
  }

  const text = await upstream.text();
  let upstreamBody = null;
  try {
    upstreamBody = JSON.parse(text);
  } catch {
    upstreamBody = null;
  }

  if (!upstream.ok) {
    const hint = upstreamHint(upstream.status);
    sendError(response, upstream.status, upstreamMessage(upstream.status, upstreamBody), hint, {});
    return { status: upstream.status, startedAt };
  }

  const usage = {
    input_tokens: upstreamBody?.usage?.input_tokens ?? 0,
    output_tokens: upstreamBody?.usage?.output_tokens ?? 0,
    cost: upstreamBody?.usage?.cost ?? 0,
  };

  sendJson(response, 200, {
    ok: true,
    model: upstreamBody?.model || model,
    answers: upstreamBody?.answers || {},
    usage,
    latency_ms: Date.now() - startedAt,
    mock: false,
  });
  return { status: 200, startedAt };
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, relative);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    sendError(response, 403, "Forbidden path.", undefined, {});
    return 403;
  }
  try {
    const file = await fs.readFile(target);
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Content-Length": file.length });
    response.end(file);
    return 200;
  } catch {
    sendError(response, 404, "Not found.", undefined, {});
    return 404;
  }
}

function logRequest(method, pathname, status, startedAt) {
  console.log(`${method} ${pathname} ${status} ${Date.now() - startedAt}ms`);
}

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, model: MODEL, mock: MOCK, key_present: Boolean(API_KEY) });
      logRequest("GET", pathname, 200, startedAt);
      return;
    }

    if (request.method === "POST" && pathname === "/api/decide") {
      const outcome = await handleDecide(request, response);
      logRequest("POST", pathname, outcome.status, outcome.startedAt);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const status = await serveStatic(request, response, pathname);
      logRequest(request.method, pathname, status, startedAt);
      return;
    }

    sendError(response, 405, "Method not allowed.", undefined, {});
    logRequest(request.method, pathname, 405, startedAt);
  } catch (failure) {
    console.error(`unhandled error: ${failure?.message}`);
    if (!response.headersSent) {
      sendError(response, 500, "Internal server error.", undefined, {});
    } else {
      response.end();
    }
    logRequest(request.method, pathname, 500, startedAt);
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `jev playground on http://localhost:${PORT} (model=${MODEL}, mock=${MOCK}, key_present=${Boolean(API_KEY)})`,
  );
});
