import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./lib/catalog.mjs";
import { loadConfig } from "./lib/config.mjs";
import { PlaygroundError } from "./lib/errors.mjs";
import { checkApiRequest, parseJsonBody, readBody, sendError, sendJson, serveStatic } from "./lib/http.mjs";
import { providers } from "./lib/providers/index.mjs";
import { createRunner } from "./lib/run.mjs";
import { describeTasks } from "./lib/tasks/index.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const config = loadConfig();
const catalog = createCatalog(config);
const run = createRunner({ config, catalog });

function providerStatuses() {
  return Object.values(providers).map((provider) => ({
    id: provider.id,
    label: provider.label,
    tasks: provider.tasks,
    docs: provider.docs,
    ...provider.status(config),
  }));
}

function health() {
  return {
    ok: true,
    mock: config.mock,
    defaults: config.defaults,
    // Kept for v1 clients: the default decide model and whether its key is set.
    model: config.defaults.decide.slice(config.defaults.decide.indexOf(":") + 1),
    key_present: Boolean(config.openrouter.apiKey),
    providers: providerStatuses(),
  };
}

async function handleCatalog(url) {
  const { models, warnings } = await catalog.load({ refresh: url.searchParams.get("refresh") === "1" });
  return { ok: true, mock: config.mock, defaults: config.defaults, tasks: describeTasks(), providers: providerStatuses(), models, warnings };
}

// `/api/decide` and `/api/extract` are shortcuts for `/api/run` with the task filled in.
async function handleRun(request, task) {
  const body = parseJsonBody(await readBody(request));
  if (task) body.task = task;
  return run(body);
}

const ROUTES = {
  "GET /api/health": async () => ({ status: 200, payload: health() }),
  "GET /api/catalog": async (request, url) => ({ status: 200, payload: await handleCatalog(url) }),
  "POST /api/run": (request) => handleRun(request),
  "POST /api/decide": (request) => handleRun(request, "decide"),
  "POST /api/extract": (request) => handleRun(request, "extract"),
};

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now();
  // A fixed base: the Host header is client-controlled and may not parse.
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname;
  let status = 500;

  try {
    const route = Object.hasOwn(ROUTES, `${request.method} ${pathname}`) ? ROUTES[`${request.method} ${pathname}`] : null;
    if (pathname.startsWith("/api/")) checkApiRequest(request, config);
    if (route) {
      const result = await route(request, url);
      status = result.status;
      sendJson(response, result.status, result.payload);
    } else if (pathname.startsWith("/api/")) {
      status = sendError(response, new PlaygroundError(404, `No API route ${request.method} ${pathname}.`, "See docs/CONTRACT.md for the routes."));
    } else if (request.method === "GET" || request.method === "HEAD") {
      status = await serveStatic(response, PUBLIC_DIR, pathname, request.method);
    } else {
      status = sendError(response, new PlaygroundError(405, "Method not allowed."));
    }
  } catch (failure) {
    if (!(failure instanceof PlaygroundError)) console.error(`unhandled error: ${failure?.stack || failure}`);
    if (failure?.status === 413) response.shouldKeepAlive = false;
    if (!response.headersSent) status = sendError(response, failure);
    else response.end();
  }
  console.log(`${request.method} ${pathname} ${status} ${Date.now() - startedAt}ms`);
});

server.listen(config.port, config.host, () => {
  const configured = providerStatuses().map((provider) => `${provider.id}=${provider.configured ? "ready" : "no-key"}`).join(" ");
  console.log(`system one playground on http://localhost:${config.port} (mock=${config.mock}, ${configured})`);
});
