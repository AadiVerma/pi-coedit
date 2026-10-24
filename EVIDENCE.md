# Build evidence

## Step 1 — research & plan (2026-10-24)

- pi 1.4.0 verified at `~/.pi/agent/bin/pi`; docs + examples located (examples one level above `docs/` — noted in plan).
- Git AI standard v3.0.0 read in full (914 lines); README capabilities table read. `git-ai-project/git-ai` = 2,886★, pushed 2026-10-21. pi is a supported agent.
- Prior art re-scan (npm `keywords:pi-package` + targeted searches, GitHub search): no new live human-vs-agent attribution / agent-edit bisect / per-commit cost packages. **`pi-ledger` npm name is taken** → publishing as `pi-coedit-ledger`. `pi-coedit`, `pi-bisect` free (checked via `npm view`).
- Deviations + interop decision written up in `docs/PLAN.md` (Git AI: coexist — we never write `refs/notes/ai` while `git-ai` is installed; standard-compliant note exporter provided for the no-git-ai case).

## Step 2 — monorepo skeleton

- Root `package.json` (private, `workspaces: ["packages/*"]`, strict TS base config, no runtime deps).
- `scripts/build.mjs` — shared esbuild bundler; host packages + `vscode` always external, `@coedit/core` always inlined.
- `scripts/new-plugin.mjs` — scaffolder; `scripts/check-packages.mjs` — manifest rules (pi manifest, `pi-package` keyword, host packages only in `peerDependencies:"*"`, empty runtime deps, README/CHANGELOG present, command/tool name uniqueness registry).
- CI: `.github/workflows/ci.yml` (npm ci → build → check), `release.yml` (manual dispatch only; no automated publish).
- Round trip proven: `npm run new demo` → `npm install` (workspace linked) → `npm run build -w demo` (esbuild, 10 ms) → `npm run typecheck -w demo` ✓ → `npm run test -w demo` ✓ (1 pass) → full `npm run check` ✓ → demo deleted, `npm install` clean.
- Fix applied during round trip: `node --test` needs a glob (`node --test "test/**/*.test.ts"`), template smoke test added.

## Step 3 — core (`@coedit/core`)

- Store at `<git-common-dir>/coedit/`: atomic `state.json` (schemaVersion, migration on load), append-only `events.jsonl` (torn-tail tolerant), pid+timestamp lock with stale recovery and 5 s timeout, bounded blob cache (500 × 2 MiB), corrupted-state backup + fresh start with warning.
- Dependency-free Myers diff (prefix/suffix trim, CRLF-agnostic compare, bounded full-replace fallback at edit distance 8000).
- Attribution engine: forward-carrying line origins (`unchanged/human/agent/both/unknown`), baseline = HEAD or first-seen; `both` on dual authorship; `unknown` never guessed; rename carrying by content hash; binary files skipped; baseline reset after commit keeps still-dirty origins.
- Git AI standard v3.0.0 codec: `exportGitAiNote` builds compliant notes (`s_<14hex>::t_<14hex>`, `h_<14hex>` per spec key derivations); attaching to `refs/notes/ai` only when `git-ai` is absent; read-only parse for coexistence.
- **Tests: 35 passing** — diff, attribution (overlap/both/shift/delete-recreate/rename/binary/reset/replay), store (concurrency 100 events across 2 writers, stale-lock break, corruption backup, eviction, torn tail), golden end-to-end in a real temp repo (agent edit + human header + human tweak → `both`; bash-created file + mid-window human edit → `unknown`), Git AI note shape.
- **Benchmark (10k files): cold 269 ms, warm 71 ms** (`npm run benchmark -w @coedit/core`).
- Detection rules + limits documented in packages/core/README.md.
- Notable fixes during TDD: hunk assembler insStart for pure deletions (derived from running shift), origin-combine rule for rewrites of unknown lines, seeding files from blob/HEAD content before their first event (accuracy over inferred unknowns).

## Step 4 — pi-coedit (live awareness + overwrite protection)

