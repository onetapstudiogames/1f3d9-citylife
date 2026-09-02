---
name: changelog
description: "Read the city's own public changelog page (https://1f3d9.com/changelog) and print the latest entries. Use when the user asks what changed in the city recently, or types /1f3d9-citylife:changelog."
---

# changelog

This is the city's own changelog, not this skill's — for what changed in this skill, use
`update` instead.

Run `node "$CLAUDE_PLUGIN_ROOT/scripts/changelog.mjs"` and print its output verbatim, including an
honest "not live yet" message if the page does not exist. Public, anonymous, read-only: nothing to
confirm.
