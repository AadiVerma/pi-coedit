# coedit QA plan — scenarios, matrix, and generated-case strategy

Goal: break the product the way real users (and real agents) will, fix everything found, and re-test until stable.

## 1. How users actually use coedit (flows under test)

1. **Solo agent**: pi edits files via edit/write/bash; user watches footer.
2. **Solo human**: user types in VS Code (coedit-gutter sensor) while pi idles.
3. **Concurrent editing** (the core scenario): human types in VS Code while pi runs edits and bash commands in the same repo; overlapping lines; ambiguous mid-window changes.
4. **Stale-write defence**: agent edit/write against a file the human changed since the agent last read it — across all guard policies and UI availability.
5. **Post-commit**: commit (partial or full) → baseline reset → Git AI note export / ledger note.
6. **Recovery**: "what broke?" → `/bisect "cmd"` → revert only the culprit edit.
7. **Costing**: `pi-ledger show/blame/range/report` after sessions + commits.
8. **Adversarial environments**: not-a-repo, empty repo (no HEAD), detached worktrees, nested repos, submodules, weird filenames (spaces, unicode, emoji, leading `-`, deep paths), CRLF/LF mixes, binaries, symlinks, huge files, concurrent pi sessions sharing one store.

## 2. Test matrix (permutations driven by loops, not hand-written copies)

| Area | Dimensions | Executed cases |
|---|---|---|
| Diff correctness | random before/after content (len 0–120, alphabet incl. CRLF, unicode, repeated lines) × round-trip invariant | 3,000 generated |
| Attribution | random event sequences (1–14 events, author ∈ {agent,human,unknown}, random hunks vs recomputed) × replay determinism + line-count invariant + origin validity | 3,000 generated |
| Overwrite guard | policy {block, ask, warn, off} × UI {yes,no} × lastRead {yes,no} × staleness {fresh, human-since, newline-only, human-then-agent-revert} | 4×2×2×4 = 64 |
| Store | writers {1,2,8,32} × events {10,100} × corruption {none, torn tail, garbage state, truncated state, missing dir} × stale-lock {none, dead pid, stale ts} | 4×2×5×3 = 120 |
| Snapshot/diff files | head states {no commit, clean, dirty} × files {tracked, untracked, ignored, binary, symlink, deleted, renamed} | 3×8 = 24 |
| Baseline reset | partial commit × dirty leftovers × untracked-first-commit | 12 |
| humanChangesSince | hash {same, newline-only, line change, evicted blob} | 16 |
| Gutter mapping | origins × lineCounts × overlay | 200 generated |
| Bisect engine | n {0,1,2,3,20} × breakpoints {none, one, multiple(non-monotonic)} | 15 |
| Ledger | timezones {Z, +05:30, −08:00} × {usage present, missing, torn} × multi-session | 24 |
| e2e demos | coedit edit, coedit stale, bisect, ledger | 4 |

Explicit edge-case suites add ~200 more assertions. Total executed cases per `npm run check` run: **> 6,000**.

## 3. Known-risk spots the suites target

- Trailing-newline-only changes (hash differs, hunks empty).
- `humanChangesSince` `changed` semantics vs hunks.
- Editor-reported human change inside an agent bash window (must be `unknown`, not `human`/`agent`).
- HEAD changing mid-session (checkout/reset) invalidating the baseline.
- Overlapping agent hunks during gutter revert.
- Timezone-offset ISO comparisons in ledger windows.
- Store corruption + torn JSONL tails + stale locks under concurrency.
- Renames, delete/recreate cycles, binary skips, eviction fallbacks.

## 4. Process

red (write suites) → fix bugs → green → re-run everything (including demos) → commit locally only. No pushes.
