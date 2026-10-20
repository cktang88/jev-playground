import { PlaygroundError, badRequest, fail } from "./errors.mjs";
import { errorPayload } from "./http.mjs";
import { providers } from "./providers/index.mjs";
import { redactForPreview, redactHeaders } from "./providers/shared.mjs";
import { tasks } from "./tasks/index.mjs";

// One run = one task against one model. The flow is the same for every provider:
// resolve task and target -> validate input -> check the model can do it ->
// mock or call upstream -> wrap the answers in the standard envelope.

function resolveTask(body) {
  const id = body.task ?? "decide";
  const task = typeof id === "string" && Object.hasOwn(tasks, id) ? tasks[id] : null;
  if (!task) throw badRequest(`Unknown task ${JSON.stringify(id)}.`, `Use one of: ${Object.keys(tasks).join(", ")}.`);
  return task;
}

// Model ids end up in upstream URL paths, so only plain id characters are allowed
// and dot segments (which fetch would resolve) are rejected.
const MODEL_ID = /^[A-Za-z0-9@~._:\-/]{1,200}$/;

function checkModelId(modelId) {
  if (!MODEL_ID.test(modelId) || modelId.split("/").some((segment) => segment === "." || segment === "..")) {
    throw badRequest(`Invalid model id ${JSON.stringify(modelId)}.`, "Use letters, digits and @ ~ . _ : - / only, with no \".\" or \"..\" path segments.");
  }
}

function splitTarget(target) {
  const index = target.indexOf(":");
  return index > 0 ? { providerId: target.slice(0, index), modelId: target.slice(index + 1) } : null;
}

function resolveTarget(body, task, config) {
  if (typeof body.target === "string" && body.target.trim()) {
    const parsed = splitTarget(body.target.trim());
    if (!parsed || !parsed.modelId) throw badRequest("`target` must look like \"provider:model\".", "Example: openrouter:typesafe/jev-1.14");
    return parsed;
  }
  const fallback = splitTarget(config.defaults[task.id]);
  const providerId = typeof body.provider === "string" && body.provider ? body.provider : fallback.providerId;
  const sameProvider = providerId === fallback.providerId;
  const modelId = typeof body.model === "string" && body.model.trim() ? body.model.trim() : sameProvider ? fallback.modelId : "";
  if (!modelId) throw badRequest(`No model given for provider "${providerId}".`, "Send `model`, or `target` as \"provider:model\".");
  return { providerId, modelId };
}

function checkRange(count, range, what) {
  if (!range) return null;
  const [min, max] = range;
  if (count < min || count > max) return `${what} must have ${min}-${max} entries (has ${count}).`;
  return null;
}

// Model-specific limits on top of the task's generic validation.
function checkCapabilities(descriptor, task, input) {
  const label = descriptor.label;
  const ids = Object.keys(input.items);
  const unsupported = ids.filter((id) => !descriptor.types.includes(input.items[id].type));
  if (unsupported.length) {
    const kinds = [...new Set(unsupported.map((id) => input.items[id].type))].join(", ");
    throw badRequest(`${label} does not support ${kinds} ${task.itemNoun}s (${unsupported.join(", ")}).`, `It supports: ${descriptor.types.join(", ")}.`);
  }
  const limits = descriptor.limits || {};
  if (limits.max_items && ids.length > limits.max_items) {
    throw badRequest(`${label} accepts at most ${limits.max_items} ${task.itemNoun}s per request.`, "Split the request in two.");
  }
  if (input.images.length && !descriptor.vision) {
    throw badRequest(`${label} does not accept images.`, "Remove the images or pick a vision model.");
  }
  if (limits.max_images !== undefined && input.images.length > limits.max_images) {
    throw badRequest(`${label} accepts at most ${limits.max_images} images.`, "Remove some images.");
  }
  if (limits.id_pattern) {
    const pattern = new RegExp(limits.id_pattern);
    const bad = ids.filter((id) => !pattern.test(id));
    if (bad.length) throw badRequest(`${label} does not accept these ${task.itemNoun} ids: ${bad.map((id) => JSON.stringify(id)).join(", ")}.`, "Use letters, digits, _ . - only (max 100 characters).");
  }
  for (const id of ids) {
    const item = input.items[id];
    const problem =
      (item.type === "choice" && checkRange(Object.keys(item.criteria).length, limits.choice_options, `For ${label}, choice "${id}"`)) ||
      (item.type === "score" && checkRange(item.criteria.length, limits.score_levels, `For ${label}, score "${id}"`));
    if (problem) throw badRequest(problem, "Adjust the criteria to the model's limits.");
  }
}

