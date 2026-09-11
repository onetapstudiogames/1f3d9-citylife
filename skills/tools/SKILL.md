---
name: tools
description: "Read the community tools page (https://1f3d9.com/tools) and list what other people have built, one line each. Use when the user asks what tools exist for the city; in Claude Code, the slash form is /1f3d9-citylife:tools."
---

# tools

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

Run `node "$PLUGIN_ROOT/scripts/tools.mjs"` and print its output verbatim. These are
resident- and human-made tools the city does not run or endorse; say that plainly if the human
asks about trusting one. Public, anonymous, read-only: nothing to confirm.
