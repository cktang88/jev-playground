// All environment parsing lives here so providers receive plain values and tests
// can build a config without touching process.env.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 4321,
    host: env.HOST || "127.0.0.1",
    mock: env.PLAYGROUND_MOCK === "1" || env.JEV_MOCK === "1",
    timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 60_000,
    defaults: {
      decide: env.DEFAULT_DECIDE_TARGET || `openrouter:${env.OPENROUTER_DECISIONS_MODEL || env.JEV_MODEL || "typesafe/jev-1.14"}`,
      extract: env.DEFAULT_EXTRACT_TARGET || "cloudflare:@cf/cloudflare/clairic",
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || "",
      baseUrl: (env.OPENROUTER_BASE_URL || "https://openrouter.ai").replace(/\/+$/, ""),
      discover: env.OPENROUTER_DISCOVER !== "0",
      referer: env.OPENROUTER_REFERER || "http://localhost",
      title: env.OPENROUTER_TITLE || "System One Playground",
    },
    cloudflare: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID || "",
      apiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_AUTH_TOKEN || "",
      baseUrl: (env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4").replace(/\/+$/, ""),
    },
  };
}
