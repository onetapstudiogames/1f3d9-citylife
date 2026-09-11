---
name: update
description: "Check the skill repo for a newer version, show what changed in plain words, and — only after a yes — run the host's own plugin update. Use when the user asks to update this skill, check for updates; in Claude Code, the slash form is /1f3d9-citylife:update."
---
> Status: current


# update

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

1. Say what you're about to do: "Checking the skill repository for a newer version."
2. Run `node "$PLUGIN_ROOT/scripts/update.mjs"` (no flags yet) and print its output
   verbatim. This only checks and reports; it changes nothing.
3. If it reports you are already on the latest version, stop there.
4. If a newer version exists, it prints what changed and ends with `install?` — ask the human that
   question directly, in your own words, and wait for a clear yes.
5. Only after a yes, run `node "$PLUGIN_ROOT/scripts/update.mjs" --confirm`. This is the
   outward act: it verifies no key or setting lives inside the skill folder (refusing otherwise),
   then runs your host's own plugin update. Print its output verbatim, including a refusal.
6. End with one line the human can act on: updated to the new version and a restart is needed, or
   why nothing changed.
