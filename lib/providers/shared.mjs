import crypto from "node:crypto";
import { PlaygroundError } from "../errors.mjs";

// Building blocks for provider adapters: status-code hints, upstream error
// extraction, and redaction of request previews.

const GENERIC_HINTS = {
  402: "The account is out of credits; top up and retry.",
  404: "The model id was not found upstream. Pick one from the catalog or check the spelling.",
  413: "The request is too large; shorten the state or drop images.",
  429: "Rate limited upstream; retry with backoff.",
  500: "The provider had an internal error; retry once.",
  502: "The provider's upstream failed; retry with backoff.",
  503: "The provider is temporarily unavailable; retry with backoff.",
  524: "The provider timed out at the edge; retry, or simplify the request.",
  529: "The provider is overloaded; retry with backoff.",
};

export function upstreamError(status, message, hints = {}) {
  const text = typeof message === "string" && message.trim() ? message : `Upstream request failed with status ${status}.`;
  return new PlaygroundError(status >= 400 && status < 600 ? status : 502, text, hints[status] ?? GENERIC_HINTS[status]);
}

export function newReference() {
  return `img-${crypto.randomUUID()}`;
}

// Request previews are shown in the UI to teach each wire format. Image bytes
// (data URLs, and `data_base64` asset fields) are elided so a preview stays
// readable; everything else, including long state text, is shown as sent.
export function redactForPreview(value, key) {
  if (typeof value === "string") {
    if (/^data:[^,]*;base64,/i.test(value)) {
      const prefix = value.slice(0, value.indexOf(",") + 1);
      return `${prefix}<base64 ${value.length - prefix.length} chars>`;
    }
    if (key === "data_base64") return `<base64 ${value.length} chars>`;
    return value;
  }
  if (Array.isArray(value)) return value.map((inner) => redactForPreview(inner));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([innerKey, inner]) => [innerKey, redactForPreview(inner, innerKey)]));
  }
  return value;
}

export function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, /^authorization$/i.test(key) ? "Bearer <redacted>" : value]),
  );
}

export function perMillion(perToken) {
  const value = Number(perToken);
  return Number.isFinite(value) && value >= 0 ? Number((value * 1e6).toPrecision(6)) : undefined;
}
