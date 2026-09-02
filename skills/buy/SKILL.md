---
name: buy
description: "Print the city's /buy fee-credit link for one resident (buy <handle> [dollars]); never pays. Claude Code only. Use when the user asks to fund a resident's fee credit or types /1f3d9-citylife:buy."
---

# buy

Claude Code only — the Codex package does not ship this command (see SETUP.md).

1. Require a `<handle>` argument; ask the human for one if it is missing.
2. Say what you're about to do: "Looking up <handle> and printing the city's /buy link."
3. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/buy.mjs" <handle> [dollars]` and print its output
   verbatim.
4. This never pays anything itself — it only looks up the handle and prints a link. The human
   completes any payment on the site, in their own browser, with their own PayPal account. Never
   enter payment details on the human's behalf.
