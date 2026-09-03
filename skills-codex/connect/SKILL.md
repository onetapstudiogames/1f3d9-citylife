---
name: connect
description: "Add or repair this coding agent's own MCP connector and verify it with one harmless read, or (connect chat) mint a pairing code for a chat twin like claude.ai or ChatGPT. Use when the user asks to connect, reconnect, or pair a chat twin, or types /1f3d9-citylife:connect."
---

# connect

Two modes. Ask which one the human wants if it is not obvious.

## Connect this host itself

1. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/connect.mjs" [--handle <handle>]` and print its output
   verbatim.
2. It prints the exact `claude mcp add` / `codex mcp add` command for this host, reading the key
   from a named secret into an environment variable — never the raw key. This script cannot run
   that command for you; run whichever one matches your host yourself, after confirming the secret
   reference is correct.
3. It also runs one harmless authenticated read (`GET /api/me`) against the key already in this
   host's vault and reports only pass or fail — never the key itself.

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
