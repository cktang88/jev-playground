import openrouter from "./openrouter.mjs";
import cloudflare from "./cloudflare.mjs";

// Register a new provider by adding its module here. See docs/EXTENDING.md for
// the adapter interface.
export const providers = { [openrouter.id]: openrouter, [cloudflare.id]: cloudflare };
