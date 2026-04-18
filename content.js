// ── Config ──

const CATEGORIES = {
  security: { label: 'Security', color: '#e5534b' },
  performance: { label: 'Performance', color: '#d29922' },
  style: { label: 'Style', color: '#a371f7' },
  logic: { label: 'Logic', color: '#539bf5' },
  best_practice: { label: 'Best Practice', color: '#57ab5a' },
  bug: { label: 'Bug', color: '#f47067' },
  readability: { label: 'Readability', color: '#768390' },
  other: { label: 'Other', color: '#49515a' },
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

// ── PR author detection (for radar) ──

function getCurrentGithubUser() {
  const meta = document.querySelector('meta[name="user-login"]');
  const login = meta?.getAttribute('content');
  return typeof login === 'string' ? login.trim() : '';
}

function getPrAuthorLogin() {
  // The PR description is always the first comment in the discussion timeline,
  // and it is authored by the PR author. GitHub marks that author link with
  // itemprop="author" — that has been stable across the legacy and current
  // PR layouts, while the older `.gh-header-meta a.author` selector no longer
  // matches reliably on every PR (especially merged ones, where the header
  // link is the merger, not the author).
  const candidates = [
    '.js-discussion [itemprop="author"]',
    '.js-discussion .timeline-comment-header a.author',
    '[itemprop="author"]',
    '.gh-header-meta a.author',
    '.gh-header-meta .author',
    '[data-testid="header-author"] a',
  ];

  for (const selector of candidates) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.trim();
    if (text) return text;
  }

  // Last-resort fallback: the very first author link anywhere in the
  // discussion stream is the PR description's author.
  const fallback = document.querySelector('.js-discussion a.author');
  return fallback?.textContent?.trim() || '';
}

function getPrCoordinates() {
  const match = location.href.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    prNumber: Number(match[3]),
  };
}

function getPrTitle() {
  const titleEl =
    document.querySelector('.js-issue-title') ||
    document.querySelector('bdi.js-issue-title') ||
    document.querySelector('h1 .js-issue-title');
  return titleEl?.textContent?.trim() || '';
}

let isAuthorPrCache = { url: '', value: false };

function isAuthorOfCurrentPr() {
  if (isAuthorPrCache.url === location.href) {
    return isAuthorPrCache.value;
  }

  const me = getCurrentGithubUser();
  const prAuthor = getPrAuthorLogin();

  // Only cache once both signals are available; otherwise re-check next call so
  // we do not lock in `false` while GitHub is still hydrating the PR header.
  if (!me || !prAuthor) {
    return false;
  }

  const value = me.toLowerCase() === prAuthor.toLowerCase();
  isAuthorPrCache = { url: location.href, value };
  return value;
}

function extractCommentAnchorId(commentEl) {
  if (commentEl.id && /^(discussion_r|issuecomment-|pullrequestreview-)/.test(commentEl.id)) {
    return commentEl.id;
  }

  const anchored = commentEl.closest('[id^="discussion_r"], [id^="issuecomment-"]');
  if (anchored?.id) return anchored.id;

  const permalink = commentEl.querySelector(
    'a[href*="#discussion_r"], a[href*="#issuecomment-"]'
  );
  if (permalink) {
    const href = permalink.getAttribute('href') || '';
    const idx = href.lastIndexOf('#');
    if (idx >= 0) return href.slice(idx + 1);
  }

  return commentEl.id || '';
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

function formatRelativeTime(ts) {
  if (!ts) return 'unknown';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function createRecurrenceChip({ count, lesson, lastSeenTs }) {
  const safeCount = Math.max(1, count || 1);
  const chip = document.createElement('span');
  chip.className = 'xtrareview-recurrence-chip';
  if (safeCount >= 2) chip.classList.add('xtrareview-recurrence-chip--recurring');
  const seenLabel = safeCount === 1 ? 'Seen 1 time' : `Seen ${safeCount} times`;
  chip.title = `${lesson}\n\n${seenLabel}\nLast seen: ${formatRelativeTime(lastSeenTs)}`;

  const countEl = document.createElement('span');
  countEl.className = 'xtrareview-recurrence-chip__count';
  countEl.textContent = `${safeCount}×`;
  chip.appendChild(countEl);

  const sep = document.createElement('span');
  sep.className = 'xtrareview-recurrence-chip__sep';
  sep.textContent = '·';
  chip.appendChild(sep);

  const lessonEl = document.createElement('span');
  lessonEl.className = 'xtrareview-recurrence-chip__lesson';
  lessonEl.textContent = lesson;
  chip.appendChild(lessonEl);

  return chip;
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

function createActionButton(label, onClick, variant = '') {
  const btn = document.createElement('button');
  btn.className = variant
    ? `xtrareview-inline-btn xtrareview-inline-btn--${variant}`
    : 'xtrareview-inline-btn';
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
    }, 'copy');
    actions.appendChild(copyBtn);

    actions.appendChild(createCategoryBadge(result.category));

    toolbar.appendChild(actions);

    if (bodyEl) {
      bodyEl.parentNode.insertBefore(toolbar, bodyEl.nextSibling);
    } else {
      el.appendChild(toolbar);
    }

    await maybeRecordAndAnnotateRadar({
      el,
      actions,
      author,
      filePath,
      result,
    });

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

async function maybeRecordAndAnnotateRadar({ el, actions, author, filePath, result }) {
  if (typeof XtraReviewRadar === 'undefined') return;
  if (!result?.ok || !result.lesson || result.category === 'not_a_review') return;
  if (!isAuthorOfCurrentPr()) return;

  const coords = getPrCoordinates();
  if (!coords) return;

  const commentId = extractCommentAnchorId(el);
  if (!commentId) return;

  try {
    const entry = await XtraReviewRadar.recordComment({
      repo: coords.repo,
      prNumber: coords.prNumber,
      prTitle: getPrTitle(),
      commentId,
      reviewer: author,
      category: result.category,
      lesson: result.lesson,
      filePath,
    });

    if (!entry || !actions.isConnected) return;

    const recurrence = await XtraReviewRadar.getRecurrenceForLesson(entry.lessonKey);
    if (!actions.isConnected) return;

    // The radar always records before this read, so a count of at least 1 is
    // expected. Show the chip every time so the toolbar consistently surfaces
    // the lesson, with a stronger visual treatment once the lesson recurs.
    actions.appendChild(
      createRecurrenceChip({
        count: recurrence?.count || 1,
        lesson: entry.lesson,
        lastSeenTs: recurrence?.lastSeenTs || entry.ts,
      })
    );
  } catch {
    /* radar is best-effort; never break the toolbar */
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