- Plugin wired to the verified 1.4.0 API: `session_start` opens the store + recursive fs watcher; `tool_execution_start/end` brackets bash windows and captures edit/write before-content; `tool_call` implements the overwrite guard; `context` injects human-edit notes (once per change, capped diff, pointer to /whose); footer widget; `/whose`, `/coedit status|reset|doctor`; read-only `coedit_whose` tool; agent metadata (session id/file, turn, tool call, model, capped prompt excerpt) on every agent event.
- **Scripted demo without model credentials** (none exist on this machine — `pi --list-models` is empty): `scripts/demo/demo-driver.ts` registers an offline provider whose `streamSimple` streams a canned plan, so `pi --mode json` runs the real agent loop. `scripts/demo/run-coedit-demo.mjs` builds a fixture repo, edits a.js+b.js as the "human" 2 s in, and extracts evidence.
- **Scenario "edit" PASSES**: agent edit recorded (`agent pi-edit a.js [session t0 scripted]`), human edits recorded (`human fs-watch a.js`, `human fs-watch b.js`), and the agent's final text confirms the human-diff note reached the model.
- **Scenario "stale-edit" PASSES**: the guard blocks the stale `edit` with the human diff in the reason — `tool edit: ERROR — coedit: "a.js" has human changes since you last read it… +// human touched a.js — keep this line` — and the blocked call leaves no store event.
- Notable findings while building the demo: pi reads piped stdin as prompt content (spawn must use `stdio: ["ignore", …]`); the human-edit note is request-transient by design (consumers must remember it); `ls` is not in the default tool set; changes inside an agent bash window classify as the agent's per the detection rules — the demo's wait loop uses `read b.js` to avoid both pitfalls.
- `pi install ./packages/pi-coedit` — installed locally; `pi list` shows it; `coedit_whose` appears in the model's tool list.
- `npm run check` green: package checks (registry: /whose, /coedit, coedit_whose), typecheck, 35 core tests + plugin smoke test.

## Step 5 — coedit-gutter (VS Code extension)

- `src/decoration-map.ts`: pure attribution→ranges mapping (unit-tested, no vscode import): origin ranges, unsaved-human overlay, next/prev agent navigation, status-bar counts.
- `src/extension.ts`: live decorations (gutter bar SVG per colour + overview ruler + optional background), human-edit sensor (keystrokes → unsaved overlay → editor event on save; undo/redo and own reverts excluded), hover on agent lines (session/turn/model/prompt excerpt/time + copy `pi --session`), status bar `✍️ N · 🤖 N` with repo quick pick, commands: next/prev agent change, 3-way-safe revert (file/selection; per-hunk verification against recorded content, conflicts reported not applied), toggle colours, /whose view. Settings: colours, background, overview ruler, store path override, debounce.
- **`vsce package` succeeds**: `coedit-gutter.vsix` (6 files, 19 KB, sources excluded via .vscodeignore).
- **VS Code is not installed on this machine** (no app, no `code` CLI) → the `.vsix` install + screenshots could not be executed here. Manual checklist in `packages/coedit-gutter/README.md` §verify.
- Typecheck clean; 7 unit tests for the decoration mapping.

### Manual checklist (owner machine with VS Code)
1. `cd packages/coedit-gutter && npm run package && code --install-extension coedit-gutter.vsix`
2. Open the demo fixture repo (create: git init + commit `a.js`, `b.js`), run `pi -e ./packages/pi-coedit` with any model, ask the agent to edit `a.js`.
3. While it runs, type into `a.js` in VS Code — your lines turn **blue** immediately (unsaved overlay), the agent's lines **purple**; lines you both touched **orange**; a change typed while the agent's bash runs **grey**.
4. Hover a purple line → session/turn/model/prompt tooltip; click "copy pi --session".
5. Command palette → "coedit: revert agent changes in this file" → confirm → agent hunks disappear, human lines stay.
6. Status bar shows `✍️ N · 🤖 N`; click for the repo-wide quick pick.

## Step 6 — pi-bisect (agent-edit bisect)

