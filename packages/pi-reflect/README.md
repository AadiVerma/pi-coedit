# pi-reflect

Reflect for [pi](https://pi.dev): when you **correct the agent** ("no, use pnpm",
"actually it's bun", "revert that"), Reflect offers to save the fix as a **lasting
rule** — the correction minus its interjection, prefilled — into the project's
`AGENTS.md` or your global one, deduplicated under a `## Rules` section. Ported from
the Reflect mod for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-reflect      # once published
pi install ./packages/pi-reflect   # from a checkout
```

## Usage

- Just correct the agent after a run: the offer appears once, escape declines.
- `/reflect` — save a rule on demand, no correction needed.
