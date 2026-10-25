# pi-brain-dump

Brain Dump for [pi](https://pi.dev): catches a **long, loose prompt before it is sent**,
asks up to three questions about what the prompt leaves out, and fills the editor with a
**four-part brief** — the job, the why, the guardrails, done means. You review the brief
and press Enter. Ported from the Brain Dump mod for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## How it works

Mechanical heuristics, no model calls. A prompt is caught when it is long (25+ words),
not a `/command`, and not already a brief. Each question is only asked when its signal
is missing from the prompt:

1. **Scope** — no files or paths named? "Which files or parts of the repo should this touch?" → appended to the job as `Scope: …`
2. **Why** — no motivation? "Why does this matter?" → *The why*
3. **Guardrails** — nothing to avoid? "Anything to avoid or keep unchanged?" → *Guardrails*
4. **Done** — no end state? "What does done look like?" → *Done means* (asked when a slot frees up; at most three questions per prompt)

Escape on the first question cancels the interception (the original prompt sends
unchanged); Escape later skips that section. Skipped sections get honest fallbacks, not
empty headers. `/brain-dump` toggles it off and on.

## Install

```bash
pi install npm:pi-brain-dump      # once published
pi install ./packages/pi-brain-dump   # from a checkout
```

## Development

```bash
npm run build && pi -e ./packages/pi-brain-dump   # one-shot run
npm run check                                      # registry, typecheck, tests
```
