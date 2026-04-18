// ── Config ──

const CATEGORIES = {
  security: { label: 'Security', color: '#e5534b' },
  performance: { label: 'Performance', color: '#d29922' },
  style: { label: 'Style', color: '#a371f7' },
  logic: { label: 'Logic', color: '#539bf5' },
  best_practice: { label: 'Best Practice', color: '#57ab5a' },
  bug: { label: 'Bug', color: '#f47067' },
  readability: { label: 'Readability', color: '#768390' },
  other: { label: 'Other', color: '#57606a' },
};

const DEFAULT_MODEL_ID = 'arcee-ai/trinity-large-preview:free';
const CATEGORY_TIMEOUT_MS = 30000;
const PROCESSED_ATTR = 'data-xtrareview-processed';
const classificationCache = new Map();

let openrouterApiKey = '';
let modelId = DEFAULT_MODEL_ID;

function loadSettings() {
  return new Promise((resolve) => {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['openrouterApiKey', 'modelId'], (result) => {
        openrouterApiKey = result.openrouterApiKey || '';
        modelId = result.modelId || DEFAULT_MODEL_ID;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const settingsLoaded = loadSettings();

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    let shouldRefresh = false;

    if (changes.openrouterApiKey) {
      openrouterApiKey = changes.openrouterApiKey.newValue || '';
      shouldRefresh = true;
    }

    if (changes.modelId) {
      modelId = changes.modelId.newValue || DEFAULT_MODEL_ID;
      shouldRefresh = true;
    }

    if (shouldRefresh && isPullRequestPage()) {
      resetInjectedState();
      processAllComments();
    }
  });
}

// ── Toast ──

function showToast(message) {
  const existing = document.getElementById('xtrareview-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'xtrareview-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 2500);
}

// ── LLM Classification ──

function requestClassification(commentText) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'xtrareview:classify', commentText },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: 'request_failed',
            error: chrome.runtime.lastError.message,
          });
          return;
        }

        resolve(response || { ok: false, reason: 'request_failed', error: 'No response received.' });
      }
    );
  });
}

function formatClassificationFailure(result) {
  const errorText = result?.error || '';

  if (/receiving end does not exist|extension context invalidated/i.test(errorText)) {
    return {
      text: 'Refresh tab after reload',
      title: 'Reloading the extension orphaned this page script. Refresh the GitHub tab to reconnect it.',
    };
  }

  if (result?.reason === 'auth_error') {
    return {
      text: 'Check API key or model',
      title: errorText || 'OpenRouter rejected the saved API key or model.',
    };
  }

  if (result?.reason === 'api_error') {
    return {
      text: 'OpenRouter error',
      title: errorText || 'OpenRouter could not complete the request.',
    };
  }

  if (result?.reason === 'unsupported_model') {
    return {
      text: 'Change model',
      title: errorText || 'This model does not reliably support strict JSON classification.',
    };
  }

  if (result?.reason === 'unparseable_response') {
    return {
      text: 'Unexpected model response',
      title: errorText || 'The model answered, but not with a usable category.',
    };
  }

  return {
    text: 'Classification unavailable',
    title: errorText || 'The request failed before classification completed.',
  };
}

function getClassification(commentText) {
  const cacheKey = `${modelId}\n${commentText.slice(0, 1000)}`;

  if (!classificationCache.has(cacheKey)) {
    const request = requestClassification(commentText).then((result) => {
      if (!result?.ok && result?.reason !== 'timeout') {
        classificationCache.delete(cacheKey);
      }
      return result;
    });

    classificationCache.set(cacheKey, request);
  }

  return Promise.race([
    classificationCache.get(cacheKey),
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, reason: 'timeout' }), CATEGORY_TIMEOUT_MS);
    }),
  ]);
}

// ── Comment extraction helpers ──

function getTextContent(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '').trim();
}