function estimateUsage(input) {
  const text = JSON.stringify({ state: input.state, items: input.items });
  return { input_tokens: Math.ceil(text.length / 4) + input.images.length * 258, output_tokens: 0 };
}

function withCost(usage, descriptor) {
  if (typeof usage.cost === "number") return usage;
  const price = descriptor.pricing?.input_per_mtok;
  if (typeof price !== "number") return { ...usage, cost: undefined };
  return { ...usage, cost: Number(((usage.input_tokens * price) / 1e6).toPrecision(4)), cost_estimated: true };
}

function preview(request) {
  return { method: "POST", url: request.url, headers: redactHeaders(request.headers), body: redactForPreview(request.body) };
}

async function callUpstream(request, config, fetchImpl) {
  let response;
  let text;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    // The body read shares the timeout signal, so a stalled body is a timeout too.
    text = await response.text();
  } catch (failure) {
    const timedOut = failure?.name === "AbortError" || failure?.name === "TimeoutError";
    throw timedOut
      ? fail(504, "Upstream request timed out.", "Try again, or simplify the request.")
      : fail(502, "Could not reach the provider.", "Check the server's network access.");
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

export function createRunner({ config, catalog, fetchImpl = fetch }) {
  return async function run(body) {
    const startedAt = Date.now();
    const context = { task: typeof body.task === "string" ? body.task : "decide" };
    try {
      const task = resolveTask(body);
      const { providerId, modelId } = resolveTarget(body, task, config);
      context.task = task.id;
      context.target = `${providerId}:${modelId}`;
      checkModelId(modelId);

      const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : null;
      if (!provider) throw badRequest(`Unknown provider "${providerId}".`, `Use one of: ${Object.keys(providers).join(", ")}.`);
      if (!provider.tasks.includes(task.id)) {
        throw badRequest(`${provider.label} does not serve the ${task.id} task.`, `It serves: ${provider.tasks.join(", ")}.`);
      }

      // Validate before the catalog lookup so bad input never triggers model discovery.
      const input = task.validate(body);
      const descriptor = (await catalog.find(providerId, modelId)) || provider.describeCustom(modelId, task.id);
      if (descriptor.task !== task.id) {
        throw badRequest(`${descriptor.label} is a ${descriptor.task} model, not a ${task.id} model.`, `Switch the task to "${descriptor.task}" or pick another model.`);
      }

      checkCapabilities(descriptor, task, input);
      const providerProblem = provider.validate?.(input, descriptor, task);
      if (providerProblem) throw badRequest(providerProblem.message, providerProblem.hint);

      const request = provider.buildRequest({ task, descriptor, input, config });
      const envelope = {
        ok: true,
        task: task.id,
        target: descriptor.id,
        provider: provider.id,
        label: descriptor.label,
        requested_model: descriptor.model,
      };

      if (config.mock || body.mock === true) {
        return {
          status: 200,
          payload: {
            ...envelope,
            model: descriptor.model,
            answers: task.mockAnswers(input),
            usage: withCost(estimateUsage(input), descriptor),
            meta: task.mockMeta ? task.mockMeta(input) : {},
            latency_ms: Date.now() - startedAt,
            mock: true,
            upstream: preview(request),
          },
        };
      }

      const status = provider.status(config);
      if (!status.configured) {
        throw new PlaygroundError(401, `${provider.label} is not configured (missing ${status.missing.join(", ")}).`, `${status.hint} Or tick "Mock" to try it offline.`);
      }

      const upstream = await callUpstream(request, config, fetchImpl);
      const parsed = provider.parseResponse({ ...upstream, descriptor, task });
      return {
        status: 200,
        payload: {
          ...envelope,
          model: parsed.model || descriptor.model,
          answers: parsed.answers,
          usage: withCost(parsed.usage, descriptor),
          meta: parsed.meta || {},
          latency_ms: Date.now() - startedAt,
          mock: false,
          upstream: preview(request),
        },
      };
    } catch (problem) {
      if (!(problem instanceof PlaygroundError)) console.error(`run failed: ${problem?.stack || problem}`);
      return errorPayload(problem, { ...context, latency_ms: Date.now() - startedAt });
    }
  };
}
