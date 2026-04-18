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
    name: 'review_comment_category',
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
      },
      required: ['category'],
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
        'You classify GitHub PR review comments.\n\nAlways read the entire comment carefully. Before choosing a category, decide whether the comment actually contains substantive code review feedback about this change (the diff, behavior, structure, tests, security, performance, correctness, clarity, or maintainability).\n\nYou MUST return not_a_review when the comment is not reviewing the code in a substantive way. Examples: thanks-only, LGTM-only, emoji-only, generic praise with no technical point, congratulations, scheduling or process chatter, questions that are not about the code, replies that only agree with someone else without adding a new technical point, meta discussion with no concrete feedback on the patch, duplicate thread noise, or any text where removing politeness leaves nothing about the code.\n\nIf there is any substantive technical feedback (even one sentence) together with thanks, classify by that substance — not as not_a_review.\n\nUse other only when there is real review feedback but it does not fit security, performance, style, logic, best_practice, bug, or readability. Prefer those specific categories when they apply.\n\nOutput JSON only; do not explain.',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with exactly one field named "category".\n\nAllowed category keys:\nnot_a_review\nsecurity\nperformance\nstyle\nlogic\nbest_practice\nbug\nreadability\nother\n\nReview comment:\nPlease cache this expensive selector because it runs on every render.',
    },
    {
      role: 'assistant',
      content: '{"category":"performance"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with exactly one field named "category".\n\nAllowed category keys:\nnot_a_review\nsecurity\nperformance\nstyle\nlogic\nbest_practice\nbug\nreadability\nother\n\nReview comment:\nThis should handle the null case before reading user.profile.name.',
    },
    {
      role: 'assistant',
      content: '{"category":"bug"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with exactly one field named "category".\n\nAllowed category keys:\nnot_a_review\nsecurity\nperformance\nstyle\nlogic\nbest_practice\nbug\nreadability\nother\n\nReview comment:\nThanks! 🙏',
    },
    {
      role: 'assistant',
      content: '{"category":"not_a_review"}',
    },
    {
      role: 'user',
      content:
        'Classify this GitHub review comment and respond as JSON with exactly one field named "category".\n\nAllowed category keys:\nnot_a_review\nsecurity\nperformance\nstyle\nlogic\nbest_practice\nbug\nreadability\nother\n\nReview comment:\nThanks — small nit: could you rename `x` to `userCount`? It is hard to tell what it holds.',
    },
    {
      role: 'assistant',
      content: '{"category":"readability"}',
    },
    {
      role: 'user',
      content: `Classify this GitHub review comment and respond as JSON with exactly one field named "category".

Step 1 — Read the full comment below (every line).
Step 2 — Ask: does it contain substantive feedback about this PR's code (behavior, correctness, structure, tests, security, performance, style, naming, clarity, or maintainability)? If NO → not_a_review.
Step 3 — If YES, pick the best matching substantive category; use other only when feedback is substantive but does not fit the named categories.

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

The JSON must look like {"category":"bug"}. No markdown or extra keys.

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

function parseCategory(rawText) {
  const payload = parseJsonPayload(rawText);

  if (typeof payload === 'string') {
    return matchCategory(payload);
  }

  if (payload && typeof payload.category === 'string') {
    const categoryFromJson = matchCategory(payload.category);
    if (categoryFromJson) {
      return categoryFromJson;
    }
  }

  return matchCategory(rawText);
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

  const cachedCategory = await XtraReviewCache.getCachedCategory(modelId, commentText);
  if (cachedCategory) {
    return { ok: true, category: cachedCategory, cached: true };
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
        max_tokens: 32,
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
    const category = parseCategory(rawText);

    if (!category) {
      return {
        ok: false,
        reason: 'unparseable_response',
        error: rawText || 'The model returned an empty classification.',
      };
    }

    await XtraReviewCache.setCachedCategory(modelId, commentText, category);

    return { ok: true, category };
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
