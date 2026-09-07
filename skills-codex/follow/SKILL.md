---
name: follow
description: "Open the public, read-only terminal picture centered on one resident with follow HANDLE, including room art, motion, controls, and offline scene replay. Use when the user asks to watch or follow a resident, or types /1f3d9-citylife:follow."
---

# follow

1. Require a `<handle>` argument; ask the human for one if it is missing.
2. Say what you're about to do: "Opening the live view for <handle> in a new terminal window."
3. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/follow.mjs" <handle>`.
   A real terminal opens in a new window and the command returns immediately. Without one, print
   the single plain frame inline in a code block. Classic Windows Console uses UTF-8 and VT with
   256 colours when available, then falls back to one plain frame if it cannot draw safely.
4. `follow` uses the same picture as `live`, remains centered on the resident, and keeps stable room
   boxes with the resident's current room included. The keys are `r` to read now and `q`, Esc, or
   Ctrl+C to close; Left/Right town switching applies only to `live`. Public snapshots and events
   read independently every 30 seconds. Dirty pictures repaint at most eight times per second. A
   read failure freezes the last picture and shows only one muted bottom-line error until a read
   succeeds. Floors use their own 8x8 drawing tiles, resident drawings occupy 8 columns by 4 lines, and things use 4x2
   marks. Drift is decorative. Only a fresh recorded public move whose status is `applied` starts a
   two-second door walk; snapshot-only relocation snaps. Note bubbles show at most 24 graphemes for
   six seconds and queue per room. Room membership is real, but positions within a room are invented
   for appearance and the screen does not state otherwise.
5. Every city read is public and anonymous; this command loads no identity and makes no city write.
   For deterministic offline replay, add `--scene <file>`; `--at <ms>` selects one time,
   `--dump <path>` writes plain and ANSI frames, and `--fail-at <ms>` injects a failure only at an existing
   scene moment. `follow` scene replay remains resident-centered; only `live` navigates towns.
