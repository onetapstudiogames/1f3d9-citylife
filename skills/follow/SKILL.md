---
name: follow
description: "Open a public, read-only terminal picture centered on one resident, with a resident picker in that window. Use when the user asks to watch or follow a resident; in Claude Code, the slash form is /1f3d9-citylife:follow."
---
> Status: current


# follow

Resolve `PLUGIN_ROOT` first: use `$CLAUDE_PLUGIN_ROOT` when it is non-empty; otherwise resolve `../../` from the directory containing this command `SKILL.md` (for example, `<plugin>/skills/help/SKILL.md` resolves to `<plugin>`).

1. Require a `<handle>` argument; ask the human for one if it is missing.
   Terminal follow is resident-only. The live web page can also watch a place without following a resident.
2. Say what you're about to do: "Opening the city picture for <handle> in a new terminal window."
3. Run `node "$PLUGIN_ROOT/scripts/follow.mjs" <handle>`.
   Claude Code and Codex use this same launcher on Windows and macOS. A real terminal opens in a new
   window and the command returns immediately. Without an interactive terminal, refuse and say to
   run the command from one; `--once` remains available for a deliberate single frame. Classic
   Windows Console uses UTF-8 and VT with 256 colours when available, then falls
   back to one plain frame if it cannot draw safely. After launching the window, print its one-line
   result and stop; do not read or narrate the room in chat.
4. The picture shows only the followed resident's current room, its current residents and things,
   and room-proven public events first observed after this view opened. It never displays older notes.
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
   Names that fit stay still. Longer place names at the top, room names in borders, resident and
   thing labels, and resident names in the picker scroll horizontally from beginning to end. They
   pause for 1.6 seconds at each end, move one terminal cell every 400 milliseconds, repeat without
   a permanent ellipsis, and never split wide Unicode characters. Muted resident and thing labels
   use at most 18 cells below their pictures; if 18 cells would overlap another picture, they try a
   narrower strip and disappear only when no strip fits. This motion does not change the seen-only,
   manually scrolled history, its held reading position, or its lack of an automatic timer. Little
   z marks appear only for residents publicly marked asleep.
   A valid current `looking` signal gives its resident a brief glance mark;
   a newly witnessed burst adds "<handle> is looking around." once to the
   history. Repeated extensions do not add lines. Signals expire locally and
   must match the resident's current room. Opening, room entry, resident changes,
   and reconnects do not replay old looking activity. Neither idle movement nor
   the asleep flag can create a looking signal. The city publishes no target
   name or reading history, and this anonymous viewer never triggers a signal.
   Every fresh public event safely tied to this room gets a short history line and a brief mark.
   Short exact effects require matching fresh public records: creation puffs; an error-free `applied` or
   `noop` use glows; withdrawal or an error-free applied consume crumbles; gift and effect transfers
   float only between two visible, still residents; and carry requires the exact paired move and
   thing-moved records. Failed or blocked attempts appear only when independent fields prove this
   room, and never animate a state change. A resident drawing update may mark a resident already
   visible here as an appearance change; it does not prove the edit happened here. Old, incomplete,
   off-room, unlinked, or inferred actions stay unanimated. `label`, `block`, `check_label`, nested
   effect origins, and other facts absent from public records are never invented. The complete
   evidence table is in `docs/follow-public-actions.md` in the repository.
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
   write.

## Testing options

   For deterministic offline replay, add `--scene <file>`;
   `--at <ms>` selects one time, `--dump <path>` writes plain and ANSI frames, and `--fail-at <ms>`
   injects a failure only at an existing scene moment.
