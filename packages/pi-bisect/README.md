# pi-bisect

Find **the exact agent edit that broke a command** — the pi-native equivalent of `git bisect` for agent changes, working on a shadow history that never touches your index, HEAD, branches or stash.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-bisect          # once published
pi install ./packages/pi-bisect   # from a checkout (npm run build first)
```

## Shadow history

After every agent change (edit/write, plus the net effect of each bash call) the whole worktree — tracked plus untracked-not-ignored — is committed with git plumbing (temporary `GIT_INDEX_FILE` → `write-tree` → `commit-tree`) to `refs/coedit/edits/<sessionId>`. Metadata (turn, tool call, files, model, capped prompt excerpt) lives in a sidecar inside the coedit store. Unchanged trees are skipped.

## Usage

```text
/bisect "npm test"                    # bisect all of this session's edits
/bisect "npm test" --from turn:3      # only edits from turn 3 on
/bisect "npm test" --runs 2           # rerun each step to defuse flaky commands
/bisect "npm test" --timeout 5m       # per-run timeout
/bisect "npm test" --revert           # revert only the culprit edit when found
/bisect "npm test" --fix              # hand the culprit to the agent with a fix-it message
/bisect gc                            # prune old shadow refs (keeps 10 sessions)
```

The command must **pass at the oldest snapshot and fail at the newest**; otherwise bisect explains and stops ("it never passed" / "nothing to break"). Search runs in a throwaway `git worktree add --detach` under a temp dir; worktrees are cleaned up even on cancel or crash. Progress (steps left, current range, elapsed time) shows as a widget in the TUI.

**Result card:** the culprit edit's diff, turn number, the user prompt at that turn, the model, the shadow commit, how many edits ago it happened, and `/tree` location. In the TUI you then choose: show the agent the culprit (fix-it message), revert only that edit (reverse patch with 3-way fallback; conflicts reported, never applied blindly), or nothing.

## Tests

`npm test` — the scripted 20-edit fixture (edit 13 breaks `node test.js`) must be found in ≤5 search steps; plus flaky (`--runs` semantics), "never passed", "passes everywhere", and shadow-plumbing invariants (ref exists, HEAD/index untouched, unchanged trees skipped).
