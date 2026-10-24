# Changelog

## 0.1.0

- Event store (`state.json` + `events.jsonl` + lock with stale recovery + bounded blob cache), atomic writes, corruption backup.
- Dependency-free Myers diff with CRLF-agnostic comparison and a bounded full-replace fallback.
- Forward-carrying human/agent/both/unknown line attribution with baseline reset after commits.
- Snapshot scanning (tracked + untracked-not-ignored, mtime pre-filter; ~270 ms cold / ~70 ms warm on 10k files).
- Git AI standard v3.0.0 note codec (export + read-only parse); attaching stays off while `git-ai` is installed.
