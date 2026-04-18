importScripts('cache.js');

const DEFAULT_MODEL_ID = 'arcee-ai/trinity-large-preview:free';
const FETCH_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_CLASSIFICATIONS = 2;
const TEST_COMMENT = 'This should handle the null case before reading user.profile.name.';

const CATEGORY_ALIASES = {
  not_a_review: ['not a review', 'not review', 'non review'],
  security: ['security'],
  performance: ['performance'],
  style: ['style'],
  logic: ['logic'],
  best_practice: ['best practice', 'best_practice', 'best-practice', 'best practices'],
  bug: ['bug', 'bugs'],
  readability: ['readability', 'readable'],
  other: ['other'],
};

const CATEGORY_KEYS = Object.keys(CATEGORY_ALIASES);
const CLASSIFICATION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'review_comment_classification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'After reading the full comment: use not_a_review when there is no substantive feedback about the code or PR; otherwise pick the best substantive category or other.',
          enum: CATEGORY_KEYS,
        },
        lesson: {
          type: 'string',
          description:
            'A short, generic, code-pattern-oriented lesson distilled from the comment, written in imperative voice (e.g. "Avoid optional ? when value is always required", "Add doc comments to .md files"). Max 80 characters. Do not include PR-specific names, file paths, or quoted code. Use an empty string when category is not_a_review.',
        },
      },
      required: ['category', 'lesson'],
      additionalProperties: false,
    },
  },
};

const classificationQueue = [];
let activeClassifications = 0;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['openrouterApiKey', 'modelId'], (result) => {
      resolve({
        openrouterApiKey: result.openrouterApiKey || '',
        modelId: result.modelId || DEFAULT_MODEL_ID,
      });
    });
  });
}

function enqueueClassification(task) {
  return new Promise((resolve, reject) => {
    classificationQueue.push({ task, resolve, reject });
    runNextClassification();
  });
}

function runNextClassification() {
  if (activeClassifications >= MAX_CONCURRENT_CLASSIFICATIONS) return;

  const nextJob = classificationQueue.shift();
  if (!nextJob) return;

  activeClassifications += 1;

  nextJob.task()
    .then(nextJob.resolve, nextJob.reject)
    .finally(() => {
      activeClassifications -= 1;
      runNextClassification();
    });
}

