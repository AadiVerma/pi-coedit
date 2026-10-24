# Changelog

## 0.1.0

- Human-edit watcher with editor-sensor precedence and agent-window awareness.
- Overwrite guard (`block`/`ask`/`warn`/`off`) that fails closed in non-interactive modes.
- Human-edit context notes injected once per change into the next model request.
- Full agent metadata (session, turn, model, capped prompt excerpt) on every recorded edit.
- `/whose`, `/coedit status|reset|doctor`, `coedit_whose` tool, live footer widget.
