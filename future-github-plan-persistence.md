# Future GitHub Persistence Plan

This note captures the preferred approach for making XtraReview Radar durable across devices without changing the current fast local-first behavior.

## Current State

- The extension already stores radar data in `chrome.storage.local`.
- The hot path is intentionally local-first:
  - comment classification happens once
  - lesson/radar aggregation is written locally
  - UI reads local data immediately
- This keeps the toolbar and popup fast, works offline, and avoids GitHub/API setup friction.

## Decision

If we add long-term remote persistence later, the recommended approach is:

- keep `chrome.storage.local` as the source of truth for day-to-day reads/writes
- add optional GitHub sync as a backup + portability layer
- store synced data as text files in a private repo
- do **not** use SQLite inside the extension

## Why Not SQLite

SQLite sounds attractive, but it is a poor fit for a Chrome extension:

- MV3 does not provide native SQLite
- shipping a WASM SQLite runtime adds weight and complexity
- updating a `.sqlite` file in GitHub would require blob fetch + mutate + re-upload
- concurrent writes from multiple tabs/devices would be awkward
- binary files are hard to diff, inspect, and recover manually

For this use case, plain JSON/JSONL in GitHub is simpler and more robust.

## Preferred Remote Shape

Use a private GitHub repository with text-based storage.

Suggested layout:

```text
xtrareview-radar-data/
  README.md
  library.json
  data/
    owner__repo-a.jsonl
    owner__repo-b.jsonl
```

### Files

- `library.json`
  - aggregate lesson library
  - keyed by normalized `lessonKey`
  - stores count, timestamps, categories, and a few examples
- `data/<repo>.jsonl`
  - append-only raw event log
  - one line per recorded review comment
  - grouped by reviewed source repository

This gives us:

- readable history
- easy debugging
- simple imports/exports
- reasonable conflict handling

## Data Model

Each raw JSONL line should contain at least:

```json
{
  "id": "owner/repo#123::discussion_r123456",
  "repo": "owner/repo",
  "prNumber": 123,
  "prUrl": "https://github.com/owner/repo/pull/123",
  "prTitle": "Add recurring feedback radar",
  "commentId": "discussion_r123456",
  "reviewer": "reviewer-login",
  "category": "correctness",
  "lesson": "Handle empty states explicitly",
  "lessonKey": "handle empty states explicitly",
  "filePath": "src/foo.ts",
  "directory": "src",
  "fileExt": "ts",
  "ts": 1760000000000
}
```

The aggregate `library.json` can look like:

```json
{
  "handle empty states explicitly": {
    "lesson": "Handle empty states explicitly",
    "count": 4,
    "firstSeenTs": 1760000000000,
    "lastSeenTs": 1760500000000,
    "categories": {
      "correctness": 3,
      "maintainability": 1
    },
    "examples": [
      {
        "id": "owner/repo#123::discussion_r123456",
        "repo": "owner/repo",
        "prNumber": 123,
        "prTitle": "Add recurring feedback radar",
        "commentId": "discussion_r123456",
        "filePath": "src/foo.ts",
        "category": "correctness",
        "ts": 1760500000000
      }
    ]
  }
}
```

## Sync Strategy

### Principle

Remote sync should never sit in the critical path for comment processing.

### Write Flow

1. Record locally first.
2. Mark the entry or lesson bucket as dirty.
3. Sync in the background on a debounce or explicit trigger.
4. If sync fails, keep local data and retry later.

### Read Flow

- Normal reads continue to come from local storage.
- On startup, popup open, or manual action, the extension may pull remote data and merge it into local storage.
- Remote data should enrich local state, not block rendering.

### Suggested Trigger Options

Start simple:

- manual `Sync now` button later
- optional auto-sync later:
  - debounce after writes
  - sync on popup open
  - sync on browser idle

## Merge Rules

To stay safe and predictable:

- use `id` as the dedupe key for raw entries
- use `lessonKey` as the merge key for aggregate buckets
- merge `count` by recomputing from raw events when needed, or by carefully folding in unseen entries
- prefer the most recent raw `lesson` string for display
- keep examples deduped by `id` and capped to a small limit

## Conflict Strategy

GitHub-backed sync will eventually hit conflicts if multiple clients write.

Recommended approach:

### Raw Logs

- raw JSONL files are append-only
- on conflict:
  - fetch latest remote
  - parse lines
  - append only unseen `id`s
  - retry commit

### Aggregate Library

Two viable approaches:

1. Treat `library.json` as a cached derivative and rebuild/update it from merged raw logs.
2. Merge buckets directly by `lessonKey`, summing category counts and deduping examples.

For correctness, option 1 is safer. For speed, option 2 is cheaper. If the dataset stays modest, rebuilding `library.json` during sync is acceptable.

## Authentication

Later, the popup can expose optional GitHub sync settings:

- GitHub token
- owner/repo for persistence repo
- branch name, default `main`
- enable/disable sync toggle

Token requirements:

- private repo access
- as narrow a scope as GitHub allows for this workflow

The token should be stored locally and never injected into page contexts.

## Suggested Implementation Phases

### Phase 1: Document only

- keep current local-first radar as-is
- no remote code yet

### Phase 2: Export/Import

- add buttons to export local radar to JSON
- add buttons to import/merge from JSON

This validates portability before adding GitHub complexity.

### Phase 3: Manual GitHub Sync

- add popup settings for repo + token
- add `Sync now`
- push raw JSONL + library snapshot
- pull and merge on demand

### Phase 4: Background Sync

- debounce writes
- retry failed syncs
- expose last sync status in popup

## UX Notes

When GitHub sync exists, the popup should surface:

- sync enabled/disabled
- configured repo
- last sync time
- last sync error, if any
- `Sync now`
- `Pull latest`

The radar itself should continue to work even when sync is disabled or failing.

## Security and Privacy

- use a private repo only
- never log tokens
- never embed tokens in content scripts or page DOM
- assume stored PR metadata may be sensitive
- consider a future per-entry redaction mode if titles or paths feel too revealing

## Open Questions

- single-user only, or shared team repository?
- should each user have a separate namespace/folder inside the same repo?
- should `library.json` be authoritative, or derived from raw logs?
- do we want manual sync only at first, or background sync from the start?
- should we support export/import before any GitHub integration?

## Recommended Next Step

Do nothing yet in product code.

The current local-first radar is the right default. If we revisit this later, the best next implementation step is:

1. add export/import in the popup
2. then add manual GitHub sync
3. only after that, consider background sync
