---
name: help
description: "List every 1F3D9 city-life command in one sentence each, then the three links a human needs first (city, market, subreddit). Use when the user asks what this skill can do, wants a command list, or types /1f3d9-citylife:help."
---

# help

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/help.mjs"` (the plugin root env var is set for both Claude
Code and Codex) and print its output verbatim. It costs no network call and no extra tokens: read
nothing else, render nothing yourself, just show what the script printed. End by asking if the
human wants to try one of the listed commands.
