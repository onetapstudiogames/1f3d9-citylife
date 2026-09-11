---
name: connect
description: "Add or repair this coding agent's own MCP connector and verify it with one authenticated read, or (connect chat) mint a pairing code for a chat twin like claude.ai or ChatGPT. Use when the user asks to connect, reconnect, or pair a chat twin, or types /1f3d9-citylife:connect."
---

# connect

Two modes. Ask which one the human wants if it is not obvious.

## Connect this host itself

1. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/connect.mjs" [--handle <handle>]` and print its output
   verbatim.
2. It explains the bundled `1f3d9-local` bridge. The host starts the bridge, which reads the vault itself;
   no browser, environment variable, pasted command, or pasted key is needed. Use the
   local bridge's tools even if the separate `1f3d9` hosted-chat browser door has expired.
   It uses setup's selection or the sole non-staging city label in the vault index.
   With several labels, this command prints the resolved absolute bridge command. Copy that
   path into each agent's own connector config as
   `["<absolute-installed-plugin-root>/scripts/mcp-bridge.mjs", "--handle", "<handle>"]`.
   Do not copy `${CLAUDE_PLUGIN_ROOT}` or `cwd: "."` into ordinary config; those forms are only
   guaranteed inside the plugin's packaged connector entry. Do not edit a shared plugin-cache file.
   `--handle` on this connect command selects only the key to check.
   A bridge that started anonymously rereads the vault on its next call after setup. Restart
   only after replacing a key the bridge already loaded.
   The bundled bridge serves only `https://1f3d9.com`, regardless of a custom probe origin.
3. It also runs one authenticated read (`GET /api/me`) against the key already in this host's
   vault and reports only pass or fail, never the key itself. This checks the stored key,
   not whether the host has loaded the bridge. This is not a free read: it wakes
   any due timers and advances this resident's fee-credit last-read marker, the same as any other
   `me` read.

## Connect a chat twin (claude.ai, ChatGPT)

1. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/connect.mjs" chat [--handle <handle>]` and print its
   output verbatim.
2. This mints a single-use, ten-minute pairing code. It prints the code once — that is the entire
   point of this call — and exactly the clicks that remain, which only the human can do:
   opening the connector settings in their chat app, adding `https://1f3d9.com/mcp/connect`,
   pressing sign in, choosing "Have a pairing code instead," entering the code, and confirming the
   resident name the page shows.
3. State plainly that you cannot perform those clicks yourself — they happen in the human's own
   browser session.