function buildClassificationMessages(commentText) {
  const trimmedComment = commentText.slice(0, 1000);

  return [
    {
      role: 'system',
      content:
        'You classify GitHub PR review comments AND distill a short, reusable lesson from each.\n\nAlways read the entire comment carefully. Before choosing a category, decide whether the comment actually contains substantive code review feedback about this change (the diff, behavior, structure, tests, security, performance, correctness, clarity, or maintainability).\n\nYou MUST return not_a_review when the comment is not reviewing the code in a substantive way. Examples: thanks-only, LGTM-only, emoji-only, generic praise with no technical point, congratulations, scheduling or process chatter, questions that are not about the code, replies that only agree with someone else without adding a new technical point, meta discussion with no concrete feedback on the patch, duplicate thread noise, or any text where removing politeness leaves nothing about the code.\n\nIf there is any substantive technical feedback (even one sentence) together with thanks, classify by that substance — not as not_a_review.\n\nUse other only when there is real review feedback but it does not fit security, performance, style, logic, best_practice, bug, or readability. Prefer those specific categories when they apply.\n\nLESSON RULES:\n- The "lesson" is a short, HIGH-LEVEL programming principle distilled from the comment, written in IMPERATIVE voice. Max 80 characters. No trailing period.\n- The lesson must be language-agnostic and framework-agnostic. Map every comment to a well-known engineering concept that applies to ANY codebase, such as: defensive programming, input validation, null/error handling, intention-revealing naming, single responsibility, separation of concerns, loose coupling, encapsulation, immutability, type safety, documentation, testing, caching/memoization, performance on hot paths, security/sanitization, idempotency, dependency hygiene, API consistency, observability/logging.\n- Start with a verb such as Avoid, Prefer, Always, Use, Validate, Handle, Guard, Document, Encapsulate, Decouple, Separate, Cache, Sanitize, Test, Match, Import, Remove, Rename, Extract.\n- DO NOT include any project-specific or syntax-specific detail: language tokens (`?`, `??`, `!`, `=>`, decorators), framework names, library names, file paths, type names, class names, function names, variable names, or quoted code.\n- The lesson must be so general that ANY developer in ANY language could apply it. Two reviewers describing the same underlying mistake — even in different languages or repos — must produce the same lesson.\n- Prefer canonical phrasings of well-known principles over novel wording, so identical underlying lessons collapse into one bucket.\n- When category is not_a_review, lesson MUST be an empty string "".\n\nOutput JSON only; do not explain.',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nPlease cache this expensive selector because it runs on every render.',
    },
    {
      role: 'assistant',
      content: '{"category":"performance","lesson":"Cache expensive computations on hot paths"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nThis should handle the null case before reading user.profile.name.',
    },
    {
      role: 'assistant',
      content: '{"category":"bug","lesson":"Guard against null before accessing nested values"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nThanks! 🙏',
    },
    {
      role: 'assistant',
      content: '{"category":"not_a_review","lesson":""}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nThanks — small nit: could you rename `x` to `userCount`? It is hard to tell what it holds.',
    },
    {
      role: 'assistant',
      content: '{"category":"readability","lesson":"Use intention-revealing names"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nThe ToolOutputV2 type is used as the return type for the execute function but is not imported in this file. This will cause a compilation error.',
    },
    {
      role: 'assistant',
      content: '{"category":"bug","lesson":"Import every symbol referenced in public APIs"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nThis field is marked optional with `?` but every code path sets it. Drop the `?` so the type matches reality.',
    },
    {
      role: 'assistant',
      content: '{"category":"best_practice","lesson":"Keep type definitions honest about runtime contracts"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".\n\nReview comment:\nWe should sanitize this user-supplied string before interpolating it into the SQL query — otherwise it is open to injection.',
    },
    {
      role: 'assistant',
      content: '{"category":"security","lesson":"Sanitize untrusted input before composing queries"}',
    },
    {
      role: 'user',
      content: `Classify this GitHub review comment and respond as JSON with two fields: "category" and "lesson".

Step 1 — Read the full comment below (every line).
Step 2 — Ask: does it contain substantive feedback about this PR's code (behavior, correctness, structure, tests, security, performance, style, naming, clarity, or maintainability)? If NO → category=not_a_review and lesson="".
Step 3 — If YES, pick the best matching substantive category; use other only when feedback is substantive but does not fit the named categories.
Step 4 — Distill the takeaway into a HIGH-LEVEL, language-agnostic programming principle (imperative voice). Map it to a well-known engineering concept (defensive programming, naming clarity, separation of concerns, type safety, sanitization, caching, etc.). Strip ALL project-specific or syntax-specific detail (no language tokens, framework names, file paths, type/function/variable names, or quoted code). Max 80 chars, no trailing period.

Categories:
- not_a_review: No substantive code review in this comment (see system rules). Default here when the comment is purely social, meta, empty of technical content, or does not address the change.
- security: Security vulnerabilities, auth issues, data exposure
- performance: Performance bottlenecks, optimization opportunities
- style: Code style, formatting, naming conventions
- logic: Logic errors, incorrect conditions, wrong algorithms
- best_practice: Design patterns, idiomatic code, better approaches
- bug: Actual bugs, crashes, undefined behavior
- readability: Code clarity, documentation, comments
- other: Substantive review feedback that still does not fit the categories above

The JSON must look like {"category":"bug","lesson":"Handle null before dereferencing nested fields"}. No markdown or extra keys.

Review comment:
${trimmedComment}`,
    },
  ];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonPayload(rawText) {
  const text = (rawText || '').trim();
  if (!text) return null;

  const candidates = [text];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1]);
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0] && objectMatch[0] !== text) {
    candidates.push(objectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying looser candidates.
    }
  }

  return null;
}

function matchCategory(rawText) {
  const normalized = (rawText || '').toLowerCase().replace(/[-_]+/g, ' ');

  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    for (const alias of [category, ...aliases]) {
      const normalizedAlias = alias.toLowerCase().replace(/[-_]+/g, ' ');
      const pattern = new RegExp(`\\b${escapeRegExp(normalizedAlias).replace(/\s+/g, '\\s+')}\\b`, 'i');
      if (pattern.test(normalized)) {
        return category;
      }
    }
  }

  return null;
}

function normalizeLessonText(rawLesson) {
  if (typeof rawLesson !== 'string') return '';

  return rawLesson
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:,!?-]+$/g, '')
    .trim()
    .slice(0, 200);
}

