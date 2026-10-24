# Changelog

## 0.1.0

- Shadow history: one plumbing commit per agent change under `refs/coedit/edits/<sessionId>` with a metadata sidecar; never touches index/HEAD/branches.
- `/bisect` binary search over snapshots in throwaway detached worktrees with endpoint verification, `--runs` flake defence, `--timeout`, live progress widget, and guaranteed worktree cleanup.
- Result card with culprit diff, turn, prompt excerpt, model, edits-ago, session-tree pointer.
- Actions: revert only the culprit edit (reverse patch, 3-way fallback, conflict reporting) or send the agent a fix-it message; `/bisect gc`.
