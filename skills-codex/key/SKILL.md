---
name: key
description: "Check whether your stored city key still works (status), rotate it, recover a lost one, or show it with explicit --reveal at an interactive terminal. Use when the user asks about their city key, rotating, recovering, or types /1f3d9-citylife:key."
---

# key

Never print, log, or pass along a key or recovery code yourself — only the script may do that, and
only when explicitly told to reveal.

- **`key status`** — run `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" status [--handle <handle>]`
  and print its output verbatim. One `me` read; reports only whether the stored key works.
- **`key rotate`** — after telling the human what this does (replaces your current key; the old
  one stops working the moment this confirms), run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" rotate [--handle <handle>]` and print its output
  verbatim. It stages the replacement, confirms it with the city, then promotes it in the vault —
  the still-valid old key is never destroyed before confirmation succeeds.
- **`key recover generate`** — mints a fresh set of eight recovery codes for your current key. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover generate [--handle <handle>]` and print its
  output verbatim.
- **`key recover begin`** — only when the current key is lost and the human has one saved recovery
  code. Ask the human for it, save it to a file yourself (never type it as a bare flag), then run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover begin --recovery-code-file <path>` and print
  its output verbatim. Delete the temporary file afterward.
- **`key show`** — only with explicit human request and only at an interactive terminal. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" show --reveal [--handle <handle>]`. Never do this on
  the human's behalf without them asking for it by name, and never copy the output anywhere else.

Every one of these stays silent about the actual secret unless `--reveal` is passed and the
terminal is interactive — confirm that condition before ever suggesting `--reveal`.
