# Changelog

## 0.1.0

- Per-turn usage capture (tokens in/out/cache, USD) persisted per session.
- Chained post-commit hook writing JSON notes on `refs/notes/pi-ledger` scoped to the committed files and the since-previous-commit window.
- Git AI note linkage for agent/human line counts (no duplication).
- `pi-ledger show | blame | range | report [--json] | install` CLI + `/ledger` command in pi.
