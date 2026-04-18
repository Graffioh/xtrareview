# xtrareview

Chrome extension (Manifest **v3**, version **2.0.0**) that enhances **GitHub pull request** review comments. On each eligible comment it can show a small **xtrareview** toolbar with:

- **Copy** — comment text to the clipboard  
- **Learn** — a structured “mentor” prompt (author, file, line, code context, category) ready to paste into ChatGPT, Claude, or any LLM  
- A **category badge** — Security, Performance, Style, Logic, Best Practice, Bug, Readability, or Other  

Classification runs through [OpenRouter](https://openrouter.ai) using a strict JSON schema so categories stay consistent.

## Where it runs

Only on PR URLs matching:

`https://github.com/<owner>/<repo>/pull/<number>`

The content script keeps working as you navigate GitHub’s client-side routing (e.g. switching tabs on the same PR).

## How it works

1. The extension finds review-style comments (conversation, inline, and diff-thread selectors).
2. Very short bodies or non-review remarks are skipped early.
3. If an OpenRouter API key is saved, it classifies each comment (spinner while loading). Results are **cached** locally by model + comment text so repeat visits do not repeat paid calls.
4. Comments the model labels as **`not_a_review`** (e.g. thanks-only, LGTM-only, pure meta chatter) get **no** toolbar — only substantive feedback gets **Copy** / **Learn** / badge.
5. Click **Learn** to copy the learning prompt; use **Copy** if you only want the raw comment.

Without an API key, you see a muted hint to set a key in the popup — **Learn**, **Copy**, and badges are not shown for classified comments.

## Installation

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and choose this `xtrareview` folder

## Setup

1. Open the extension popup from the toolbar.
2. Paste your [OpenRouter API key](https://openrouter.ai/keys) (free-tier models are fine).
3. Optional: change the **Model** — default is `arcee-ai/trinity-large-preview:free`.
4. Use **Test categorization** to confirm the key and model work before reviewing a real PR.

If you **reload the extension** in `chrome://extensions`, refresh any open GitHub PR tab so the content script reconnects to the background worker.

## Categories

| Category | Typical signal |
|----------|----------------|
| Security | Auth, secrets, unsafe data handling |
| Performance | Hot paths, caching, complexity |
| Style | Formatting, naming, conventions |
| Logic | Conditions, control flow, algorithms |
| Best Practice | Design, patterns, maintainability |
| Bug | Correctness, crashes, edge cases |
| Readability | Clarity, structure, docs |
| Other | Real feedback that does not fit above |

*(Internally, **`not_a_review`** is used for non-substantive comments; those threads do not show a toolbar or badge.)*
