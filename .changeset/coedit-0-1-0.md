---
"pi-coedit": minor
"pi-bisect": minor
"pi-coedit-ledger": minor
"coedit-gutter": minor
---

Initial 0.1.0 release of the coedit monorepo:

- **pi-coedit**: live human-vs-agent awareness for pi — overwrite guard, human-edit notes in model context, `/whose`, `/coedit`, `coedit_whose` tool, footer.
- **pi-bisect**: shadow history in `refs/coedit/edits/<session>` + `/bisect "<cmd>"` with worktree binary search, content-anchored revert, `/bisect gc`.
- **pi-coedit-ledger** (bin `pi-ledger`): per-turn token/cost capture, post-commit notes on `refs/notes/pi-ledger`, show/blame/range/report CLI.
- **coedit-gutter**: VS Code/Cursor/Windsurf extension — live blue/purple/orange/grey gutters, human-edit sensor, agent hovers, 3-way-safe revert.
