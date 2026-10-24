# @coedit/core

The shared engine behind the coedit tools: an append-only event store, worktree snapshots, a dependency-free Myers diff, and forward-carrying human-vs-agent line attribution. Private workspace package — every published artifact bundles it with esbuild, so users install exactly one thing.

## Public API

```ts
import { Coedit } from "@coedit/core";

const coedit = await Coedit.open(cwd);      // null when cwd is not a git repo
await coedit.track();                        // baseline + replay of past events

await coedit.recordEvent({ file, author, source, beforeHash, afterHash, hunks, agent }, { before, after });
const attr = await coedit.attribution("src/a.ts");   // per-line origins
coedit.fileSummary();                        // counts per file: human/agent/both/unknown
await coedit.humanChangesSince("src/a.ts", lastReadHash);
coedit.onStoreChange(cb);                    // live updates for the gutter

await coedit.resetBaseline(newHeadCommit);   // after a commit
await coedit.exportGitAiNote(newHeadCommit); // Git AI standard v3.0.0 authorship log
```

Lower-level pieces (`Store`, `AttributionEngine`, `computeHunks`, `takeSnapshot`, `diffSnapshots`, `classifyChange`, Git AI codec) are exported too.

## Store layout

`<git-common-dir>/coedit/` — shared across worktrees, never committed:

- `state.json` — `schemaVersion`, config, per-worktree HEAD cursor, already-reported human changes. Migrated on load; atomic writes.
- `events.jsonl` — append-only change events. A torn final line (crash) is ignored on read.
- `lock` — pid+timestamp lockfile; stale locks (dead pid or > 30 s) are broken automatically; writers wait up to 5 s, then fail loudly.
- `blobs/` — bounded content cache (max 500 files, 2 MiB each) keyed by content sha256, written when events carry contents. Powers `humanChangesSince`, reverts and note export without storing full snapshots.
- `backup-<ts>/` — a corrupted `state.json` is moved here before the store starts fresh (with a warning).

Events carry a `worktree` field because the store is shared: attribution filters by worktree.

## Who changed it — detection rules

| Situation | Author |
|---|---|
| `edit`/`write` tool call by the agent | `agent` (with session, entry, turn, model, prompt excerpt) |
| File changed between the snapshots bracketing an agent `bash` call, no editor report | `agent` |
| Change reported by the editor sensor, outside an agent window | `human` |
| Human change landing during an agent bash window (editor reports typing while the window is open) | `unknown` — never guessed, shown grey |
| fs-watch / turn-start snapshot change outside agent windows | `human` |
| Dirty vs HEAD but never observed by coedit | `unknown` |

The editor sensor (coedit-gutter) is authoritative *outside* agent windows.

## Attribution model

- **Baseline:** content at `HEAD` for tracked files; first-seen content for untracked files. Per-line origins: `unchanged`, `human`, `agent`, `both` (agent-written then human-modified, or the reverse), `unknown`.
- Origins are **carried forward** through event hunks (never recomputed from content): replaced lines combine the old origin with the event author; pure insertions take the event author; a line whose last writer cannot be named becomes `unknown`.
- **Baseline reset:** after a commit, lines that match the new HEAD become `unchanged`; still-dirty lines keep their origin; the pre-reset attribution is handed to the Git AI note writer.
- **CRLF:** line comparison ignores trailing `\r`; hashing uses raw bytes.
- **Binary files** (NUL byte in the first 8 KiB) are recorded as events but never line-attributed.
- **Renames:** a removal paired with an appearance of identical content in the same snapshot transition carries the line map. No fuzzy rename detection.

## Known limits

- Files that changed before coedit started (and have no events) show their uncommitted lines as `unknown`.
- The event-hunk fallback for never-observed files sizes its line map from the hunks; lines past the last hunk read as `unknown` until a seeded event arrives.
- Diffs beyond an edit distance of 8000 in the prefix/suffix-trimmed middle section fall back to one full-file replace hunk.
- The blob cache evicts (LRU-ish, 500 entries); `humanChangesSince` degrades to a boolean when content was evicted.

## Snapshot performance (10k files, Apple M-series, Node 22)

| Scan | Time |
|---|---|
| Cold (hashes every file) | ~270 ms |
| Warm (mtime+size pre-filter, 5% changed) | ~70 ms |

Reproduce with `npm run benchmark -w @coedit/core`.

## Tests

`npm test` — 35 tests: diff (hunks, CRLF, bounded fallback), attribution (overlaps, `both`, shifts, delete/recreate, renames, binary, baseline reset, replay), store (locking, concurrency, corruption recovery, eviction), a golden-file end-to-end run in a real temp repo, and the Git AI note shape. `UPDATE_GOLDEN=1` regenerates the golden file.
