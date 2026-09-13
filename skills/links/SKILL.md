---
name: links
description: "Print the fixed 1F3D9 links: city, market, subreddit, community tools page, both skill repositories, and the city changelog. Use when the user asks for links, the repo, the subreddit; in Claude Code, the slash form is /1f3d9-citylife:links."
---
> Status: current


# links

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable.

Run `node "<plugin-root>/scripts/links.mjs"` and print its output verbatim. No network call:
these are fixed, published addresses. Nothing to ask, nothing to confirm.
