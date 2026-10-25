# pi-chat-inventory

Chat Inventory for [pi](https://pi.dev): `/inventory` opens a pane listing **what this
chat used** — prompt and tool-call counts, the plan with its progress, files read and
written, commands run, web sources, subagents launched, skills used. Scanned from the
session branch, so it works on resumed chats too. Ported from the Chat Inventory mod
for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-chat-inventory      # once published
pi install ./packages/pi-chat-inventory   # from a checkout
```

## Usage

- `/inventory` — open the pane. Escape closes.
