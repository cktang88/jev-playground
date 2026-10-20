// Thin client for the playground server. Never throws on HTTP errors: every call
// resolves to the server's JSON envelope (or a synthesized one for network errors).

async function request(path, init) {
  try {
    const response = await fetch(path, init);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, error: `Server returned non-JSON (${response.status}).`, details: { body: text.slice(0, 500) } };
    }
  } catch (failure) {
    return { ok: false, status: 0, error: "Could not reach the playground server.", hint: `Is server.mjs running? (${failure.message})` };
  }
}

export function getCatalog({ refresh = false } = {}) {
  return request(`/api/catalog${refresh ? "?refresh=1" : ""}`);
}

export function run(body) {
  return request("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
