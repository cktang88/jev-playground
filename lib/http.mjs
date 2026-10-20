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
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PlaygroundError(413, "Request body too large.", "Keep images under 4 MiB each and the body under 16 MiB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
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

export async function serveStatic(response, publicDir, pathname, method) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
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
