# coedit — build plan (step 1, 2026-10-24)

## 0. Environment facts — verified, with deviations

Verified on this machine:

| Fact | Status |
|---|---|
| pi v1.4.0 at `~/.pi/agent/bin/pi` | ✅ |
| pi docs at `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/` | ✅ |
| Extension examples | ⚠️ at `examples/extensions/` (one level **above** `docs/`), not `docs/examples/extensions/` as the prompt said. Same content (git-checkpoint.ts, protected-paths.ts, dirty-repo-guard.ts, custom-footer.ts, overlay-test.ts, notify.ts all present). |
| `Type` import for tool schemas | ⚠️ comes from **`typebox`**, not `@earendil-works/pi-ai` (pi-ai exports `StringEnum` and friends). All shipped examples import `Type` from `typebox`. We follow the examples. |
| Node 22.23.4, npm 10.9.9, git 2.50.1, gh authenticated | ✅ |
| Node 22.23 runs `.ts` natively (type stripping) | ✅ → `node --test` runs our tests; no `tsx` needed (not in the allowed devDep list). |
| VS Code | ❌ **not installed** (no app, no `code` CLI). Step 5 will build, `vsce package`, and unit-test the gutter extension, and provide the manual checklist; the local `.vsix` install step cannot be executed on this machine. |
| git-ai CLI | not installed locally — `doctor` will report it absent; interop code is written against the standard spec. |

Prompt facts that check out: extension event list, `tool_call` block semantics, widget/status API, never-watch-in-factory rule, `pi` manifest in package.json, `pi-package` keyword, host packages only in `peerDependencies: "*"`, `pi install ./path` / `pi -e ./path`, `pi -p` one-shot mode.

## 0.1 Prior art re-check (2026-10-24)

- **Git AI** (`git-ai-project/git-ai`, 2,886★, pushed 2026-10-21) — unchanged role: post-commit attribution via git notes under `refs/notes/ai`, "Git AI standard v3.0.0" (read in full, see §0.2). pi is a listed supported agent (its binary calls `git-ai checkpoint`); no git hooks involved. VS Code/Cursor/Windsurf plugin colours AI blame per session **after commit**.
- **`pi-live-file-guard`** — still present; still pi-vs-pi only (stale writes between concurrent pi sessions). Different problem.
- **`pi-code`** — Claude Code compat/checkpoints; no bisect/attribution. Unchanged.
- npm `keywords:pi-package` re-scanned (60+ packages): nothing new does live human-vs-agent attribution, agent-edit bisect, or per-commit agent cost.
  - Near miss 1: `@monotykamary/pi-ledger` — meters agent *time* (turns as billable invocations) for client invoicing. Different purpose (billing, not per-commit cost attribution), but it **occupies the `pi-ledger` name space**.
  - Near miss 2: `pi-lens` — live LSP/linter feedback to the model; not attribution.
  - **Name collision found:** the bare npm name **`pi-ledger` is taken** ("A local, searchable Markdown work journal for Pi sessions"). `pi-coedit` and `pi-bisect` are free. → Our ledger workspace package will publish as **`pi-coedit-ledger`** (bin names `pi-ledger` + alias `pi-coedit-ledger`); final naming confirmed at the step-8 stop point. Core publishes as `@coedit/core` (private, bundled, never published).
- `coedit` (bare) and `@arbidocs/coedit` exist on npm but are unrelated (collaborative editing); none of our publishable names conflict.

## 0.2 Git AI interop decision

The standard (specs/git_ai_standard_v3.0.0.md, 914 lines) defines: notes under `refs/notes/ai` (MUST NOT use `refs/notes/commits`); attestation section (`s_<14hex>::t_<14hex>` session keys, `h_<14hex>` human keys, bare 16-hex legacy keys) + `---` + JSON metadata (`schema_version: "authorship/3.0.0"`, `sessions`, `humans`, `prompts` maps); `agent_id: { tool, id, model }` with `"pi"` as a known tool; session id = `SHA256("<tool>:<conversation_id>")[0..14]`; human key = `SHA256("<committer string>")[0..14]`.

The two tools occupy **different lifecycle phases** and share no mutable state, so they coexist cleanly:

