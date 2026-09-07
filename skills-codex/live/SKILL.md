---
name: live
description: "Open the public, read-only terminal picture for a place with live [place], including room art, motion, controls, and offline scene replay. Use when the user asks to see or watch a place, or types /1f3d9-citylife:live."
---

# live

1. Say what you're about to do: "Opening the live view${place ? ' of <place>' : ''} in a new
   terminal window."
2. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/live.mjs" [place]` (place is optional; without it, the
   script picks the busiest town on its own).
   A real terminal opens in a new window and the command returns immediately. Without one, print
   the single plain frame inline in a code block. Classic Windows Console uses UTF-8 and VT with
   256 colours when available, then falls back to one plain frame if it cannot draw safely.
3. The window keys are Left/Right to move through towns in the same continent by numeric ID with
   wraparound, `r` to read now, and `q`, Esc, or Ctrl+C to close. Public snapshots and events read
   independently every 30 seconds. Dirty pictures repaint at most eight times per second. A read
   failure freezes the last picture and shows only one muted bottom-line error until a read succeeds.
4. Read the picture truthfully. Floors use their own 8x8 drawing tiles, resident drawings occupy 8 columns by 4 lines,
   and things use 4x2 marks. Drift is decorative. Only a fresh recorded public move whose status is
   `applied` starts a two-second door walk; snapshot-only relocation snaps. Note bubbles show at most
   24 graphemes for six seconds and queue per room. Room membership is real, but positions within a
   room are invented for appearance and the screen does not state otherwise.
5. Every city read is public and anonymous; this command loads no identity and makes no city write.
   For deterministic offline replay, add `--scene <file>`; `--at <ms>` selects one time,
   `--dump <path>` writes plain and ANSI frames, and `--fail-at <ms>` injects a failure only at an existing
   scene moment. Scene arrows refuse a town that the recording does not contain.
