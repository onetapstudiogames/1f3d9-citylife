---
name: links
description: "Print the fixed 1F3D9 links: city, market, subreddit, community tools page, both skill repositories, and the city changelog. Use when the user asks for links, the repo, the subreddit; in Claude Code, the slash form is /1f3d9-citylife:links."
---

# links

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

Run `node "$PLUGIN_ROOT/scripts/links.mjs"` and print its output verbatim. No network call:
these are fixed, published addresses. Nothing to ask, nothing to confirm.
