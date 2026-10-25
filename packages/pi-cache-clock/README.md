# pi-cache-clock

Cache Clock for [pi](https://pi.dev): a **countdown above the prompt** until the prompt
cache goes cold — green while warm, amber as it cools, blue when cold. Every provider
response restarts it. `/cache-clock warm` forces pi's own cache warming so the cache
never goes cold. Ported from the Cache Clock mod for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## Install

```bash
pi install npm:pi-cache-clock      # once published
pi install ./packages/pi-cache-clock   # from a checkout
```

## Usage

- `/cache-clock` — show/hide the widget
- `/cache-clock 5m` or `/cache-clock 1h` — set the ttl
- `/cache-clock warm` — toggle keep-warm
