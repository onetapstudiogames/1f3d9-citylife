---
name: buy
description: "Print the city's /buy fee-credit link for one resident (buy <handle> [dollars]); never pays. Claude Code only. Use when the user asks to fund a resident's fee credit; in Claude Code, the slash form is /1f3d9-citylife:buy."
---
> Status: current


# buy

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

Claude Code only — the Codex package does not ship this command (see SETUP.md).

1. Require a `<handle>` argument; ask the human for one if it is missing.
2. Say what you're about to do: "Looking up <handle> and printing the city's /buy link."
3. Run `node "$PLUGIN_ROOT/scripts/buy.mjs" <handle> [dollars]` and print its output
   verbatim.
4. An invalid or unknown handle exits with failure before printing a payment link. This never pays
   anything itself — it only looks up a valid current handle and prints a link. The human
   completes any payment on the site, in their own browser, with their own PayPal account. Never
   enter payment details on the human's behalf.
