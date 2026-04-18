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

const apiKeyInput = document.getElementById('api-key');
const modelIdInput = document.getElementById('model-id');
const apiStatus = document.getElementById('api-status');
const categoryPreview = document.getElementById('category-preview');
const testApiButton = document.getElementById('test-api');
const testStatus = document.getElementById('test-status');
const radarCountEl = document.getElementById('radar-count');
const radarEmptyEl = document.getElementById('radar-empty');
const radarListEl = document.getElementById('radar-list');
const radarCategoriesEl = document.getElementById('radar-categories');
const radarClearBtn = document.getElementById('radar-clear');
const radarPaginationEl = document.getElementById('radar-pagination');
const radarPageIndicatorEl = document.getElementById('radar-page-indicator');
const radarPrevBtn = document.getElementById('radar-prev');
const radarNextBtn = document.getElementById('radar-next');
const clearCacheBtn = document.getElementById('clear-cache');
const clearCacheStatus = document.getElementById('clear-cache-status');

const RADAR_PAGE_SIZE = 5;

let radarLessons = [];
let radarPage = 0;

// Render category chips
function renderCategories() {
  categoryPreview.innerHTML = '';
  for (const [, cat] of Object.entries(CATEGORIES)) {
    const chip = document.createElement('span');
    chip.className = 'cat-chip';
    chip.style.backgroundColor = cat.color;
    chip.textContent = cat.label;
    categoryPreview.appendChild(chip);
  }
}

function updateStatus(hasKey) {
  apiStatus.innerHTML = '';
  const status = document.createElement('span');
  status.className = `status ${hasKey ? 'connected' : 'disconnected'}`;
  status.textContent = hasKey ? '● API key saved' : '○ No API key set — categories disabled';
  apiStatus.appendChild(status);
}

function setTestStatus(text, tone = 'neutral') {
  testStatus.textContent = text;
  testStatus.style.color =
    tone === 'success' ? '#1a7f37' : tone === 'error' ? '#cf222e' : '#656d76';
}

function summarizeModelOutput(text) {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}…` : cleaned;
}

function formatTestResult(result) {
  const errorText = result?.error || '';

  if (result?.ok) {
    const label = CATEGORIES[result.category]?.label || result.category;
    return { text: `Test passed — sample comment categorized as ${label}.`, tone: 'success' };
  }

  if (result?.reason === 'missing_api_key') {
    return { text: 'Add an OpenRouter API key first.', tone: 'error' };
  }

  if (result?.reason === 'auth_error') {
    return { text: errorText || 'OpenRouter rejected the API key or model.', tone: 'error' };
  }

  if (result?.reason === 'api_error') {
    return { text: errorText || 'OpenRouter returned an API error.', tone: 'error' };
  }

  if (result?.reason === 'unsupported_model') {
    return {
      text: errorText || 'This model does not support strict JSON classification reliably.',
      tone: 'error',
    };
  }

  if (result?.reason === 'unparseable_response') {
    const snippet = summarizeModelOutput(errorText);
    return {
      text: snippet
        ? `Unexpected model response. Model replied: ${snippet}`
        : 'Unexpected model response. Try a different model.',
      tone: 'error',
    };
  }

  if (/receiving end does not exist|extension context invalidated/i.test(errorText)) {
    return { text: 'Reload the extension, then refresh the GitHub tab.', tone: 'error' };
  }

  if (result?.reason === 'timeout') {
    return { text: 'Test request timed out after 30 seconds.', tone: 'error' };
  }

  return { text: errorText || 'Could not reach the background classifier.', tone: 'error' };
}

function persistSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        openrouterApiKey: apiKeyInput.value.trim(),
        modelId: modelIdInput.value.trim() || DEFAULT_MODEL_ID,
      },
      resolve
    );
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          reason: 'request_failed',
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      resolve(response || { ok: false, reason: 'request_failed' });
    });
  });
}

async function runApiTest() {
  testApiButton.disabled = true;
  setTestStatus('Testing categorization…');

  clearTimeout(saveTimeout);

  try {
    await persistSettings();
    const response = await sendMessage({ type: 'xtrareview:test-api' });
    const formatted = formatTestResult(response);
    setTestStatus(formatted.text, formatted.tone);
  } finally {
    testApiButton.disabled = false;
  }
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

function buildExampleLink(example) {
  if (!example?.repo || !example?.prNumber) return null;
  const base = `https://github.com/${example.repo}/pull/${example.prNumber}`;
  const url = example.commentId ? `${base}#${example.commentId}` : base;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${example.repo}#${example.prNumber}`;
  link.title = example.prTitle || '';
  return link;
}

function renderRadarItem(bucket) {
  const item = document.createElement('div');
  item.className = 'radar-item';

  const row = document.createElement('div');
  row.className = 'radar-item-row';

  const count = document.createElement('span');
  count.className = 'radar-item-count';
  count.textContent = `${bucket.count}x`;
  row.appendChild(count);

  const lesson = document.createElement('span');
  lesson.className = 'radar-item-lesson';
  lesson.textContent = bucket.lesson;
  lesson.title = bucket.lesson;
  row.appendChild(lesson);

  item.appendChild(row);

  const meta = document.createElement('div');
  meta.className = 'radar-item-meta';

  const lastSeen = document.createElement('span');
  lastSeen.textContent = `Last seen ${formatRelativeTime(bucket.lastSeenTs)}`;
  meta.appendChild(lastSeen);

  const examples = (bucket.examples || []).slice(0, 3);
  for (const example of examples) {
    const link = buildExampleLink(example);
    if (link) meta.appendChild(link);
  }

  if (meta.children.length) item.appendChild(meta);

  return item;
}

