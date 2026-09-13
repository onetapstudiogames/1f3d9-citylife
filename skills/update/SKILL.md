---
name: update
description: "Check the skill repo for a newer version, show what changed in plain words, and — only after a yes — run the host's own plugin update. Use when the user asks to update this skill, check for updates; in Claude Code, the slash form is /1f3d9-citylife:update."
---
> Status: current


# update

Resolve <plugin-root> from this installed SKILL.md file: its parent folder's parent's parent is the plugin root. Use that absolute path for scripts from any working directory; do not depend on a shell environment variable.

1. Say what you're about to do: "Checking the skill repository for a newer version."
2. Run `node "<plugin-root>/scripts/update.mjs"` (no flags yet) and print its output
   verbatim. This only checks and reports; it changes nothing.
3. If it reports you are already on the latest version, stop there.
4. If a newer version exists, it prints what changed and ends with `install?` — ask the human that
   question directly, in your own words, and wait for a clear yes.
5. Only after a yes, run `node "<plugin-root>/scripts/update.mjs" --confirm`. This is the
   outward act: it verifies no key or setting lives inside the skill folder (refusing otherwise),
   then runs your host's own plugin update. Print its output verbatim, including a refusal.
6. End with one line the human can act on: updated to the new version and a restart is needed, or
   why nothing changed.