function getCommentBodyElement(commentEl) {
  // Prefer the outer wrapper so the toolbar sits after the full comment (headings, lists,
  // suggested changes). Matching `.markdown-body` first can grab an inner fragment only.
  return (
    commentEl.querySelector('.comment-body') ||
    commentEl.querySelector('.review-comment-body') ||
    commentEl.querySelector('.markdown-body')
  );
}

function extractFileInfo(commentEl) {
  const fileContainer = commentEl.closest('.file');
  if (fileContainer) {
    const fileHeader = fileContainer.querySelector(
      '.file-header [title], .file-header a[href*="#diff"]'
    );
    if (fileHeader) {
      const filePath = fileHeader.getAttribute('title') || fileHeader.textContent.trim();
      const diffRow = commentEl.closest('tr');
      let lineNum = '';
      if (diffRow) {
        const lineNumCell = diffRow.previousElementSibling
          ? diffRow.previousElementSibling.querySelector('[data-line-number]')
          : null;
        if (lineNumCell) lineNum = lineNumCell.getAttribute('data-line-number');
      }
      return { filePath, lineNum };
    }
  }

  const headerLink = commentEl.querySelector('a[href*="#diff-"], .comment-body a[href*="#diff-"]');
  if (headerLink) {
    return { filePath: headerLink.textContent.trim() || headerLink.getAttribute('href'), lineNum: '' };
  }

  const thread = commentEl.closest(
    '.inline-comment-form-container, .js-resolvable-timeline-thread-container, [id^="diff-"]'
  );
  if (thread) {
    const fileLink = thread.querySelector('a[title], .file-header [title]');
    if (fileLink) {
      return { filePath: fileLink.getAttribute('title') || fileLink.textContent.trim(), lineNum: '' };
    }
  }

  return { filePath: '', lineNum: '' };
}

function extractCodeSnippet(commentEl) {
  const row = commentEl.closest('tr');
  if (row) {
    let prev = row.previousElementSibling;
    const collected = [];
    while (prev && collected.length < 10) {
      const blobCode = prev.querySelector('.blob-code-inner');
      if (blobCode) {
        collected.unshift(getTextContent(blobCode));
      } else {
        break;
      }
      prev = prev.previousElementSibling;
    }
    if (collected.length) return collected.join('\n');
  }

  const suggested = commentEl.querySelector('.js-suggested-changes-blob .blob-code-inner');
  if (suggested) return getTextContent(suggested);

  const codeBlock = commentEl.querySelector('pre code');
  if (codeBlock) return getTextContent(codeBlock);

  return '';
}

function getAuthor(commentEl) {
  const authorLink = commentEl.querySelector('a.author');
  return authorLink ? authorLink.textContent.trim() : 'Unknown';
}

function isReviewComment(commentEl) {
  if (
    commentEl.closest(
      '.js-resolvable-timeline-thread-container, .inline-comment-form-container, [id^="diff-"]'
    )
  ) {
    return true;
  }

  const hasDiffAnchor = !!commentEl.querySelector('a[href*="#diff-"], a[href*="#discussion_r"]');
  if (!hasDiffAnchor) {
    return false;
  }

  const { filePath } = extractFileInfo(commentEl);
  if (!filePath) {
    return false;
  }

  return !!commentEl.closest('.file, [id^="pullrequestreview-"]');
}

// ── Prompt formatting ──

