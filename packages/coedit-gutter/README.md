# coedit-gutter

Live **human-vs-agent line attribution in the editor gutter** — blue for you, purple for the agent, orange for both, grey for unclear — visible *before* commit, while the agent is still working. Works in VS Code, Cursor and Windsurf (Open VSX).

Part of the [coedit](../../README.md) monorepo. The `pi-coedit` pi plugin records the agent side; this extension records **your** side (it is the authoritative human sensor) and renders both.

## Install

```bash
code --install-extension coedit-gutter-0.1.0.vsix   # built with `npm run package -w coedit-gutter`
```

Marketplace/Open VSX publishing requires the owner's OK (see root README).

## What you get

- **Gutter bar + overview ruler** per line: 🟦 human · 🟪 agent · 🟧 both · ⬜ unknown · nothing for untouched lines — no more "everything is green".
- **A human sensor**: your keystrokes are attributed immediately (unsaved edits too, via a live overlay) and written to the shared store on save. pi sees your edits the moment they matter.
- **Hover on agent lines**: session id, turn, model, capped prompt excerpt, time, and a click-to-copy `pi --session <file>`.
- **Status bar**: `✍️ 42 · 🤖 118` for the active file; click for a repo-wide quick pick.
- **Commands**: next/previous agent change, revert agent changes in this file or the selection (3-way-safe: each hunk is verified against the recorded content; conflicts are reported, never applied blindly), toggle colours, show `/whose` for this file.
- **Settings**: colours (defaults chosen for colour-blind users), line background tint, overview ruler, store path override, debounce.

## How it works

Reads the coedit store (`<git-common-dir>/coedit/`) written by the pi plugin and written to by this extension (editor events). Line origins are carried forward by `@coedit/core`; the mapping to decoration ranges is pure and unit-tested (`test/decoration-map.test.ts`).

## Notes

- Screenshots/GIF: see the root README placeholders (requires a machine with VS Code — this build machine has none).
- `coedit.storePath` can point at an alternative store directory (default `<git-common-dir>/coedit`).
