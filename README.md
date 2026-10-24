# pi-coedit

**Human-vs-AI edit accountability for the [pi coding agent](https://github.com/earendil-works/pi) and VS Code.**

When a human and the pi agent edit the same repo at the same time, everyone should always know who changed what. coedit makes every agent edit traceable, searchable and costed — **live, before commit** — and stops the agent from silently overwriting human work.

```text
✍️ you 3 files · 🤖 agent 7 · ⚠️ 1 unknown          ← pi footer, live
🟦 you   🟪 agent   🟧 both   ⬜ unclear            ← gutter, line by line
```

## The problem

Git blame only tells you who wrote a line **after** someone commits — and it can't tell a human's keystrokes from an agent's. While the agent works, "everything is green": the model doesn't know you just rewrote the function it's about to edit, you can't tell which of its edits broke the build, and nobody can price a PR by what the agent actually cost.

## The packages

| Package | What it does |
|---|---|
| [`packages/core`](packages/core) | The engine: event store, snapshots, dependency-free diff, per-line attribution, Git AI note codec (private, bundled into every artifact) |
| [`packages/pi-coedit`](packages/pi-coedit) | pi plugin: the agent learns about your edits, can't silently overwrite them, `/whose` shows per-line authorship |
| [`packages/coedit-gutter`](packages/coedit-gutter) | VS Code/Cursor/Windsurf extension: live blue/purple/orange/grey gutters, your keystrokes become the authoritative human signal, 3-way-safe revert of agent changes |
| [`packages/pi-bisect`](packages/pi-bisect) | pi plugin: `/bisect "npm test"` finds the exact agent edit that broke a command and can revert only that edit |
| [`packages/pi-ledger`](packages/pi-ledger) | pi plugin + CLI: per-commit cost notes (`refs/notes/pi-ledger`), `pi-ledger show/blame/range/report` |

Every artifact bundles core with esbuild — users install exactly one thing per tool.

## Demos

> 📸 GIF placeholders (record on a machine with VS Code):
> - human typing in VS Code while pi edits the same file — blue vs purple lines live, overlap turns orange
> - the overwrite guard blocking a stale agent edit, with the human diff in the reason
> - `/bisect "npm test"` naming the culprit edit, prompt and turn
>
> Until recorded: `scripts/demo/run-coedit-demo.mjs [--stale]`, `run-bisect-demo.mjs`, `run-ledger-demo.mjs` run the real pi loop with a scripted offline provider and print the evidence.

## Relationship to Git AI

[Git AI](https://github.com/git-ai-project/git-ai) records attribution **post-commit** as git notes (`refs/notes/ai`, [standard v3.0.0](https://github.com/git-ai-project/git-ai/blob/main/specs/git_ai_standard_v3.0.0.md)) and ships IDE blame plugins. coedit **extends** it with the live layer: pre-commit awareness, overwrite protection, agent-edit bisect, and per-commit cost.

They coexist cleanly: coedit keeps its live state in `<git-common-dir>/coedit/`, never writes `refs/notes/ai` while the `git-ai` binary is installed, reads its notes read-only to enrich committed views, and can attach a standard-compliant authorship log itself when Git AI is absent. Details in [`docs/PLAN.md`](docs/PLAN.md) §0.2.

## Who changed what — detection rules

| Signal | Author |
|---|---|
| Agent `edit`/`write` tool call | 🟪 agent (session, turn, model, capped prompt excerpt) |
| Change inside an agent bash window (snapshot bracketed), no editor report | 🟪 agent |
| Keystroke edit reported by the coedit-gutter sensor, outside agent windows | 🟦 human (authoritative) |
| Human typing landing during an agent bash window | ⬜ unknown — never guessed |
| fs-watch / turn-boundary changes outside agent windows | 🟦 human |
| Dirty vs HEAD but never observed | ⬜ unknown (documented limit) |

Limits and the attribution model are documented in [`packages/core/README.md`](packages/core/README.md).

## Privacy

No secrets in files, logs or notes. Prompt excerpts are capped at 200 chars and switchable off (`privacy.promptExcerpts: false` / `coedit.config.promptExcerpts`). Ledger notes hold tokens and costs, never prompts. Notes are local until you push them.

## Development

```bash
npm install
npm run check        # package checks (incl. command/tool name registry) + typecheck + 54 tests
npm run benchmark -w @coedit/core   # 10k-file snapshot benchmark (cold 269 ms / warm 71 ms)
npm run new <name>   # scaffold a new pi package from templates/pi-plugin
```

The demos run without model credentials: `node scripts/demo/run-coedit-demo.mjs [--stale]`.

## Publishing

MIT. Publishing (npm / VS Code Marketplace / Open VSX) is **never automated** — the owner approves and runs each command. See `EVIDENCE.md` for the build-order evidence, `docs/PLAN.md` for verified facts and the interop decision.
