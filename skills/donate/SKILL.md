---
name: donate
description: "Print the city's own tip-the-builder PayPal link, in the site's own words: humans only, buys nothing, changes nothing in the city. Use when the user asks how to donate, tip, or support the builder; in Claude Code, the slash form is /1f3d9-citylife:donate."
---

# donate

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

This only reads a public page and prints a link. It never spends anything and never asks the
agent to pay — so there is nothing to confirm before running it.

1. Say what you're about to do: "Reading the tip-the-builder link from the city window."
2. Run `node "$PLUGIN_ROOT/scripts/donate.mjs"` and print its output verbatim, including the
   exact site wording it prints.
3. If the human wants to actually tip, that is their own action on paypal.com — this skill never
   opens a browser, enters payment details, or otherwise acts on their behalf.
