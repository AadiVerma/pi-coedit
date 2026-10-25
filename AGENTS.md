# AGENTS.md — rules for agents working in this monorepo

## What this repo is

`pi-coedit` makes AI edits accountable when a human and the [pi coding agent](https://github.com/earendil-works/pi) work in the same repo: live line attribution (human / agent / both / unknown), overwrite protection, agent-edit bisect, and per-commit agent cost. It **extends** [Git AI](https://github.com/git-ai-project/git-ai) (post-commit attribution); it never writes to `refs/notes/ai` while the `git-ai` binary is installed — see `docs/PLAN.md` §0.2.

## Layout

- `packages/core` — `@coedit/core`, the shared engine (store, snapshots, Myers diff, attribution). Private; bundled into every artifact. Most tests live here.
- `packages/pi-coedit`, `packages/pi-bisect`, `packages/pi-ledger`, `packages/pi-helper-desk`, `packages/pi-brain-dump`, `packages/pi-handoff`, `packages/pi-reflect`, `packages/pi-chat-inventory`, `packages/pi-replay`, `packages/pi-screen-share`, `packages/pi-cache-clock` — pi packages (extensions + commands).
- `packages/coedit-gutter` — VS Code extension (also runs in Cursor/Windsurf via Open VSX).
- `templates/pi-plugin` — skeleton copied by `npm run new <name>`.
- `docs/PLAN.md` — verified environment facts, prior-art notes, Git AI interop decision.

## Scaffolding a new pi package

```bash
npm run new <name>        # creates packages/<name> from templates/pi-plugin
npm install               # link the new workspace
npm run build             # bundle with esbuild (core inlined, host packages external)
```

Then fill in `src/index.ts` and the README. Keep the name unique and lowercase; never collide with the registry below.

## pi package rules (enforced by `npm run check`)

- Host-provided packages — `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `typebox` — go **only** in `peerDependencies: "*"`, never in `dependencies`, and are never bundled (esbuild `external`).
- The `"pi"` manifest in `package.json` points at the **bundled** `dist/index.js`; the `pi-package` keyword lists the package in the pi.dev gallery.
- Runtime `dependencies` require owner approval; prefer Node built-ins and the `git` CLI.
- Start watchers/timers in `session_start`, clean them up in `session_shutdown` — never in the factory.
- Guard TUI-only behaviour with `ctx.mode === "tui"` and dialog usage with `ctx.hasUI`.

## Command & tool name registry

Every pi command and tool name must be unique across the monorepo. `npm run check` fails on duplicates found in source. Current registry:

| Package | Commands | Tools |
|---|---|---|
| pi-coedit | `/whose`, `/coedit` (status, reset, doctor) | `coedit_whose` |
| pi-bisect | `/bisect` (`--from`, `--runs`, `--timeout`; subcommands `gc`) | — |
| pi-ledger | `/ledger` (install, show, blame, range, report) | — |
| pi-helper-desk | `/helpers` | `plan` |
| pi-chat-handoff (packages/pi-handoff) | `/handoff` | — |
| pi-reflect | `/reflect` | — |
| pi-chat-inventory | `/inventory` | — |
| pi-replay-theater (packages/pi-replay) | `/replay` | — |
| pi-screen-share | `/screen-share` (toggle) | — |
| pi-cache-clock | `/cache-clock` (ttl, warm, hide) | — |
| pi-brain-dump | `/brain-dump` (toggle) | — |

## Testing locally

- `npm run check` — registry check, typecheck, all tests.
- `pi install ./packages/<name>` (or `pi -e ./packages/<name>` for a one-shot run) after `npm run build`.
- VS Code: open `packages/coedit-gutter`, press F5 ("Run Extension") or install the packaged `.vsix`.
- Fixture repos live under a temp dir (`mktemp -d`), never in this repo.

## House rules

- Core changes need core tests; every package keeps `README.md` and `CHANGELOG.md` current; changesets for user-visible changes.
- No secrets in files, logs or notes; prompt excerpts are capped at 200 chars and switchable off (`privacy.promptExcerpts: false`).
- **Never publish or push without the owner's explicit OK.**
