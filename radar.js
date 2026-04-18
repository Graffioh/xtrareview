// Recurring Feedback Radar storage.
//
// Tracks normalized "lessons" extracted from PR review comments on PRs the
// signed-in user authored, so the extension can surface recurring patterns
// across all of the user's pull requests.
//
// All data lives in chrome.storage.local under the "xrradar:v1:" namespace.
// Three keys are used:
//   - xrradar:v1:entries  → array of recent comment entries (FIFO + TTL).
//                           Source of truth for example links and timeline UI.
//   - xrradar:v1:byId     → map of { entryId: ts } for O(1) dedup of comments.
//   - xrradar:v1:library  → permanent aggregate map keyed by lessonKey.
//                           Holds { lesson, count, firstSeenTs, lastSeenTs,
//                           categories, examples }. NEVER expires and is the
//                           durable record of recurring lessons even after the
//                           raw entries roll off via FIFO/TTL eviction.
//
// Entry shape:
//   {
//     id, ts,
//     repo, prNumber, prTitle,
//     commentId, reviewer,
//     category,
//     lesson,       // raw lesson string from the LLM
//     lessonKey,    // normalized form used for grouping
//     filePath, fileExt, directory
//   }
//
// Library bucket shape (per lessonKey):
//   {
//     lesson,        // most recent raw lesson text
//     count,         // total times this lesson has ever been recorded
//     firstSeenTs,
//     lastSeenTs,
//     categories: { [category]: count },
//     examples: [    // up to LIBRARY_EXAMPLE_LIMIT, newest first
//       { id, ts, repo, prNumber, prTitle, commentId, filePath, category }
//     ]
//   }