function parseClassification(rawText) {
  const payload = parseJsonPayload(rawText);

  if (typeof payload === 'string') {
    const category = matchCategory(payload);
    return category ? { category, lesson: '' } : null;
  }

  if (payload && typeof payload === 'object') {
    const categoryFromJson = matchCategory(payload.category);
    if (categoryFromJson) {
      const lesson =
        categoryFromJson === 'not_a_review' ? '' : normalizeLessonText(payload.lesson);
      return { category: categoryFromJson, lesson };
    }
  }

  const fallbackCategory = matchCategory(rawText);
  return fallbackCategory ? { category: fallbackCategory, lesson: '' } : null;
}

function getResponseText(data) {
  const firstChoice = data?.choices?.[0];
  if (!firstChoice) return '';

  const messageContent = firstChoice.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent.trim();
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }

  return (firstChoice.text || '').trim();
}

function buildErrorMessage(errorLike, fallbackMessage, modelId) {
  const message = errorLike?.message || fallbackMessage;
  const metadata = errorLike?.metadata;
  const details = [];

  if (metadata?.provider_name) {
    details.push(`provider: ${metadata.provider_name}`);
  }

  if (metadata?.raw) {
    details.push(`details: ${metadata.raw}`);
  } else if (metadata?.raw_error) {
    details.push(`details: ${metadata.raw_error}`);
  }

  if (metadata?.moderation_response) {
    details.push(`details: ${JSON.stringify(metadata.moderation_response)}`);
  }

  if (/provider returned error/i.test(message) && modelId) {
    return [`${message} for ${modelId}.`, ...details].join(' ');
  }

  return [message, ...details].filter(Boolean).join(' ');
}

function isUnsupportedModelError(errorText) {
  const normalized = errorText || '';

  return (
    (/response_format|json_schema|structured outputs?|structured output/i.test(normalized) &&
      /unsupported|no endpoints found|not support|doesn't support|does not support|required/i.test(normalized)) ||
    /no endpoints found that support/i.test(normalized)
  );
}

function getApiErrorResult(status, errorText) {
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'auth_error', error: errorText };
  }

  if (isUnsupportedModelError(errorText)) {
    return {
      ok: false,
      reason: 'unsupported_model',
      error: 'This model does not reliably support strict JSON classification. Choose a different model.',
    };
  }

  return { ok: false, reason: 'api_error', error: errorText };
}

async function classifyComment(commentText) {
  const { openrouterApiKey, modelId } = await loadSettings();

  if (!openrouterApiKey) {
    return { ok: false, reason: 'missing_api_key' };
  }

  const cached = await XtraReviewCache.getCachedClassification(modelId, commentText);
  if (cached) {
    return { ok: true, category: cached.category, lesson: cached.lesson || '', cached: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterApiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'xtrareview',
      },
      body: JSON.stringify({
        model: modelId,
        messages: buildClassificationMessages(commentText),
        provider: {
          require_parameters: true,
        },
        response_format: CLASSIFICATION_RESPONSE_FORMAT,
        plugins: [{ id: 'response-healing' }],
        max_tokens: 96,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return getApiErrorResult(
        res.status,
        buildErrorMessage(
          data?.error || data?.choices?.[0]?.error,
          `Request failed with status ${res.status}`,
          modelId
        )
      );
    }

    const choiceError = data?.choices?.find((choice) => choice?.error)?.error;
    if (choiceError) {
      return getApiErrorResult(
        500,
        buildErrorMessage(choiceError, 'The model could not classify this comment.', modelId)
      );
    }

    const rawText = getResponseText(data);
    const classification = parseClassification(rawText);

    if (!classification) {
      return {
        ok: false,
        reason: 'unparseable_response',
        error: rawText || 'The model returned an empty classification.',
      };
    }

    await XtraReviewCache.setCachedClassification(
      modelId,
      commentText,
      classification.category,
      classification.lesson
    );

    return { ok: true, category: classification.category, lesson: classification.lesson };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }

    return {
      ok: false,
      reason: 'request_failed',
      error: error?.message || 'The request failed before classification completed.',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'xtrareview:test-api') {
    enqueueClassification(() => classifyComment(TEST_COMMENT))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          reason: 'request_failed',
          error: error?.message || 'Unexpected background classification failure.',
        });
      });

    return true;
  }

  if (message?.type !== 'xtrareview:classify' || typeof message.commentText !== 'string') {
    return false;
  }

  enqueueClassification(() => classifyComment(message.commentText))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        reason: 'request_failed',
        error: error?.message || 'Unexpected background classification failure.',
      });
    });

  return true;
});
