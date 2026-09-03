const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();

function prune(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function runImageOperationOnce<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const now = Date.now();
  prune(now);
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = operation().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, promise });
  return promise;
}

export function clearImageOperationCacheForTests() {
  cache.clear();
}
