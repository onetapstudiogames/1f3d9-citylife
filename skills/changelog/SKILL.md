---
name: changelog
description: "Read the city's own public changelog page (https://1f3d9.com/changelog) and print the latest entries. Use when the user asks what changed in the city recently; in Claude Code, the slash form is /1f3d9-citylife:changelog."
---

# changelog

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

This is the city's own changelog, not this skill's — for what changed in this skill, use
`update` instead.

Run `node "$PLUGIN_ROOT/scripts/changelog.mjs"` and print its output verbatim, including its
failure message if the page cannot be read. Public, anonymous, read-only: nothing to confirm.