- Shadow history (`src/shadow.ts`): one plumbing commit per agent change (edit/write direct; net bash-window diff) via temp `GIT_INDEX_FILE` → `write-tree` → `commit-tree` → `update-ref refs/coedit/edits/<sessionId>`; unchanged trees skipped; metadata sidecar (turn, tool call, files, model, capped prompt excerpt) in the store; index/HEAD/branches never touched.
- Bisect engine (`src/bisect.ts`): endpoint verification ("never passed" / "passes everywhere" both explained and stopped), binary search with caller-supplied runner, step accounting.
- Extension (`src/index.ts`): `/bisect "<cmd>" [--from <sha|turn:N>] [--runs N] [--timeout 5m] [--revert] [--fix]`, `/bisect gc` (keeps 10 sessions); throwaway detached worktrees with guaranteed cleanup (finally → remove → prune); TUI progress widget (steps left / range / elapsed); result card (culprit diff via `git diff parent culprit`, turn, prompt, model, edits-ago, `/tree` pointer); actions: fix-it message via `pi.sendMessage` or revert.
- Revert (`src/revert.ts`): `git apply` reverse patch first; **content-anchored fallback** locates the culprit's inserted lines by content (drift-tolerant) and restores the replaced lines — needed because later edits often change a hunk's context (found and fixed during the demo).
- **Tests: 7 passing** — 20-edit fixture finds edit 13 in ≤5 search steps (2 endpoints + ≤5); flaky `--runs` semantics; never-passed; passes-everywhere; plumbing invariants (ref exists, HEAD/index untouched); content-anchored revert with context drift.
- **Real-session demo PASSES** (`scripts/demo/run-bisect-demo.mjs`): a real pi loop (scripted provider) makes 4 edits, #3 breaks `node test.js`; bisect finds edit #3 in 4 command runs with the exact diff/turn/prompt/model; revert is content-anchored (later edit changed the context line) and `node test.js` passes again.

## Step 7 — pi-ledger (agent cost per commit)

- Usage capture: `turn_end` carries the assistant message's usage (tokens in/out/cache, USD, model) → persisted per session under `<store>/ledger/<sessionId>.jsonl`.
- Post-commit hook (`src/hook.ts`): scopes usage + agent edit events to (a) the committed files and (b) the window since the previous commit (epoch-based comparison — string ISO compare broke across UTC offsets, found and fixed), writes a JSON note on `refs/notes/pi-ledger`; links line counts to Git AI's `refs/notes/ai` note when present, else honest `null`.
- Hook installation (`pi-ledger install` / `/ledger install`): chained after any existing post-commit hook, never overwrites; picks hook.js (bundled) or hook.ts (source) automatically.
- CLI (`pi-ledger show | blame <file> | range <base>..<head> | report --since 30d [--json] | install`), also as `/ledger …` in pi. Shared bundler extended for multi-entry builds with shebang banners (`scripts/build.mjs`).
- **Tests: 4 passing** (usage round-trip, hook end-to-end on a fixture repo, window scoping, note/range formatting).
- **Fixture demo PASSES** (`scripts/demo/run-ledger-demo.mjs`): real pi session (scripted provider with per-turn cost) → hook note `1 session(s), 2 agent edit(s), claude-sonnet-4-5-demo ↑45.0k ↓3.0k $0.1740`; show/blame/range all print. npm name `pi-coedit-ledger` (bare `pi-ledger` taken); bin `pi-ledger` per spec.

## Step 8 — docs, release prep, name checks

- Root README: problem statement, package catalogue, demo-GIF placeholders (to be recorded on a VS Code machine), Git AI relationship, detection rules table, privacy notes, publishing policy.
- Changeset `.changeset/coedit-0-1-0.md`: minor bumps for pi-coedit, pi-bisect, pi-coedit-ledger, coedit-gutter (0.1.0).
- `files: ["dist"]` added to the publishable packages; `npm pack --dry-run` verified for pi-coedit (4 files), pi-bisect (4 files), pi-coedit-ledger (8 files, 133.1 kB). `vsce ls`/`vsce package` verified in step 5 (6-file vsix).
- **Name checks**: `npm view` → `pi-coedit`, `pi-bisect`, `pi-coedit-ledger` all E404 (free); bare `pi-ledger` taken (Markdown journal — hence the scoped rename). Marketplace search page is client-rendered (no server-side results) — `coedit-gutter`/publisher `coedit-dev` show no evidence of a conflict but the final marketplace check happens at publish time with the real publisher id.
- All three pi packages installed locally (`pi install`); `pi list` shows them; `coedit_whose` appears in the model's tool list.
- Final `npm run check` green: registry (4 commands: /bisect, /whose, /coedit, /ledger; 1 tool: coedit_whose), typecheck, 54 tests (core 35, gutter 7, bisect 7, ledger 4, pi-coedit 1).

