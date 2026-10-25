# Changelog

## 0.1.0

- Initial release: `plan` tool with prompt guidelines, purple progress bar above the
  prompt (branch-aware, holds 20 s at 100%), one-shot no-plan nudge, and a `/helpers` desk
  with the plan checklist, a π pet card per subagent (8 hues, hop/blink animation, Claude's
  never-share-a-hue rule), colored Running/Finished/Stopped group headings, and a
  kind-colored tool-call feed. Subagent cards respect pi-subagents' background mode:
  a background Agent call stays Running (pet hopping) until its result is collected,
  a foreground one finishes with the call, and an errored spawn shows Stopped.
