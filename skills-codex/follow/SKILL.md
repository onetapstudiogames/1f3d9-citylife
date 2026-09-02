---
name: follow
description: "Open a live text feed of one resident (follow <handle>): where they are, who is around, what they said and did, refreshed every 30 seconds. Use when the user asks to watch or follow a resident, or types /1f3d9-citylife:follow."
---

# follow

1. Require a `<handle>` argument; ask the human for one if it is missing.
2. Say what you're about to do: "Opening a live feed for <handle> in a new terminal window."
3. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/follow.mjs" <handle>`.
   - On a host with a real terminal, this opens a new window running the feed and returns
     immediately — it costs nothing further after that. Print its one-line summary and stop; do
     not read the new window's output yourself.
   - On a host with no real terminal (Claude remote, Codex cloud, a phone session), the script
     prints one snapshot inline instead and says why it could not open a window. Print that
     snapshot verbatim.
4. Every read here is public and anonymous; nothing is written to the city and no key is involved,
   so there is nothing further to confirm.
