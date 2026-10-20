import fs from "node:fs/promises";
import path from "node:path";
import { PlaygroundError } from "./errors.mjs";

// Images travel inline as base64, so the body limit matches Cloudflare's 16 MiB cap.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function errorPayload(problem, extra = {}) {
  const known = problem instanceof PlaygroundError;
  const status = known ? problem.status : 500;
  const payload = { ok: false, error: known ? problem.message : "Internal server error.", status };
  if (known && problem.hint) payload.hint = problem.hint;
  payload.details = (known && problem.details) || {};
  return { status, payload: { ...payload, ...extra } };
}

export function sendError(response, problem, extra) {
  const { status, payload } = errorPayload(problem, extra);
  sendJson(response, status, payload);
  return status;
}

export function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => new PlaygroundError(413, "Request body too large.", "Keep images under 4 MiB each and the body under 16 MiB.");
    if (Number(request.headers["content-length"]) > limit) {
      request.resume();
      reject(tooLarge());
      return;
    }
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Keep draining instead of destroying the socket, so the 413 envelope can still be sent.
        request.off("data", onData);
        request.resume();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    request.on("data", onData);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function parseJsonBody(raw) {
  if (!raw.trim()) {
    throw new PlaygroundError(400, "Request body is empty", "Send a JSON body with `state` and `questions` or `fields`.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlaygroundError(400, "Request body is not valid JSON", "Check for trailing commas or unquoted keys.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlaygroundError(400, "Request body must be a JSON object", "Wrap the request in `{ ... }`.");
  }
  return parsed;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value) {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

// The API spends the server's provider keys, so only accept calls that a page on this
// server could have made: a known Host (blocks DNS rebinding), a same-origin Origin when
// a browser sends one (blocks cross-site form posts), and a JSON content type on POSTs
// (which forces a CORS preflight that this server never approves).
export function checkApiRequest(request, config) {
  const host = request.headers.host || "";
  const hostname = hostnameOf(host);
  const allowed = new Set([...LOOPBACK_HOSTS, config.host, ...config.allowedHosts]);
  if (!hostname || !(allowed.has(hostname) || config.allowedHosts.includes("*"))) {
    throw new PlaygroundError(403, `Host ${JSON.stringify(host)} is not allowed.`, "Open the playground via localhost, or add the host name to ALLOWED_HOSTS.");
  }
  const origin = request.headers.origin;
  if (origin && origin !== "null") {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host) throw new PlaygroundError(403, "Cross-origin API calls are not allowed.", "Call the API from the playground page or from a non-browser client.");
  }
  if (request.method === "POST" && !/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    throw new PlaygroundError(415, "Send the body as application/json.", "Set the header Content-Type: application/json.");
  }
}

export async function serveStatic(response, publicDir, pathname, method) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendError(response, new PlaygroundError(404, "Not found."));
  }
  const relative = pathname === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(publicDir, relative);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    return sendError(response, new PlaygroundError(403, "Forbidden path."));
  }
  try {
    const file = await fs.readFile(target);
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Content-Length": file.length });
    response.end(method === "HEAD" ? undefined : file);
    return 200;
  } catch {
    return sendError(response, new PlaygroundError(404, "Not found."));
  }
}
