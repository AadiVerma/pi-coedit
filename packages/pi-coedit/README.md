# pi-coedit

Live **human-vs-agent edit awareness** for the [pi coding agent](https://github.com/earendil-works/pi). When you and pi work in the same repo at the same time, pi knows what you changed, can't silently overwrite it, and every agent edit is traceable.

Part of the [coedit](../../README.md) monorepo. Complements [Git AI](https://github.com/git-ai-project/git-ai) (post-commit notes) with the live, in-session layer.

## Install

```bash
pi install npm:pi-coedit          # once published
pi install ./packages/pi-coedit   # from a checkout (npm run build first)
pi -e ./packages/pi-coedit        # one-shot try
```

## What it does

- **The agent is told about your edits.** When a file the agent has touched changes under you, the next model request gets a short note with your diff (capped, once per change): *"The user edited these lines; keep their changes."*
- **Overwrite guard.** An `edit`/`write` against a file with human changes since the agent last read it is blocked with a re-read-and-merge reason. In the TUI you choose: re-read and merge (default), allow anyway, or cancel. Policy: `block` / `ask` (default) / `warn` / `off`.
- **Footer.** `✍️ you 3 files · 🤖 agent 7 · ⚠️ 1 unknown` — shown only when something changed.
- **Attribution.** Agent edits via `edit`/`write` **and via bash** (snapshot windows bracketed around every bash call) are recorded with session, turn, model and capped prompt excerpt.
- **`/whose [file]`** — per-line 🟦 human · 🟪 agent · 🟧 both · ⬜ unknown with agent session details.
- **`/coedit status | reset | doctor`** — store, watcher, policy, Git AI coexistence check.
- **`coedit_whose` tool** — read-only, so the agent can ask what you changed.

## Configuration

Settings live in the coedit store (`<git-common-dir>/coedit/state.json`), defaults in `@coedit/core`:

| Key | Default | Meaning |
|---|---|---|
| `overwriteGuard` | `ask` | `block` / `ask` / `warn` / `off` |
| `gitaiAttachNotes` | `true` | Attach Git AI–standard notes on commit — only honoured when the `git-ai` binary is absent |
| `promptExcerpts` | `true` | Cap and record first 200 chars of the user prompt per turn |
| `maxHumanDiffChars` | `2000` | Cap for human diffs injected into model context |

## How authorship is decided

See `packages/core/README.md` §detection — the short version: editor sensor (from the coedit-gutter VS Code extension) is authoritative outside agent windows; bash-window changes are the agent's; human typing during an agent bash window is `unknown` (grey), never guessed.

## Demo

`scripts/demo/run-coedit-demo.mjs` builds a fixture repo and runs pi with a scripted offline provider (no model credentials needed): the agent edits `a.js` while a script edits `a.js` and `b.js` as the human, then tries a stale edit that the guard blocks. Run `node scripts/demo/run-coedit-demo.mjs`.