- **Git AI** owns the *post-commit* record: `refs/notes/ai` + its own working state (managed by its daemon). We never write to `refs/notes/ai` while the `git-ai` binary is installed.
- **coedit** owns the *live, pre-commit* state in `<git-common-dir>/coedit/` (`state.json`, `events.jsonl`, `lock`). Nothing Git AI reads or writes touches this directory.
- **Read interop:** `/coedit doctor` detects Git AI (`git-ai --version`); `/whose` and the gutter read existing `refs/notes/ai` notes read-only to enrich *committed* line views when present (core `readGitAiNote`).
- **Write interop:** core `exportGitAiNote(commit)` produces a **standard-compliant authorship log** from our events (agent lines → `s_…::t_…` keys computed per the spec; human lines → `h_` keys from the git committer identity; metadata with `sessions`/`humans` maps). Attaching it with `git notes --ref=ai` is allowed **only when `git-ai` is absent** (config `gitai.attachNotes`, default: on when absent, off when present) — when Git AI is installed, its checkpoint pipeline owns that ref and we never duplicate or conflict with it.

This satisfies "interoperate, never duplicate or conflict" without an ASK: there is no scenario where both tools write the same ref.

## 1. Architecture

```
packages/
  core/          @coedit/core (private) — store, snapshots, diff, attribution, git plumbing, Git AI note codec
  pi-coedit/     pi plugin — watcher, bash-window snapshots, overwrite guard, context notes, footer, /whose, /coedit, coedit_whose
  coedit-gutter/ VS Code extension — live coloured gutters, human-edit sensor, hover, revert, status bar
  pi-bisect/     pi plugin — shadow history in refs/coedit/edits/<session>, /bisect with worktree binary search, revert-one-edit
  pi-ledger/     pi plugin + CLI — per-commit cost notes on refs/notes/pi-ledger, show/blame/range/report
```

Key engine decisions:

- **Store** at `<git-common-dir>/coedit/` (shared across worktrees; events carry a `worktree` field so multi-worktree attribution stays correct). `state.json` (`schemaVersion`, migrated on load) + append-only `events.jsonl` + `lock` (pid+timestamp, stale recovery by pid liveness and age, `O_EXCL`). All writes atomic (temp+rename); corrupted store → backup to `coedit/backup-<ts>/`, fresh start, warning surfaced.
- **Diff:** built-in Myers line diff (no dependency), hunks with 0 context; `git diff --no-index` not needed at runtime — Myers keeps behaviour identical on every machine and is testable. CRLF handled by comparing `\r`-stripped lines; binary detection (NUL in first 8 KiB) skips hunks.
- **Attribution** carries line origins forward across events. Baseline = content at `HEAD` (tracked) or first-seen content (untracked). Origins: `unchanged`, `human`, `agent`, `both`, `unknown`. Rules: paired del/ins lines combine origins (`unchanged`+X→X; X+X→X; human+agent→`both`; anything touched by an `unknown` event→`unknown`); pure insertions take the event author; context keeps origin. Dirty-at-startup lines (≠ HEAD, never observed) are `unknown` — documented limit. Renames: delete+create with equal content hash in one snapshot transition carries the line map (no fuzzy detection — documented limit).
- **Detection** (documented in README with limits): edit/write tool calls → `agent` with full session metadata; bash windows bracketed by `tool_execution_start`/`end` snapshots (git-tracked + untracked-not-ignored, mtime pre-filtered scan) → `agent`; changes outside agent windows or reported by the gutter sensor → `human` (editor is authoritative when present); human change inside an agent bash window → `unknown`, never guessed.
- **Bundling:** every artifact bundles core with esbuild (pi packages: ESM, host packages external; gutter: CJS, `vscode` external) so users install exactly one thing.
- **Tests:** `node --test` on native TS type stripping; golden-file attribution test; 10k-file snapshot benchmark; scripted fixture repos for the pi demos.

## 2. Prompt contradictions / risks log

1. Examples path (`examples/` vs `docs/examples/`) — resolved above, no action beyond this note.
2. `Type` import source (`typebox` vs `@earendil-works/pi-ai`) — following the shipped examples.
3. `pi-ledger` npm name collision — publishing as `pi-coedit-ledger` (bin retained as `pi-ledger` per spec; caveat documented). Included in the step-8 stop-and-ASK summary.
4. VS Code absent on this machine — gutter package + vsix produced; install + screenshots deferred to the owner's machine.
5. `git-ai` not installed here — interop paths built against the spec and exercised with synthetic notes; real end-to-end Git AI test needs the binary.

## 3. Build order

Steps 2–8 as specified in the task, evidence appended to `EVIDENCE.md` after each step, one commit per step on `main`. Stop before repo creation / push / publish.
