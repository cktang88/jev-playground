// Unit tests for the run pipeline and provider adapters, with fetch faked out.
// Usage: node --test test/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog } from "../lib/catalog.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createRunner } from "../lib/run.mjs";

const PNG = `data:image/png;base64,${Buffer.from("fake png bytes").toString("base64")}`;

function setup(env = {}, reply = { status: 200, json: {} }) {
  const config = loadConfig({ OPENROUTER_API_KEY: "sk-or-test", CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_API_TOKEN: "cf-test", OPENROUTER_DISCOVER: "0", ...env });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = typeof reply === "function" ? reply(calls.at(-1)) : reply;
    return { status: next.status, text: async () => JSON.stringify(next.json) };
  };
  const run = createRunner({ config, catalog: createCatalog(config, { fetchImpl }), fetchImpl });
  return { run, calls };
}

const QUESTIONS = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "Money", technical: "Outages" } },
};

test("openrouter: sends the decisions request and passes answers through", async () => {
  const answers = { urgent: { type: "noul", noul: 0.9 }, team: { type: "choice", choice: "technical", probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.7 } };
  const { run, calls } = setup({}, { status: 200, json: { model: "typesafe/jev-1.14", provider: "TypeSafe", answers, usage: { input_tokens: 50, output_tokens: 4, cost: 0.002 } } });
  const { status, payload } = await run({ task: "decide", target: "openrouter:typesafe/jev-1.14", state: "Checkout is down", questions: QUESTIONS });
  assert.equal(status, 200);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-or-test");
  assert.deepEqual(calls[0].body, { model: "typesafe/jev-1.14", state: "Checkout is down", questions: QUESTIONS });
  assert.deepEqual(payload.answers, answers);
  assert.equal(payload.usage.cost, 0.002);
  assert.equal(payload.usage.cost_estimated, undefined);
  assert.equal(payload.meta.served_by, "TypeSafe");
  assert.equal(payload.upstream.headers.Authorization, "Bearer <redacted>");
});

test("openrouter: images become TypeSafe assets referenced from the state", async () => {
  const { run, calls } = setup({}, { status: 200, json: { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } });
  await run({ task: "decide", target: "openrouter:typesafe/jev-1.14", state: { note: "door cam" }, images: [PNG], questions: { mug: { type: "box", instructions: "the mug" } } });
  const body = calls[0].body;
  const [ref] = Object.keys(body.assets);
  assert.equal(body.state.note, "door cam");
  assert.equal(body.state.image_1, ref);
  assert.deepEqual(body.assets[ref], { type: "image", format: "png", data_base64: PNG.split(",")[1] });
  assert.equal(calls[0].headers["TypeSafe-Danger-Zone-Images"], "true");
});

test("openrouter: upstream errors keep their status and get a hint", async () => {
  const { run } = setup({}, { status: 402, json: { error: { code: 402, message: "Insufficient credits" } } });
  const { status, payload } = await run({ target: "openrouter:typesafe/jev-1.14", state: "x", questions: QUESTIONS });
  assert.equal(status, 402);
  assert.equal(payload.error, "Insufficient credits");
  assert.match(payload.hint, /credits/);
  assert.equal(payload.target, "openrouter:typesafe/jev-1.14");
});

test("cloudflare clairic: builds the Workers AI extraction request and unwraps result", async () => {
  const result = {
    model: "clairic",
    answers: { total: { type: "number", value: 1080, guess: 1080, p_null: 0, confidence: 0.99 } },
    truncated: false,
    usage: { state_tokens: 61, input_tokens: 655, output_tokens: 0, passes: 1 },
  };
  const { run, calls } = setup({}, { status: 200, json: { result, success: true, errors: [], messages: [] } });
  const { status, payload } = await run({
    task: "extract",
    target: "cloudflare:@cf/cloudflare/clairic",
    state: { invoice: "INV-1", amount: "$1,080" },
    fields: { total: { type: "number", decimals: 2, unit: "USD" } },
    options: { reference_date: "2026-10-20", include_quantiles: true },
  });
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/cloudflare/clairic");
  assert.equal(calls[0].headers.Authorization, "Bearer cf-test");
  assert.equal(calls[0].body.model, "clairic");
  assert.equal(typeof calls[0].body.state, "string", "object state is serialized for extraction");
  assert.equal(calls[0].body.reference_date, "2026-10-20");
  assert.deepEqual(calls[0].body.options, { include_quantiles: true });
  assert.equal(payload.answers.total.value, 1080);
  assert.equal(payload.meta.truncated, false);
  assert.equal(payload.usage.passes, 1);
  assert.equal(payload.usage.cost_estimated, true);
  assert.equal(payload.usage.cost, 0.0000655);
});

