# Changelog

## 0.1.0

- Initial release: the `input` gate catches long, loose prompts (25+ words, not a
  command, not already a brief), asks up to three keyed gap questions (scope, why,
  guardrails, done — only for missing signals), and fills the editor with the four-part
  brief. Escape-first cancels; `/brain-dump` toggles.
