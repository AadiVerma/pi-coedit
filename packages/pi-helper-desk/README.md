# pi-helper-desk

Helper Desk for [pi](https://pi.dev): the agent's plan draws as a **purple progress bar
above the prompt** — dot, title, a gradient of blocks that fills as steps finish, a
`Tasks 2/4` pill and a percent, with the step in progress shimmering mid-gradient on a
dim line underneath. `/helpers` opens the desk in the Claude mod's side-pane style: the
plan as a checklist, one **π pet card per subagent** (a pixel π mascot in one of 8 hues
— red, orange, yellow, green, teal, blue, purple, pink — that hops and blinks while its
subagent runs and stands still when done) under colored group headings (green Running,
yellow Finished, red Stopped), and a live feed of the chat's tool calls in their kind
colors. Ported from the Helper Desk mod for Claude Code.

Part of the [coedit](../../README.md) monorepo.

## How it works

Helper Desk registers a `plan` tool whose prompt guidelines ride on the tool itself: call
`plan` first for any task with 2 or more steps, send the whole list every time a step
finishes, and mark the last step completed before the final answer. If the agent still
works without a plan, the first tool result of the run carries a one-line nudge.

The plan lives in the `plan` tool's result details and is rebuilt from the session branch,
so forking or `/tree` lands on the right plan automatically. A finished plan holds at 100%
for 20 seconds, then the bar goes away until the next plan. If a subagent extension such
as `@tintinweb/pi-subagents` is installed, each `Agent` launch gets its own pet card: it
appears under Running the moment the call starts, moves to Finished (✓) or Stopped (✗)
when the result lands, and never shares a hue with another running subagent.

## Install

```bash
pi install npm:pi-helper-desk      # once published
pi install ./packages/pi-helper-desk   # from a checkout
```

## Usage

- Just work: when the agent plans, the bar appears above the prompt and moves.
- `/helpers` — open the pane: the plan checklist plus the last tool calls as a live step
  feed. Escape closes.

## Development

```bash
npm run build && pi -e ./packages/pi-helper-desk   # one-shot run
npm run check                                       # registry, typecheck, tests
```
