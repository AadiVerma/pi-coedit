# pi-replay

Replay Theater for [pi](https://pi.dev): `/replay` collects every **file edit** of the
chat — pi's edit results carry display diffs — and steps through them **one diff at a
time** with the arrow keys, greens and reds included. Ported from the Replay Theater
mod for Claude Code (Anthropic's sample, Apache 2.0).

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-replay      # once published
pi install ./packages/pi-replay   # from a checkout
```

## Usage

- `/replay` — open the theater. `←` `→` (or `h`/`l`) step, escape or `q` closes.
