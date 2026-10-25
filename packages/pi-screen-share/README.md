# pi-screen-share

Screen Share for [pi](https://pi.dev): `/screen-share` toggles a markdown transformer
that draws **emails, phone numbers, card numbers, IP addresses and money amounts** as
blocks while you record — URLs keep their host, code stays untouched, and the model
still reads the real data. Only the screen changes. Ported from the Screen Share mod
for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-screen-share      # once published
pi install ./packages/pi-screen-share   # from a checkout
```

## Usage

- `/screen-share` — on, off. Masking applies to the agent's output, never your own text.
