// Every failure the playground reports travels as a PlaygroundError so the HTTP
// layer can turn it into the standard `{ ok: false, error, status, hint }` envelope.
export class PlaygroundError extends Error {
  constructor(status, message, hint, details) {
    super(message);
    this.name = "PlaygroundError";
    this.status = status;
    this.hint = hint;
    this.details = details;
  }
}

export function fail(status, message, hint, details) {
  return new PlaygroundError(status, message, hint, details);
}

export function badRequest(message, hint) {
  return new PlaygroundError(400, message, hint);
}