test("cloudflare clef: decision schema with the short model alias and data URL images", async () => {
  const { run, calls } = setup({}, { status: 200, json: { result: { model: "clef", answers: {}, usage: { input_tokens: 3, output_tokens: 0 } }, success: true } });
  await run({ target: "cloudflare:@cf/cloudflare/clef-flash", state: "x", images: [PNG], questions: QUESTIONS });
  assert.equal(calls[0].body.model, "clef-flash");
  assert.deepEqual(calls[0].body.questions, QUESTIONS);
  assert.deepEqual(calls[0].body.images, [PNG]);
});

test("cloudflare: error envelopes surface the first error message", async () => {
  const { run } = setup({}, { status: 400, json: { success: false, errors: [{ code: 5006, message: "Error: fields.total: unknown type" }] } });
  const { status, payload } = await run({ task: "extract", target: "cloudflare:@cf/cloudflare/clairic", state: "x", fields: { total: { type: "number" } } });
  assert.equal(status, 400);
  assert.equal(payload.error, "Error: fields.total: unknown type");
});

test("capabilities: models reject what they cannot do before any network call", async () => {
  const { run, calls } = setup();
  const box = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", images: [PNG], questions: { b: { type: "box", instructions: "it" } } });
  assert.equal(box.status, 400);
  assert.match(box.payload.error, /does not support box/);

  const wrongTask = await run({ task: "decide", target: "cloudflare:@cf/cloudflare/clairic", state: "x", questions: QUESTIONS });
  assert.equal(wrongTask.status, 400);
  assert.match(wrongTask.payload.hint, /extract/);

  const levels = Array.from({ length: 11 }, (_, index) => `L${index}`);
  const tooMany = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", questions: { s: { type: "score", instructions: "rate", criteria: levels } } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.payload.error, /2-10/);

  const webp = await run({ target: "openrouter:typesafe/jev-1.14", state: "x", images: ["data:image/webp;base64,AAAA"], questions: QUESTIONS });
  assert.equal(webp.status, 400);
  assert.equal(calls.length, 0);
});

test("unconfigured providers answer 401 with a setup hint; mock still works", async () => {
  const { run, calls } = setup({ OPENROUTER_API_KEY: "", CLOUDFLARE_API_TOKEN: "" });
  const live = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", questions: QUESTIONS });
  assert.equal(live.status, 401);
  assert.match(live.payload.error, /CLOUDFLARE_API_TOKEN/);
  const mocked = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", questions: QUESTIONS, mock: true });
  assert.equal(mocked.status, 200);
  assert.equal(mocked.payload.mock, true);
  assert.equal(mocked.payload.answers.team.type, "choice");
  assert.equal(calls.length, 0);
});

test("custom model ids are allowed and routed to their provider", async () => {
  const { run, calls } = setup({}, { status: 200, json: { model: "x/y", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } });
  const { status, payload } = await run({ provider: "openrouter", model: "someone/new-decider", state: "x", questions: QUESTIONS });
  assert.equal(status, 200);
  assert.equal(calls[0].body.model, "someone/new-decider");
  assert.equal(payload.target, "openrouter:someone/new-decider");
});

test("extract validation catches bad field specs", async () => {
  const { run } = setup({ PLAYGROUND_MOCK: "1" });
  const cases = [
    [{ "1bad": { type: "text" } }, /Field name/],
    [{ a: { type: "list" } }, /requires `items`/],
    [{ a: { type: "estimate", min: 10 } }, /requires `max`/],
    [{ a: { type: "estimate", min: 10, max: 5 } }, /less than max/],
    [{ a: { type: "estimate", min: 0, max: 5, scale: "log" } }, /log scale/],
    [{ a: { type: "forecast", horizon: 99, min: 1, max: 2 } }, /at most 64/],
    [{ a: { type: "number", decimals: 9 } }, /at most 6/],
    [{ a: { type: "text", bogus: 1 } }, /does not take a "bogus"/],
    [{ a: { type: "text", horizon: 5 } }, /does not take a "horizon"/],
    [{ a: { type: "estimate", min: 1, max: 2, step: Infinity } }, /positive number/],
    [{ a: { type: "estimate", min: "2026-13-45", max: "2026-99-99" } }, /number or an ISO date/],
    [{ a: { type: "constructor" } }, /invalid type/],
  ];
  for (const [fields, pattern] of cases) {
    const { status, payload } = await run({ task: "extract", target: "cloudflare:@cf/cloudflare/clairic", state: "x", fields });
    assert.equal(status, 400, JSON.stringify(fields));
    assert.match(payload.error, pattern);
  }
});

