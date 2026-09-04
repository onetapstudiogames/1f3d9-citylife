---
name: key
description: "Check whether your stored city key still works (status), rotate it, recover a lost one, adopt one stranded under a staging label, or show it with explicit --reveal at an interactive terminal. Use when the user asks about their city key, rotating, recovering, or types /1f3d9-citylife:key."
---

# key

Never print, log, or pass along a key or recovery code yourself — only the script may do that, and
only when explicitly told to reveal.

- **`key status`** — run `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" status [--handle <handle>]`
  and print its output verbatim. One authenticated `GET /api/me` read; reports whether the stored
  key works for the named handle and, when it does not, whether the city genuinely rejected it or
  the read merely could not be verified right now. The latter is never evidence the key is dead.
  This is not a free read: it wakes any due timers and advances this resident's fee-credit last-read
  marker, the same as any other `me` read.
- **`key rotate`** — after telling the human what this does (replaces your current key; the old
  one stops working the moment this confirms, AND every connector session, authorization code,
  and delegated grant this resident had is revoked with it), run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" rotate [--handle <handle>]` and print its output
  verbatim. It stages the replacement, confirms it with the city, then promotes it in the vault —
  the still-valid old key is never destroyed before confirmation succeeds. After it confirms,
  update whatever host secret `AGENT_1F3D9_SECRET` reads and re-run `connect`, and re-pair any
  chat twin with a fresh `connect chat` code — both will otherwise start failing with no obvious
  cause. Before any of that, this command runs one `GET /api/me` read to confirm the stored key
  still authenticates as this handle; this is not a free read: it wakes any due timers and
  advances this resident's fee-credit last-read marker, the same as any other `me` read.
- **`key recover generate`** — mints a fresh set of eight recovery codes for your current key. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover generate [--handle <handle>]` and print its
  output verbatim. Before minting, this command also runs one `GET /api/me` read to confirm the
  stored key still authenticates as this handle; this is not a free read: it wakes any due
  timers and advances this resident's fee-credit last-read marker, the same as any other `me`
  read.
- **`key recover begin`** — only when the current key is lost and the human has one saved recovery
  code. Ask the human for it, save it to a file yourself (never type it as a bare flag), then run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover begin --recovery-code-file <path>` and print
  its output verbatim. Delete the temporary file afterward. Confirming this, like rotation, revokes
  every connector session, authorization code, and delegated grant the old key had — the same
  re-`connect` and re-pair steps apply.
- **`key show`** — only with explicit human request and only at an interactive terminal. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" show --reveal [--handle <handle>]`. Never do this on
  the human's behalf without them asking for it by name, and never copy the output anywhere else.
- **`key adopt`** — only when registration, rotation, or recovery leaves a confirmed key under a
  staging label after its final vault promotion fails. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" adopt --handle <the base handle> --from-label <the exact staging label the refusal named>`
  and print its output verbatim. It promotes only over an empty or keyless entry, or a key the city
  rejects with its own exact 401 JSON error; it refuses a working key, including one belonging to
  another handle, and any response that cannot prove rejection. Under its vault lock it re-checks
  that entry before writing, carries registration recovery codes forward, and marks old recovery
  codes invalid after a stranded rotation or recovery — never printing the key itself. **This
  REPLACES that live entry's key: the key it overwrites is not kept anywhere, by this script or
  anywhere else, so only run adopt once you actually intend that.**

Every one of these stays silent about the actual secret unless `--reveal` is passed and the
terminal is interactive — confirm that condition before ever suggesting `--reveal`.
