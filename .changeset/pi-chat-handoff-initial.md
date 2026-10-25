---
"pi-chat-handoff": minor
---

Initial release of **pi-chat-handoff**: `/handoff` digests the chat into a **markdown handoff
prompt** — goal, where this stands (model, context used, files touched, commands run,
web sources, subagents), what the previous chat did, and the next step — opens it in
the editor to review, then starts a **fresh session with the handoff loaded**. Ported
from the Handoff mod for Claude Code.
