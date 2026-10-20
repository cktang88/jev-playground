import { badRequest } from "../errors.mjs";
import {
  confidenceFrom, isGuidance, isPlainObject, normalize, parseImages, peakedWeights, pickWinner,
  randomUnit, round, validateItemMap, validateState,
} from "./shared.mjs";

// The "decide" task: state + typed questions -> calibrated probabilities.
// Shared by every System One decision model (Jev, Clef, Luna, ...), whichever
// provider serves it.

export const types = {
  noul: {
    label: "Noul",
    summary: "Yes / no — the probability the answer is yes.",
    criteria: { kind: "pair", keys: ["true", "false"], labels: ["What yes means", "What no means"], required: false },
  },
  choice: {
    label: "Choice",
    summary: "Pick one option — a probability per option, plus confidence.",
    criteria: { kind: "map", required: true, min: 2, keyLabel: "Option", valueLabel: "Description (optional)" },
  },
  score: {
    label: "Score",
    summary: "Rate against ordered levels — a probability-weighted score, plus confidence.",
    criteria: { kind: "list", required: true, min: 2, itemLabel: "Level" },
  },
  box: {
    label: "Box",
    summary: "Find something in an image — four edges as fractions of the image size.",
    criteria: { kind: "none" },
    needsImage: true,
    experimental: true,
  },
};

function validateQuestion(id, question) {
  const spec = types[question.type];
  if (!spec) {
    const allowed = Object.keys(types).map((key) => `"${key}"`).join(", ");
    return `Question "${id}" has invalid type ${JSON.stringify(question.type)}; expected ${allowed}.`;
  }
  if (!isGuidance(question.instructions)) {
    return `Question "${id}" needs non-empty \`instructions\`.`;
  }
  const criteria = question.criteria;
  if (question.type === "choice") {
    if (!isPlainObject(criteria)) return `Question "${id}" (choice) requires a criteria object of at least 2 options.`;
    if (Object.keys(criteria).length < 2) return `Question "${id}" (choice) needs at least 2 options in criteria.`;
  }
  if (question.type === "score") {
    if (!Array.isArray(criteria) || criteria.length < 2) return `Question "${id}" (score) requires a criteria array of at least 2 ordered levels.`;
  }
  if (question.type === "noul" && criteria !== undefined && criteria !== null) {
    if (!isPlainObject(criteria) || !("true" in criteria) || !("false" in criteria)) {
      return `Question "${id}" (noul) criteria must be an object with both "true" and "false".`;
    }
  }
  if (question.type === "box" && criteria !== undefined) {
    return `Question "${id}" (box) takes no criteria.`;
  }
  return null;
}

export function validate(body) {
  validateState(body.state);
  const images = parseImages(body.images);
  const ids = validateItemMap(body.questions, { key: "questions", noun: "question" });
  for (const id of ids) {
    const problem = validateQuestion(id, body.questions[id]);
    if (problem) throw badRequest(problem, "See docs/CONTRACT.md for the exact shape of each question type.");
  }
  const usesBox = ids.some((id) => body.questions[id].type === "box");
  if (usesBox && images.length === 0) {
    throw badRequest("Box questions need an image.", "Attach at least one image, or remove the box question.");
  }
  return { state: body.state, items: body.questions, images, options: isPlainObject(body.options) ? body.options : {} };
}

// ---- mock answers ----------------------------------------------------------

function mockNoul() {
  return { type: "noul", noul: round(0.05 + randomUnit() * 0.9, 3) };
}

function mockChoice(question) {
  const probabilities = normalize(peakedWeights(Object.keys(question.criteria)));
  return { type: "choice", choice: pickWinner(probabilities), probabilities, confidence: confidenceFrom(probabilities) };
}

function mockScore(question) {
  const levels = question.criteria.map((_, index) => String(index));
  const probabilities = normalize(peakedWeights(levels));
  const score = levels.reduce((sum, level) => sum + Number(level) * probabilities[level], 0);
  const legend = Object.fromEntries(question.criteria.map((label, index) => [String(index), label]));
  return { type: "score", score: round(score, 3), legend, probabilities, confidence: confidenceFrom(probabilities) };
}

function mockBox() {
  const left = round(randomUnit() * 0.5, 3);
  const top = round(randomUnit() * 0.5, 3);
  return {
    type: "box",
    box: { top, bottom: round(top + 0.15 + randomUnit() * 0.35, 3), left, right: round(left + 0.15 + randomUnit() * 0.35, 3) },
    confidence: round(0.4 + randomUnit() * 0.55, 3),
  };
}

const MOCKERS = { noul: mockNoul, choice: mockChoice, score: mockScore, box: mockBox };

export function mockAnswers(input) {
  const answers = {};
  for (const [id, question] of Object.entries(input.items)) answers[id] = MOCKERS[question.type](question);
  return answers;
}

export default {
  id: "decide",
  label: "Decide",
  summary: "Typed questions in, calibrated probabilities out. System One decision models.",
  itemsKey: "questions",
  itemNoun: "question",
  types,
  validate,
  mockAnswers,
};