test("catalog: live discovery merges with curated rows and survives failure", async () => {
  const config = loadConfig({});
  const live = {
    data: [
      { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", context_length: 1, pricing: { prompt: "0.0000001" }, architecture: { input_modalities: ["text"] } },
      { id: "acme/brand-new", name: "Acme: Brand New", context_length: 4096, pricing: { prompt: "0" }, architecture: { input_modalities: ["text", "image"] } },
    ],
  };
  const ok = createCatalog(config, { fetchImpl: async () => ({ ok: true, json: async () => live }) });
  const { models, warnings } = await ok.load();
  const jev = models.find((row) => row.id === "openrouter:typesafe/jev-1.14");
  assert.deepEqual(warnings, []);
  assert.ok(jev.types.includes("box"), "curated types survive the merge");
  assert.equal(jev.pricing.input_per_mtok, 0.1, "live pricing refreshes curated rows");
  assert.equal(models.find((row) => row.id === "openrouter:acme/brand-new").vision, true);

  const broken = createCatalog(config, { fetchImpl: async () => { throw new Error("offline"); } });
  const fallback = await broken.load();
  assert.match(fallback.warnings[0], /offline/);
  assert.ok(fallback.models.some((row) => row.id === "cloudflare:@cf/cloudflare/clairic"));
});

test("hardening: inherited names, unsafe model ids, and Clef ids are 400s", async () => {
  const { run, calls } = setup();
  const proto = await run({ task: "constructor", state: "x", questions: QUESTIONS });
  assert.equal(proto.status, 400);
  const protoProvider = await run({ target: "__proto__:x", state: "x", questions: QUESTIONS });
  assert.equal(protoProvider.status, 400);
  const traversal = await run({ target: "cloudflare:../../../../user/tokens?x=", state: "x", questions: QUESTIONS });
  assert.equal(traversal.status, 400);
  assert.match(traversal.payload.error, /Invalid model id/);
  const clefId = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", questions: { "a b/?#": QUESTIONS.urgent } });
  assert.equal(clefId.status, 400);
  assert.match(clefId.payload.error, /ids/);
  const badDate = await run({ task: "extract", target: "cloudflare:@cf/cloudflare/clairic", state: "x", fields: { a: { type: "text" } }, options: { reference_date: "2026-02-30" } });
  assert.equal(badDate.status, 400);
  assert.equal(calls.length, 0);
});

test("a body that stalls past the timeout is a 504, not a 500", async () => {
  const config = loadConfig({ OPENROUTER_API_KEY: "k", OPENROUTER_DISCOVER: "0", UPSTREAM_TIMEOUT_MS: "50" });
  const fetchImpl = async (url, init) => ({
    status: 200,
    text: () => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  });
  const run = createRunner({ config, catalog: createCatalog(config), fetchImpl });
  // AbortSignal.timeout does not keep the event loop alive on its own; a real server would.
  const keepAlive = setTimeout(() => {}, 2_000);
  const { status } = await run({ target: "openrouter:typesafe/jev-1.14", state: "x", questions: QUESTIONS });
  clearTimeout(keepAlive);
  assert.equal(status, 504);
});

test("mock answers stay in contract: probabilities and stepped estimates", async () => {
  const { run } = setup({ PLAYGROUND_MOCK: "1" });
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`o${index}`, null]));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { payload } = await run({ target: "cloudflare:@cf/cloudflare/clef", state: "x", questions: { c: { type: "choice", instructions: "pick", criteria } } });
    const values = Object.values(payload.answers.c.probabilities);
    assert.ok(values.every((value) => value >= 0), "no negative probabilities");
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
  }
  const fields = {
    stepped: { type: "estimate", min: 1, max: 2, step: 5 },
    monthly: { type: "estimate", min: "2026-01-15", max: "2026-12-31", step: "month" },
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { payload } = await run({ task: "extract", target: "cloudflare:@cf/cloudflare/clairic", state: "x", fields });
    const stepped = payload.answers.stepped;
    for (const key of ["value", "median", "p10", "p90"]) assert.ok(stepped[key] >= 1 && stepped[key] <= 2, `${key}=${stepped[key]}`);
    const monthly = payload.answers.monthly;
    for (const key of ["median", "p10", "p90"]) {
      assert.ok(monthly[key] >= "2026-01-15" && monthly[key] <= "2026-12-31", `${key}=${monthly[key]}`);
      assert.ok(monthly[key] === "2026-01-15" || monthly[key].endsWith("-01"), `${key}=${monthly[key]} aligned to a month`);
    }
  }
});
