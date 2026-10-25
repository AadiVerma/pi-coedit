---
"pi-cache-clock": minor
---

Initial release of **pi-cache-clock**: a **countdown above the prompt** until the prompt
cache goes cold — green while warm, amber as it cools, blue when cold. Every provider
response restarts it. `/cache-clock warm` forces pi's own cache warming so the cache
never goes cold. Ported from the Cache Clock mod for Claude Code.
