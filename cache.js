// Persistent classification cache backed by chrome.storage.local.
//
// Same comment text + same model = same cached category, so we never
// re-run a classification we have already paid for. Each entry has a
// timestamp so we can expire stale results, and we keep a side-index so
// we can evict the oldest entries when the cache grows too large.

(function (global) {
  const CACHE_KEY_PREFIX = 'xrcache:v1:';
  const CACHE_INDEX_KEY = 'xrcache:v1:__index__';
  const MAX_ENTRIES = 1000;
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  // Match the slice the classifier prompt uses so identical prompts
  // always resolve to the same cache key.
  const COMMENT_KEY_LIMIT = 1000;

  async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function buildKey(modelId, commentText) {
    const normalizedComment = (commentText || '').slice(0, COMMENT_KEY_LIMIT);
    const digest = await sha256Hex(`${modelId}\n${normalizedComment}`);
    return `${CACHE_KEY_PREFIX}${digest}`;
  }

  function hasStorage() {
    return !!(typeof chrome !== 'undefined' && chrome?.storage?.local);
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function getCachedCategory(modelId, commentText) {
    if (!hasStorage() || !modelId || typeof commentText !== 'string') return null;

    let key;
    try {
      key = await buildKey(modelId, commentText);
    } catch {
      return null;
    }

    let stored;
    try {
      stored = await storageGet(key);
    } catch {
      return null;
    }

    const entry = stored?.[key];
    if (!entry || typeof entry.category !== 'string') return null;

    if (entry.ts && Date.now() - entry.ts > TTL_MS) {
      try {
        await storageRemove(key);
      } catch {
        /* best effort */
      }
      return null;
    }

    return entry.category;
  }

  async function setCachedCategory(modelId, commentText, category) {
    if (!hasStorage() || !modelId || typeof commentText !== 'string' || !category) return;

    let key;
    try {
      key = await buildKey(modelId, commentText);
    } catch {
      return;
    }

    const entry = { category, ts: Date.now() };

    try {
      const indexResult = await storageGet(CACHE_INDEX_KEY);
      const existingIndex = Array.isArray(indexResult?.[CACHE_INDEX_KEY])
        ? indexResult[CACHE_INDEX_KEY]
        : [];

      const nextIndex = existingIndex.filter((existingKey) => existingKey !== key);
      nextIndex.push(key);

      const evicted = [];
      while (nextIndex.length > MAX_ENTRIES) {
        const oldest = nextIndex.shift();
        if (oldest) evicted.push(oldest);
      }

      await storageSet({ [key]: entry, [CACHE_INDEX_KEY]: nextIndex });

      if (evicted.length) {
        await storageRemove(evicted);
      }
    } catch {
      /* best effort */
    }
  }

  async function clearCache() {
    if (!hasStorage()) return;

    try {
      const all = await storageGet(null);
      const cacheKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_KEY_PREFIX));
      if (cacheKeys.length) {
        await storageRemove(cacheKeys);
      }
    } catch {
      /* best effort */
    }
  }

  global.XtraReviewCache = {
    getCachedCategory,
    setCachedCategory,
    clearCache,
  };
})(typeof self !== 'undefined' ? self : globalThis);
