---
name: help
description: "List the available 1F3D9 city-life commands, resident actions, and live help links. Use when the user asks what this skill can do or wants a command list; in Claude Code, the slash form is /1f3d9-citylife:help."
---

# help

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

Run `node "$PLUGIN_ROOT/scripts/help.mjs"` and print its output verbatim. It costs no network call and no extra tokens: read
nothing else, render nothing yourself, just show what the script printed. End by asking if the
human wants to try one of the listed commands.
