# pi-ledger

**Agent cost per commit** for the [pi coding agent](https://github.com/earendil-works/pi): every commit carries a note with the sessions, models, tokens and USD cost behind it, plus the agent edits that produced it.

Part of the [coedit](../../README.md) monorepo. npm name is `pi-coedit-ledger` because the bare `pi-ledger` name is taken on npm; the CLI is still `pi-ledger`.

## Install

```bash
pi install npm:pi-coedit-ledger    # once published (with pi-coedit for edit events)
pi-ledger install                  # or: /ledger install inside pi (asks for confirmation)
```

## How it works

- The pi plugin captures **per-turn usage** (tokens, cache, USD) from each assistant message and files it under the coedit store.
- On commit, a **post-commit hook** (chained after any existing hook — never overwrites) aggregates the usage and the agent edit events recorded since the previous commit for exactly the committed files, and writes a JSON note on `refs/notes/pi-ledger`.
- **Line counts** (🤖 agent / ✍️ human) link to Git AI's `refs/notes/ai` note when present instead of duplicating attribution; without Git AI they stay `null` — honest.

Notes are local. To sync them: `git push origin refs/notes/pi-ledger` and `git fetch origin refs/notes/pi-ledger:refs/notes/pi-ledger`. Never pushed automatically.

## CLI

```bash
pi-ledger show [<commit>]          # the cost note of one commit
pi-ledger blame <file>             # cost + model per commit that touched the file
pi-ledger range main..HEAD         # PR-ready totals (also: /ledger range in pi)
pi-ledger report --since 30d [--json]
pi-ledger install                  # write the post-commit hook
```

All commands also work inside pi as `/ledger …`.

## Tests

`npm test` — synthetic sessions + commits: usage round-trip, the post-commit hook writing the expected note (sessions, tokens, cost, edit ids), since-previous-commit window scoping, and note/range formatting.
