# xtrareview

A Chrome extension that augments **every** code review comment on GitHub PRs — human or bot — with:

- A **Learn** button that copies a learning prompt to your clipboard
- An **LLM-powered category badge** (Security, Performance, Style, Logic, Bug, etc.)

## How it works

1. On any GitHub PR, the extension finds all review comments
2. Under each comment, it injects a toolbar with a Learn button + a category badge
3. The category is classified by an LLM call via [OpenRouter](https://openrouter.ai) (shows "Classifying..." spinner while loading)
4. Click **Learn** on any comment — copies a structured learning prompt to your clipboard
5. Click **Learn All** (floating button) — copies all comments at once
6. Paste into ChatGPT, Claude, or any LLM to learn

## Installation

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** — select the `xtrareview/` directory

## Setup

1. Click the extension icon in Chrome toolbar
2. Paste your [OpenRouter API key](https://openrouter.ai/keys) (free tier works)
3. Default model: `nvidia/nemotron-3-super-120b-a12b:free`
4. Done — categories will now appear on PR comments

Without an API key, the Learn buttons still work — you just won't get category badges.

## Categories

| Category | What it catches |
|----------|----------------|
| Security | Auth issues, data exposure, vulnerabilities |
| Performance | Bottlenecks, optimization opportunities |
| Style | Formatting, naming conventions |
| Logic | Incorrect conditions, wrong algorithms |
| Best Practice | Design patterns, idiomatic code |
| Bug | Actual bugs, crashes, undefined behavior |
| Readability | Code clarity, documentation |
| Other | Everything else |
