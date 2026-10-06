/**
 * Storage that cannot crash the app.
 *
 * Browsers throw SecurityError on `localStorage` access in sandboxed or
 * third-party iframes and in some private-browsing configurations. A messaging
 * app that dies on the splash screen because of that is worse than one that
 * simply does not persist its session across reloads, so every access here is
 * guarded and falls back to an in-memory map. Callers keep working unchanged;
 * they just lose persistence in hostile embeddings.
 */
const memory = new Map<string, string>();

let backend: Storage | null | undefined;

function resolveBackend(): Storage | null {
  if (backend !== undefined) return backend;
  try {
    const probe = '__vesper_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backend = window.localStorage;
  } catch {
    backend = null;
  }
  return backend;
}

export const safeStorage = {
  get persistent(): boolean {
    return resolveBackend() !== null;
  },
  getItem(key: string): string | null {
    const s = resolveBackend();
    if (s) {
      try { return s.getItem(key); } catch { /* fall through */ }
    }
    return memory.has(key) ? memory.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    const s = resolveBackend();
    if (s) {
      try { s.setItem(key, value); return; } catch { /* fall through */ }
    }
    memory.set(key, value);
  },
  removeItem(key: string): void {
    const s = resolveBackend();
    if (s) {
      try { s.removeItem(key); return; } catch { /* fall through */ }
    }
    memory.delete(key);
  },
};
