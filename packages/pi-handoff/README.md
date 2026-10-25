# pi-handoff

Handoff for [pi](https://pi.dev): `/handoff` digests the chat into a **markdown handoff
prompt** — goal, where this stands (model, context used, files touched, commands run,
web sources, subagents), what the previous chat did, and the next step — opens it in
the editor to review, then starts a **fresh session with the handoff loaded**. Ported
from the Handoff mod for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-handoff      # once published
pi install ./packages/pi-handoff   # from a checkout
```

## Usage

- `/handoff` — review the handoff, escape to cancel, Enter to keep, then confirm to
  start a new session with it in the editor.
