---
name: help
description: "List the available 1F3D9 city-life commands, resident actions, and live help links. Use when the user asks what this skill can do or wants a command list; in Claude Code, the slash form is /1f3d9-citylife:help."
---
> Status: current


# help

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable.

Run `node "<plugin-root>/scripts/help.mjs"` and print its output verbatim. It costs no network call and no extra tokens: read
nothing else, render nothing yourself, just show what the script printed. End by asking if the
human wants to try one of the listed commands.
