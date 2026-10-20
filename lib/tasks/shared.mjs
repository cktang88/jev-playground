import crypto from "node:crypto";
import { badRequest } from "../errors.mjs";

// Helpers shared by every task: input validation for the parts all tasks have in
// common (state, images, the typed item map) and the math the mock answers use.

export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Guidance fields (instructions, criteria descriptions) may be a string or structured JSON.
export function isGuidance(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

export function validateState(state, { allowEmpty = false } = {}) {
  if (state === undefined || state === null || (allowEmpty && state === "")) {
    if (allowEmpty) return;
    throw badRequest("Missing `state`.", "Provide the context to reason over as a string, object, or array.");
  }
  if (typeof state === "string") {
    if (!allowEmpty && !isNonEmptyString(state)) throw badRequest("`state` is empty.", "Give the model at least a sentence of context.");
    return;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) throw badRequest("`state` array is empty.", "Include at least one item of context.");
    return;
  }
  if (isPlainObject(state)) {
    if (Object.keys(state).length === 0) throw badRequest("`state` object is empty.", "Include at least one key of context.");
    return;
  }
  throw badRequest("`state` must be a string, object, or array.", `Received ${typeof state}.`);
}

// Images arrive as data URLs. Each provider re-encodes them into its own wire format.
export function parseImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw badRequest("`images` must be an array of data URLs.", "Example: [\"data:image/png;base64,iVBOR...\"]");
  if (images.length > MAX_IMAGES) throw badRequest(`Too many images (${images.length}).`, `Send at most ${MAX_IMAGES}.`);
  let total = 0;
  return images.map((image, index) => {
    const match = typeof image === "string" ? DATA_URL.exec(image) : null;
    if (!match) {
      throw badRequest(`Image ${index + 1} is not a base64 data URL.`, "Use data:image/png|jpeg|webp;base64,... — remote URLs are not accepted.");
    }
    const base64 = match[2].replace(/\s+/g, "");
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) throw badRequest(`Image ${index + 1} is larger than 4 MiB.`, "Downscale it before sending.");
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw badRequest("Images exceed 8 MiB in total.", "Send fewer or smaller images.");
    const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
    return { mime, base64, bytes, dataUrl: `data:${mime};base64,${base64}` };
  });
}

export function validateItemMap(items, { key, noun, maxIdLength = 100 }) {
  if (!isPlainObject(items)) {
    throw badRequest(`Missing or invalid \`${key}\`.`, `Send an object mapping ids to ${noun} definitions.`);
  }
  const ids = Object.keys(items);
  if (ids.length === 0) throw badRequest(`\`${key}\` is empty.`, `Add at least one ${noun}.`);
  for (const id of ids) {
    if (!id.trim() || id.length > maxIdLength) throw badRequest(`Invalid ${noun} id ${JSON.stringify(id)}.`, `Ids must be 1-${maxIdLength} characters.`);
    if (!isPlainObject(items[id])) throw badRequest(`${capitalize(noun)} "${id}" must be an object.`, `See docs/CONTRACT.md for the ${noun} shape.`);
  }
  return ids;
}

export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- mock math -------------------------------------------------------------

export function randomUnit() {
  return crypto.randomInt(0, 10_000) / 10_000;
}

export function round(value, places = 4) {
  return Number(value.toFixed(places));
}

// Rounds to 4 places and gives the rounding remainder to the largest share, so the
// result always sums to 1 and no entry goes negative (even with hundreds of options).
export function normalize(weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((sum, key) => sum + weights[key], 0);
  const probabilities = Object.fromEntries(keys.map((key) => [key, round(weights[key] / total)]));
  const largest = keys.reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best));
  const drift = 1 - keys.reduce((sum, key) => sum + probabilities[key], 0);
  probabilities[largest] = round(Math.max(0, probabilities[largest] + drift));
  return probabilities;
}

export function pickWinner(probabilities) {
  return Object.keys(probabilities).reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best));
}

// Confidence tracks how spread out the distribution is: one dominant option means
// high confidence, an even split means low. Mirrors the calibrated confidence the
// real models return, so the mock demo teaches the same relationship.
export function confidenceFrom(probabilities) {
  const values = Object.values(probabilities).filter((value) => value > 0);
  if (values.length < 2) return 1;
  const entropy = -values.reduce((sum, value) => sum + value * Math.log(value), 0);
  return round(Math.max(0, Math.min(1, 1 - entropy / Math.log(values.length))), 3);
}

// Peaked weights make mock answers look like a real model usually does: one clear favourite.
export function peakedWeights(keys) {
  const favourite = crypto.randomInt(0, keys.length);
  const weights = {};
  keys.forEach((key, index) => {
    weights[key] = (index === favourite ? 1.5 + randomUnit() * 3 : 0.1 + randomUnit());
  });
  return weights;
}
