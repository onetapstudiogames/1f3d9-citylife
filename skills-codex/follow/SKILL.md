---
name: follow
description: "Open the public, read-only terminal picture centered on one resident with follow HANDLE, including the in-window resident picker and offline scene replay. Use when the user asks to watch or follow a resident, or types /1f3d9-citylife:follow."
---

# follow

1. Require a `<handle>` argument; ask the human for one if it is missing.
2. Say what you're about to do: "Opening the city picture for <handle> in a new terminal window."
3. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/follow.mjs" <handle>`.
   Claude Code and Codex use this same launcher on Windows and macOS. A real terminal opens in a new
   window and the command returns immediately. Without one, print the single plain frame inline in a
   code block. Classic Windows Console uses UTF-8 and VT with 256 colours when available, then falls
   back to one plain frame if it cannot draw safely. After launching the window, print its one-line
   result and stop; do not read or narrate the room in chat.
4. The picture shows only the followed resident's current room, its current residents and things,
   and public actions first observed after this view opened. It never displays older notes.
   It automatically changes to the resident's new current room after a public refresh. A quiet room,
   including one inside a quiet place, conceals its contents. Room membership is real; positions
   within the room and drift are decorative. The floor uses its own 8x8 tile and resident drawings
   use 8 columns by 4 lines. It draws at most five 4x2 thing marks; up to 12 dots, further limited by
   room width, show that more things exist. Within the remaining space, the followed resident gets
   first placement; crowded rooms may omit other resident marks. Only a fresh recorded move with
   `applied` status starts a
   two-second door walk; relocation found only in refreshed state snaps. Fresh notes have a
   six-second bubble preview, up to three lines wide enough for the room. Their full text and
   short descriptions of recorded activity appear in a small bottom history that you scroll
   yourself. It shows three rows at 24 lines tall, two at 20, one at 14, and none below 14; the
   history remains while hidden. Long entries wrap in full, with a small speaker prefix on
   continuation lines where width allows. It keeps the most recent 200 entries this open view actually witnessed,
   in memory only, including across room moves. It never fills in old arrival notes or off-room
   activity. A quiet room or selected-resident change clears it under the privacy contract.
   Names below residents and things are muted, shorten after 18 terminal cells,
   and disappear if no space fits. Little z marks appear only for residents publicly marked asleep.
   Short effects require matching fresh public records: creation puffs; an error-free `applied` or
   `noop` use glows; withdrawal or an error-free applied consume crumbles; gift and effect transfers
   float only between two visible, still residents; and carry requires the exact paired move and
   thing-moved records. Old, failed, incomplete, off-room, or inferred actions stay unanimated.
5. Press `f` for the resident picker in the same window, type to filter, use Up/Down to choose, Enter
   to follow, or Esc to cancel. Outside the picker, Up/Down moves the history one line,
   PageUp/PageDown one page, Home to the oldest entry, and End to the newest. New entries follow
   the bottom only if it was already visible; reading older entries holds the same text in view.
   There are no history timers. `r` or Enter reads now; returning focus to a
   terminal that reports focus does the same. Each successful 30-second public refresh fully
   repaints the picture, so a restored terminal stream catches up even when the city has not
   changed. `q` or Esc closes; Ctrl+C always closes. Dirty pictures repaint at most eight times per
   second. A failed read freezes the last picture and shows one muted bottom-line error until a read
   succeeds. Choosing another resident clears the old picture and history immediately; a failed
   replacement read leaves the cleared view with an error, and the picker keeps the last known
   public resident list available. A dead SSH connection must be reconnected outside the picture; it can repaint only
   after its terminal stream returns. Every read is public and anonymous; the command loads no identity and makes no city
   write. For deterministic offline replay, add `--scene <file>`;
   `--at <ms>` selects one time, `--dump <path>` writes plain and ANSI frames, and `--fail-at <ms>`
   injects a failure only at an existing scene moment.
