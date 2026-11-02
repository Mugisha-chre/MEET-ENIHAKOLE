// Small shared cache used for cache-first (stale-while-revalidate) data: memory first, localStorage as the persistent layer.
// Reads are synchronous so a page can render cached content on its very first paint, then refresh quietly in the background.
const PREFIX = "meet-enihakole-cache:";
const memory = new Map<string, { value: unknown; savedAt: number }>();

export function readCache<T>(key: string): { value: T; savedAt: number } | null {
  const hit = memory.get(key);
  if (hit) return hit as { value: T; savedAt: number };
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; savedAt: number };
    memory.set(key, parsed);
    return parsed;
  } catch { return null; }
}

export function writeCache<T>(key: string, value: T): void {
  const entry = { value, savedAt: Date.now() };
  memory.set(key, entry);
  try { localStorage.setItem(PREFIX + key, JSON.stringify(entry)); } catch { /* Storage can be full or blocked; memory cache still works. */ }
}

export function removeCache(key: string): void {
  memory.delete(key);
  try { localStorage.removeItem(PREFIX + key); } catch { /* Nothing to clear. */ }
}

export function clearCachePrefix(prefix: string): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX + prefix)) localStorage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}

// Apply an in-place change to every cached entry whose key matches (used for instant, optimistic updates).
export function patchCache<T>(match: (key: string) => boolean, patch: (value: T) => T): void {
  const keys = new Set<string>(memory.keys());
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) keys.add(key.slice(PREFIX.length)); } catch { /* Memory entries still patched. */ }
  for (const key of keys) {
    if (!match(key)) continue;
    const hit = readCache<T>(key);
    if (hit) writeCache(key, patch(hit.value));
  }
}