## Stop point

Everything through step 8 is committed on `main` locally. Per the task constraints, the following await the owner's explicit OK (see final report): creating the GitHub repo, `git push`, `npm publish`, `vsce`/`ovsx publish`, runtime dependencies (none were added), hooks outside fixture repos (none installed).

## QA cycle (test-driven hardening, post-step-8)

Approach in docs/QA-PLAN.md: 8 user flows, a permutation matrix, and property/fuzz testing with seeded RNGs.

### Suites added (114 test blocks, >7,400 generated+matrix cases per `npm run check`)

- core fuzz (7,000 cases): diff round-trip I1 (3,000 random content pairs incl. CRLF/unicode/repeats), attribution replay invariants I2/I3/I4 (3,000 random event sequences: line-count, origin validity, inferred-path safety), edge-hunk cases I5 (1,000).
- core edge cases (25): 32-writer × 25-event concurrency, garbage/truncated state, stale-ts locks, same-process lock timeout, blob eviction, multi-worktree filtering, weird filenames (spaces/unicode/emoji/deep/leading-dash), broken+good symlinks, binary NUL placement, delete+recreate-not-rename, empty repo, dirty-vs-HEAD seeding, partial commits, HEAD-change resync, guard data (newline-only/evicted/CRLF), ignored files, file↔directory swaps, newline matrix.
- pi-coedit scenarios (11): **64-case overwrite-guard matrix** (policy × UI × read-state × staleness), human-edit-once notes, bash-window attribution, editor-in-window reclassification, re-read disarming, /whose, /coedit reset (confirm + decline), footer counts, non-repo cwd, concurrent per-file attribution, prompt-excerpt cap.
- gutter revert-core (11): overlap-safe revert incl. human-context drift, evictions, conflicts, ranges, CRLF, plus a 300-case random event-chain fuzz.
- bisect edge (6): 0/1/2-snapshot paths, non-monotonic predicates, parseTimeout matrix, delete-recreate revert, missing-file conflicts.
- ledger edge (4): timezone-offset window matrix (+05:30/−08:00/Z), torn usage files, multi-session aggregation/rounding, malformed notes.

### Product bugs found and fixed

1. **UTF-8 paths mangled** — `git ls-files -z` output decoded as latin1, so unicode filenames never entered snapshots; now byte-restored and UTF-8-decoded (also `diff --name-only -z`).
2. **`humanChangesSince` lied on newline-only changes** — `changed` was hunks-based; a trailing-newline-only edit (hash differs, zero hunks) reported `changed:false`, disarming the overwrite guard. Now hash-based: any content difference counts.
3. **Stale attribution after HEAD moves** — checkout/reset mid-session left event chains describing a discarded state; new `Coedit.resync()` keeps chains that still match the worktree and re-seeds the rest against the new HEAD.
4. **Editor-reported human change inside an agent bash window was labelled `human`** — now reclassified `unknown` (grey) via a reclassification event; `classifyChange` is the single decision point.
5. **`classifyChange` called with the wrong parameter name** (`editorSeen` vs `editorSeenHuman`) — silently made every in-window decision "agent"; caught by the 64-case matrix, would have been caught by tsc (process gap closed: typecheck runs in the loop).
6. **Config was frozen at session start** — `Store.config` now re-reads state.json per access, so policy edits from another session/the gutter take effect immediately.
7. **fs.watch startup window dropped early writes** — turn boundary is now anchored at session start, so the first `turn_start` diff records anything the watcher backend missed.
8. **Gutter revert could misplace edits when agent hunks overlapped** — replaced per-hunk WorkspaceEdit math with the pure, content-anchored `computeAgentRevert` (whole-document atomic apply, conflicts reported, human lines preserved).

### Verification after fixes

- `npm run check` green: registry, typecheck, **114/114 tests** (>7,400 executed cases).
- All four demos re-run green after the changes (edit, stale-edit, bisect, ledger).
- Model limit documented (trailing empty line vs final newline) in packages/core/README.md; generator excludes the unrepresentable case.