(function (global) {
  const ENTRIES_KEY = 'xrradar:v1:entries';
  const BY_ID_KEY = 'xrradar:v1:byId';
  const LIBRARY_KEY = 'xrradar:v1:library';
  const RADAR_KEY_PREFIX = 'xrradar:v1:';
  const MAX_ENTRIES = 2000;
  const TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const LIBRARY_EXAMPLE_LIMIT = 5;

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

  function normalizeLesson(text) {
    if (typeof text !== 'string') return '';
    return text
      .toLowerCase()
      .replace(/[`"'.,;:!?()[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function deriveDirectory(filePath) {
    if (typeof filePath !== 'string' || !filePath) return '';
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
  }

  function deriveFileExt(filePath) {
    if (typeof filePath !== 'string') return '';
    const fileName = filePath.split('/').pop() || '';
    const dotIdx = fileName.lastIndexOf('.');
    if (dotIdx <= 0 || dotIdx === fileName.length - 1) return '';
    return fileName.slice(dotIdx + 1).toLowerCase();
  }

  function buildEntryId(repo, prNumber, commentId) {
    return `${repo || '?'}#${prNumber || '?'}::${commentId || '?'}`;
  }

  function pruneExpired(entries, byId) {
    const now = Date.now();
    const kept = [];
    const nextById = { ...byId };

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.ts && now - entry.ts > TTL_MS) {
        delete nextById[entry.id];
        continue;
      }
      kept.push(entry);
    }

    return { entries: kept, byId: nextById };
  }

  async function loadAll() {
    if (!hasStorage()) return { entries: [], byId: {}, library: {} };

    let stored;
    try {
      stored = await storageGet([ENTRIES_KEY, BY_ID_KEY, LIBRARY_KEY]);
    } catch {
      return { entries: [], byId: {}, library: {} };
    }

    const entries = Array.isArray(stored?.[ENTRIES_KEY]) ? stored[ENTRIES_KEY] : [];
    const byId =
      stored?.[BY_ID_KEY] && typeof stored[BY_ID_KEY] === 'object' ? stored[BY_ID_KEY] : {};
    const library =
      stored?.[LIBRARY_KEY] && typeof stored[LIBRARY_KEY] === 'object'
        ? stored[LIBRARY_KEY]
        : {};
    return { entries, byId, library };
  }

  async function saveAll(entries, byId, library) {
    if (!hasStorage()) return;
    try {
      const payload = { [ENTRIES_KEY]: entries, [BY_ID_KEY]: byId };
      if (library) payload[LIBRARY_KEY] = library;
      await storageSet(payload);
    } catch {
      /* best effort */
    }
  }

  function updateLibraryWithEntry(library, entry) {
    const key = entry.lessonKey;
    const existing =
      library[key] && typeof library[key] === 'object'
        ? library[key]
        : {
            lesson: entry.lesson,
            count: 0,
            firstSeenTs: entry.ts,
            lastSeenTs: entry.ts,
            categories: {},
            examples: [],
          };

    existing.count = (existing.count || 0) + 1;
    if (!existing.firstSeenTs || entry.ts < existing.firstSeenTs) {
      existing.firstSeenTs = entry.ts;
    }
    if (!existing.lastSeenTs || entry.ts > existing.lastSeenTs) {
      existing.lastSeenTs = entry.ts;
      // Prefer the most recent raw lesson variant for display.
      if (entry.lesson) existing.lesson = entry.lesson;
    }

    if (entry.category) {
      existing.categories = existing.categories || {};
      existing.categories[entry.category] = (existing.categories[entry.category] || 0) + 1;
    }

    const examples = Array.isArray(existing.examples) ? existing.examples : [];
    const dedupedExamples = examples.filter((ex) => ex && ex.id !== entry.id);
    dedupedExamples.unshift({
      id: entry.id,
      ts: entry.ts,
      repo: entry.repo,
      prNumber: entry.prNumber,
      prTitle: entry.prTitle,
      commentId: entry.commentId,
      filePath: entry.filePath,
      category: entry.category,
    });
    existing.examples = dedupedExamples.slice(0, LIBRARY_EXAMPLE_LIMIT);

    library[key] = existing;
    return library;
  }

  async function recordComment(input) {
    if (!hasStorage() || !input || typeof input !== 'object') return null;

    const lesson = typeof input.lesson === 'string' ? input.lesson.trim() : '';
    if (!lesson) return null;

    const repo = typeof input.repo === 'string' ? input.repo : '';
    const prNumber = input.prNumber ?? '';
    const commentId = typeof input.commentId === 'string' ? input.commentId : '';
    if (!repo || !prNumber || !commentId) return null;

    const id = buildEntryId(repo, prNumber, commentId);
    const lessonKey = normalizeLesson(lesson);
    if (!lessonKey) return null;

    const filePath = typeof input.filePath === 'string' ? input.filePath : '';
    const entry = {
      id,
      ts: Date.now(),
      repo,
      prNumber,
      prTitle: typeof input.prTitle === 'string' ? input.prTitle : '',
      commentId,
      reviewer: typeof input.reviewer === 'string' ? input.reviewer : '',
      category: typeof input.category === 'string' ? input.category : 'other',
      lesson,
      lessonKey,
      filePath,
      fileExt: deriveFileExt(filePath),
      directory: deriveDirectory(filePath),
    };

    const fresh = await loadAll();
    const pruned = pruneExpired(fresh.entries, fresh.byId);
    const library = fresh.library && typeof fresh.library === 'object' ? fresh.library : {};

    if (pruned.byId[id]) {
      // Already counted this exact comment in the library too — keep idempotent.
      return entry;
    }

    pruned.entries.push(entry);
    pruned.byId[id] = entry.ts;

    while (pruned.entries.length > MAX_ENTRIES) {
      const dropped = pruned.entries.shift();
      if (dropped?.id) delete pruned.byId[dropped.id];
    }

    updateLibraryWithEntry(library, entry);

    await saveAll(pruned.entries, pruned.byId, library);
    return entry;
  }

  async function getRecurrenceForLesson(lessonKey) {
    if (!hasStorage() || !lessonKey) {
      return { count: 0, lastSeenTs: 0, exampleEntries: [] };
    }

    const { library } = await loadAll();
    const bucket = library?.[lessonKey];
    if (!bucket) {
      return { count: 0, lastSeenTs: 0, exampleEntries: [] };
    }

    const examples = Array.isArray(bucket.examples) ? bucket.examples.slice(0, 3) : [];
    return {
      count: bucket.count || 0,
      lastSeenTs: bucket.lastSeenTs || 0,
      exampleEntries: examples,
    };
  }

  async function getAllStats() {
    if (!hasStorage()) {
      return {
        totalEntries: 0,
        totalLessons: 0,
        lessons: [],
        byCategory: {},
        byDirectory: {},
        byFileExt: {},
      };
    }

    const { entries, byId, library } = await loadAll();
    const pruned = pruneExpired(entries, byId);

    if (pruned.entries.length !== entries.length) {
      // Persist the prune so we do not keep recomputing it on every popup open.
      await saveAll(pruned.entries, pruned.byId, library);
    }

    const byDirectory = {};
    const byFileExt = {};
    for (const entry of pruned.entries) {
      if (entry.directory) {
        byDirectory[entry.directory] = (byDirectory[entry.directory] || 0) + 1;
      }
      if (entry.fileExt) {
        byFileExt[entry.fileExt] = (byFileExt[entry.fileExt] || 0) + 1;
      }
    }

    const byCategory = {};
    const lessons = [];
    let totalRecorded = 0;

    for (const [lessonKey, bucket] of Object.entries(library || {})) {
      if (!bucket || typeof bucket !== 'object') continue;
      const count = bucket.count || 0;
      totalRecorded += count;

      for (const [cat, n] of Object.entries(bucket.categories || {})) {
        byCategory[cat] = (byCategory[cat] || 0) + n;
      }

      const examples = Array.isArray(bucket.examples) ? bucket.examples.slice() : [];
      examples.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      lessons.push({
        lessonKey,
        lesson: bucket.lesson || lessonKey,
        count,
        firstSeenTs: bucket.firstSeenTs || 0,
        lastSeenTs: bucket.lastSeenTs || 0,
        examples,
      });
    }

    lessons.sort((a, b) => b.count - a.count || b.lastSeenTs - a.lastSeenTs);

    return {
      totalEntries: totalRecorded,
      totalLessons: lessons.length,
      lessons,
      byCategory,
      byDirectory,
      byFileExt,
    };
  }

  async function clearHistory() {
    if (!hasStorage()) return;
    try {
      const all = await storageGet(null);
      const radarKeys = Object.keys(all).filter((k) => k.startsWith(RADAR_KEY_PREFIX));
      if (radarKeys.length) {
        await storageRemove(radarKeys);
      }
    } catch {
      /* best effort */
    }
  }

  global.XtraReviewRadar = {
    normalizeLesson,
    deriveDirectory,
    deriveFileExt,
    recordComment,
    getRecurrenceForLesson,
    getAllStats,
    clearHistory,
  };
})(typeof self !== 'undefined' ? self : globalThis);
