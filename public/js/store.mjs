// Per-viewer persistence of the editor (task, models, state, items) in localStorage.
// Everything is wrapped so a blocked or empty storage just means a fresh start.

const KEY = "system-one-playground:v2";

export function load() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(snapshot) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or disabled: the editor still works, it just won't be remembered.
  }
}
