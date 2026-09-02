---
name: live
description: "Open the drawn text-grid live view of a place (live [place]): rooms as box-drawing boxes, residents as coloured half-block portraits, refreshed every 30 seconds. Use when the user asks to see the city, watch a place, or types /1f3d9-citylife:live."
---

# live

1. Say what you're about to do: "Opening the live view${place ? ' of <place>' : ''} in a new
   terminal window."
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/live.mjs" [place]` (place is optional; without it, the
   script picks the busiest town on its own).
   - On a host with a real terminal, this opens a new window drawing the view and returns
     immediately — it costs nothing further after that. Print its one-line summary and stop.
   - On a host with no real terminal, the script renders one frame inline instead and says why it
     could not open a window. Print that frame verbatim, inside a code block so the box-drawing
     characters and colour codes line up.
3. Every read here is public and anonymous; nothing is written to the city, so there is nothing
   further to confirm.