function formatSingleCommentPrompt(comment) {
  const location = comment.filePath
    ? `\`${comment.filePath}${comment.lineNum ? ':' + comment.lineNum : ''}\``
    : '(general comment)';

  const categoryLabel = comment.category
    ? CATEGORIES[comment.category]?.label ?? 'Unknown'
    : 'Unknown';

  const fileExt = comment.filePath ? comment.filePath.split('.').pop() : '';
  const langHint = fileExt ? ` The code is in a \`.${fileExt}\` file.` : '';

  let prompt = `**ROLE:** You are a senior software engineer and patient technical mentor. Your goal is to help a developer deeply understand the lesson behind a code review comment — not just fix it, but internalize the principle so they never make the same mistake again.

**CONTEXT:** During a pull request review on GitHub, a reviewer left a comment on my code. The comment falls under the "${categoryLabel}" category.${langHint} I want to learn from this feedback and grow as a developer.

---

**Reviewer:** ${comment.author}
**File:** ${location}
**Category:** ${categoryLabel}
`;

  if (comment.codeSnippet) {
    prompt += `
**Code under review:**
\`\`\`
${comment.codeSnippet}
\`\`\`
`;
  }

  prompt += `
**Reviewer's comment:**
${comment.body}

---

**INSTRUCTIONS:** Analyze this review comment and teach me the lesson behind it. Be specific and use the actual code shown above in your examples. Structure your response as follows:

1. **What the reviewer is pointing out** — Summarize the issue in plain language. What exactly is wrong or could be improved, and why did the reviewer flag it?

2. **Why this matters in practice** — Explain the real-world consequences. What bugs, performance problems, security risks, or maintenance headaches can this cause? Give a concrete scenario where this would bite a team in production.

3. **The underlying principle** — What software engineering principle, best practice, or design pattern does this relate to? (e.g., Principle of Least Privilege, DRY, defensive programming, immutability, separation of concerns, etc.)

4. **Before & After** — Show a short code example demonstrating the problematic pattern vs. the corrected approach. Use the same language and context from the reviewed code. Annotate with brief comments explaining each change.

5. **How to spot this in future code reviews** — Give me 2–3 concrete signals or patterns I can watch for in my own code so I catch this proactively before a reviewer does.

6. **Related concepts to explore** — List 2–3 related topics, patterns, or tools I should read about to deepen my understanding of this area.

Keep the tone conversational but technically precise. Prioritize practical understanding over theory.`;

  return prompt;
}

// ── UI Injection ──

function createCategoryBadge(category) {
  const badge = document.createElement('span');
  badge.className = 'xtrareview-badge';
  if (category && CATEGORIES[category]) {
    const cat = CATEGORIES[category];
    badge.textContent = cat.label;
    badge.style.backgroundColor = cat.color;
  }
  return badge;
}

function createSpinner() {
  const wrapper = document.createElement('span');
  wrapper.className = 'xtrareview-spinner-wrapper';

  const spinner = document.createElement('span');
  spinner.className = 'xtrareview-spinner';
  wrapper.appendChild(spinner);

  const label = document.createElement('span');
  label.className = 'xtrareview-spinner-label';
  label.textContent = 'Classifying...';
  wrapper.appendChild(label);

  return wrapper;
}

function createMutedHint(text, title = '') {
  const hint = document.createElement('span');
  hint.className = 'xtrareview-no-key';
  hint.textContent = text;
  if (title) hint.title = title;
  return hint;
}

function createActionButton(label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'xtrareview-inline-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* try ClipboardItem path (e.g. some permission / context edge cases) */
  }

  if (typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch {
      /* give up */
    }
  }

  return false;
}

// ── Main injection logic ──

function isPullRequestPage() {
  return /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(location.href);
}

function findAllComments() {
  const selectors = [
    '.review-comment',
    '.js-resolvable-timeline-thread-container .timeline-comment',
    '.js-resolvable-timeline-thread-container .js-comment',
    '.inline-comment-form-container .timeline-comment',
    '.inline-comment-form-container .js-comment',
    '[id^="diff-"] .timeline-comment',
    '[id^="diff-"] .js-comment',
    '[id^="pullrequestreview-"] .timeline-comment',
    '[id^="pullrequestreview-"] .js-comment',
  ];
  return document.querySelectorAll(selectors.join(', '));
}

function resetInjectedState() {
  classificationCache.clear();

  for (const toolbar of document.querySelectorAll('.xtrareview-toolbar')) {
    toolbar.remove();
  }

  for (const comment of findAllComments()) {
    comment.removeAttribute(PROCESSED_ATTR);
    delete comment._xtrareviewCategory;
  }
}

