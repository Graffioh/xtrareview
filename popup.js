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

loadAndRender();