function renderRadarCategories(byCategory) {
  radarCategoriesEl.innerHTML = '';
  const entries = Object.entries(byCategory || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [category, count] of entries) {
    const cat = CATEGORIES[category];
    if (!cat) continue;
    const pill = document.createElement('span');
    pill.className = 'radar-cat-pill';
    pill.style.backgroundColor = cat.color;

    const label = document.createElement('span');
    label.textContent = cat.label;
    pill.appendChild(label);

    const num = document.createElement('span');
    num.className = 'cat-pill-count';
    num.textContent = `· ${count}`;
    pill.appendChild(num);

    radarCategoriesEl.appendChild(pill);
  }
}

function renderRadarList() {
  radarListEl.innerHTML = '';

  const totalPages = Math.max(1, Math.ceil(radarLessons.length / RADAR_PAGE_SIZE));
  if (radarPage >= totalPages) radarPage = totalPages - 1;
  if (radarPage < 0) radarPage = 0;

  const start = radarPage * RADAR_PAGE_SIZE;
  for (const bucket of radarLessons.slice(start, start + RADAR_PAGE_SIZE)) {
    radarListEl.appendChild(renderRadarItem(bucket));
  }

  if (radarLessons.length <= RADAR_PAGE_SIZE) {
    radarPaginationEl.hidden = true;
    return;
  }

  radarPaginationEl.hidden = false;
  radarPageIndicatorEl.textContent = `Page ${radarPage + 1} of ${totalPages}`;
  radarPrevBtn.disabled = radarPage === 0;
  radarNextBtn.disabled = radarPage >= totalPages - 1;
}

async function renderRadar() {
  if (typeof XtraReviewRadar === 'undefined') {
    radarCountEl.textContent = 'Radar unavailable';
    radarEmptyEl.hidden = true;
    radarPaginationEl.hidden = true;
    return;
  }

  let stats;
  try {
    stats = await XtraReviewRadar.getAllStats();
  } catch {
    radarCountEl.textContent = 'Radar unavailable';
    radarEmptyEl.hidden = true;
    radarPaginationEl.hidden = true;
    return;
  }

  radarCountEl.textContent = `${stats.totalEntries} comment${stats.totalEntries === 1 ? '' : 's'} tracked`;
  radarLessons = Array.isArray(stats.lessons) ? stats.lessons : [];
  renderRadarCategories(stats.byCategory);

  if (!stats.totalEntries) {
    radarListEl.innerHTML = '';
    radarPaginationEl.hidden = true;
    radarEmptyEl.hidden = false;
    radarClearBtn.disabled = true;
    return;
  }

  radarEmptyEl.hidden = true;
  radarClearBtn.disabled = false;
  renderRadarList();
}

async function clearRadarHistory() {
  if (typeof XtraReviewRadar === 'undefined') return;
  radarClearBtn.disabled = true;
  try {
    await XtraReviewRadar.clearHistory();
  } finally {
    radarPage = 0;
    await renderRadar();
  }
}

function setClearCacheStatus(text, tone = 'neutral') {
  clearCacheStatus.textContent = text;
  clearCacheStatus.style.color =
    tone === 'success' ? '#1a7f37' : tone === 'error' ? '#cf222e' : '#656d76';
}

async function clearClassificationCache() {
  if (typeof XtraReviewCache === 'undefined') {
    setClearCacheStatus('Cache module unavailable.', 'error');
    return;
  }

  clearCacheBtn.disabled = true;
  setClearCacheStatus('Clearing cache…');

  try {
    await XtraReviewCache.clearCache();
    setClearCacheStatus('Cache cleared. Refresh the GitHub PR tab to re-classify.', 'success');
  } catch (error) {
    setClearCacheStatus(
      `Could not clear cache: ${error?.message || 'unknown error'}`,
      'error'
    );
  } finally {
    clearCacheBtn.disabled = false;
  }
}

function loadAndRender() {
  chrome.storage.sync.get(['openrouterApiKey', 'modelId'], (result) => {
    if (result.openrouterApiKey) {
      apiKeyInput.value = result.openrouterApiKey;
      updateStatus(true);
    } else {
      updateStatus(false);
    }
    modelIdInput.value = result.modelId || DEFAULT_MODEL_ID;
  });
  renderCategories();
  renderRadar();
}

let saveTimeout;
function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    persistSettings();
  }, 400);
}

apiKeyInput.addEventListener('input', () => {
  const val = apiKeyInput.value.trim();
  scheduleSave();
  updateStatus(!!val);
  setTestStatus('');
});

modelIdInput.addEventListener('input', () => {
  scheduleSave();
  setTestStatus('');
});

testApiButton.addEventListener('click', runApiTest);
radarClearBtn.addEventListener('click', clearRadarHistory);
clearCacheBtn.addEventListener('click', clearClassificationCache);

radarPrevBtn.addEventListener('click', () => {
  if (radarPage > 0) {
    radarPage -= 1;
    renderRadarList();
  }
});

radarNextBtn.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(radarLessons.length / RADAR_PAGE_SIZE));
  if (radarPage < totalPages - 1) {
    radarPage += 1;
    renderRadarList();
  }
});

loadAndRender();