async function processComment(el) {
  if (el.hasAttribute(PROCESSED_ATTR)) return;

  const bodyEl = getCommentBodyElement(el);
  const body = getTextContent(bodyEl);
  if (!body || body.length < 10 || !isReviewComment(el)) {
    el.setAttribute(PROCESSED_ATTR, 'true');
    return;
  }

  if (bodyEl && bodyEl.parentNode.querySelector(':scope > .xtrareview-toolbar')) return;

  el.setAttribute(PROCESSED_ATTR, 'true');

  const author = getAuthor(el);
  const { filePath, lineNum } = extractFileInfo(el);
  const codeSnippet = extractCodeSnippet(el);

  // Show only a spinner while classifying
  const spinnerToolbar = document.createElement('div');
  spinnerToolbar.className = 'xtrareview-toolbar';
  const spinner = createSpinner();
  spinnerToolbar.appendChild(spinner);

  if (bodyEl) {
    bodyEl.parentNode.insertBefore(spinnerToolbar, bodyEl.nextSibling);
  } else {
    el.appendChild(spinnerToolbar);
  }

  if (!openrouterApiKey) {
    spinner.replaceWith(createMutedHint('Set API key to classify'));
    return;
  }

  const result = await getClassification(body);

  if (!spinnerToolbar.isConnected) return;

  // Remove spinner — only build the full toolbar for actionable categories
  spinnerToolbar.remove();

  if (result?.ok && result.category && result.category !== 'not_a_review') {
    el._xtrareviewCategory = result.category;

    const toolbar = document.createElement('div');
    toolbar.className = 'xtrareview-toolbar';

    const header = document.createElement('span');
    header.className = 'xtrareview-toolbar-header';
    header.textContent = 'xtrareview by berto';
    toolbar.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'xtrareview-toolbar-actions';

    const copyBtn = createActionButton('Copy', async () => {
      const ok = await copyToClipboard(body);
      showToast(ok ? 'Copied to clipboard' : 'Could not copy — check clipboard permissions');
    });
    actions.appendChild(copyBtn);

    const learnBtn = createActionButton('Learn', async () => {
      const comment = { author, filePath, lineNum, body, codeSnippet, category: el._xtrareviewCategory };
      const prompt = formatSingleCommentPrompt(comment);
      const ok = await copyToClipboard(prompt);
      showToast(ok ? 'Copied structured prompt to clipboard' : 'Could not copy — check clipboard permissions');
    });
    actions.appendChild(learnBtn);

    actions.appendChild(createCategoryBadge(result.category));

    toolbar.appendChild(actions);

    if (bodyEl) {
      bodyEl.parentNode.insertBefore(toolbar, bodyEl.nextSibling);
    } else {
      el.appendChild(toolbar);
    }
    return;
  }

  // For timeout, not_a_review (skip), or missing key — show nothing
  if (result?.reason === 'timeout' || result?.reason === 'missing_api_key') return;

  // For errors, show a minimal hint
  if (!result?.ok) {
    const hintToolbar = document.createElement('div');
    hintToolbar.className = 'xtrareview-toolbar';
    const failure = formatClassificationFailure(result);
    hintToolbar.appendChild(createMutedHint(failure.text, failure.title));
    if (bodyEl) {
      bodyEl.parentNode.insertBefore(hintToolbar, bodyEl.nextSibling);
    } else {
      el.appendChild(hintToolbar);
    }
  }
}

async function processAllComments() {
  await settingsLoaded;
  if (!isPullRequestPage()) return;

  const comments = findAllComments();
  for (const el of comments) {
    processComment(el);
  }
}

// ── SPA navigation handling ──

let lastUrl = location.href;

function onUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (isPullRequestPage()) {
      resetInjectedState();
      setTimeout(() => {
        processAllComments();
      }, 500);
    }
  }
}

const observer = new MutationObserver(() => {
  onUrlChange();
  if (isPullRequestPage()) {
    processAllComments();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

processAllComments();
