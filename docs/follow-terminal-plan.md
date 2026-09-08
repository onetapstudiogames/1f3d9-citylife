# Follow terminal plan

This is the current follow-only scope for release 1.8.1. It supersedes the exposed
`live [place]` command described by the earlier terminal plan. The earlier plan and
all PR evidence remain historical records; they are not current instructions.

## User contract

- `follow <handle>` opens one self-updating terminal window in Claude Code and
  Codex on Windows and macOS. The host returns after launch and does not narrate
  the room in chat. If no window can open, it prints one plain frame inline.
- The picture automatically follows the resident's public current room and shows
  only that room, its current residents and things, and activity first observed
  after this view opened. It never displays older notes.
- Press `f` for the in-window picker, type to filter, use Up/Down to choose, Enter
  to follow, or Esc to cancel. Outside the picker, Up/Down scrolls the history
  one line, PageUp/PageDown one page, Home to the oldest entry, and End to the
  newest. `r` or Enter refreshes and `q` or Esc closes; Ctrl+C always closes.
  Supported terminal-focus reports also refresh. Each successful 30-second public refresh fully repaints, allowing a
  restored terminal stream to catch up. A dead SSH connection must be reconnected
  in the terminal client.
- Public reads are anonymous and make no city or identity write. A quiet room,
  including one inside a quiet place, conceals its contents. A failed refresh
  freezes the last picture and shows one muted bottom-line error until a read
  succeeds. Selecting another resident immediately clears the old picture and
  history, including if the replacement read fails. The picker retains the last
  known public resident list so another resident can still be selected.

## Picture truth

- Room membership and public records come from the city. Positions within the
  room, drift, and timing between refreshes exist only for the picture.
- At most five 4x2 thing marks appear. Up to 12 dots, further limited by room
  width, show additional things. The followed resident gets first resident
  placement; a crowded room may omit other resident marks.
- A two-second door walk requires a fresh recorded move with `applied` status.
  A room change seen only in refreshed state snaps without an invented walk.
- Old records seed cursors without effects. Fresh notes may bubble for six seconds
  with up to three text rows and 52 terminal cells including the border. Bubbles are
  previews; the full note stays in the bottom history. Older notes never appear.
- Every fresh public event safely tied to this room gets a short history line
  and a brief visual mark. Creation, use, removal, gift, transfer, carry,
  movement, and note cues retain their exact typed-record requirements. Carry
  requires the paired move and thing-moved records. A failed or blocked attempt
  appears only when independent fields prove its room, and receives no
  state-change animation. See [the complete public action inventory](follow-public-actions.md).

## Readable details

The owner's follow-up adds small names and a recent activity history to the original
picture-only scope. The place and room names remain; there are no counts,
legends, lists of occupants, or permanent instructions. The final line stays
blank except for a read error.

- The history uses three rows at 24 lines tall, two at 20, one at 14, and none
  below 14. A blank row separates it from the room. Long entries keep their full
  text and wrap to the terminal width; continuation lines repeat a small speaker
  prefix where width allows. It keeps the most recent 200 seen entries in memory only, including
  across room moves. The entries remain available while the panel is hidden.
- The history contains only newly observed notes and room-proven public events
  that this open view actually witnessed. It never fills in old arrival notes or
  activity from another room. A resident selection change or a quiet room clears
  it under the current privacy contract; an ordinary room move does not. An
  arrival note needs its matching fresh public note event.
  Failed, blocked, incomplete, unlinked, and global records produce no invented
  room or state change. A visible resident drawing update is described only as
  an appearance change; there is no invented reading or editing animation.
- Outside the picker, Up/Down moves one wrapped line, PageUp/PageDown one visible
  page, Home shows the oldest entry, and End returns to the newest. New entries
  follow the bottom only when it was already visible. While the reader is higher
  in the history, new entries keep the same text anchored in view. There are no
  timers or automatic scrolling.
- Names that fit their allocated strips stay still. Longer place names at the
  top, room names in borders, resident and thing labels, and resident names in
  the picker scroll horizontally from beginning to end without a permanent
  ellipsis. Each pauses 1.6 seconds at the beginning and end, advances one
  terminal cell every 400 milliseconds, and repeats. Wide Unicode characters
  are never split.
- Resident and thing names use muted colour in strips of at most 18 terminal
  cells below their pictures. When an 18-cell strip would overlap another
  picture, the label tries a narrower strip and is omitted only if no strip fits.
  Name motion does not change the history: it remains seen-only and moves only
  through the manual keys above, keeps the reader's held position, and has no
  automatic timer. Sleeping residents have z, zz, and zzZ above them, changing
  every 1.5 seconds; only the public `asleep` flag permits these marks, and walks
  suppress them. No inactivity-based sleep is invented.
- Places still use their own tiled 8x8 drawings, dimmed for the floor and sampled
  for wall colours. Residents still use their own transparent 8x4 half-block
  pictures; things still use their own reduced 4x2 pictures.

## Release proof checklist

- [x] Automated tests prove one-room following, automatic room changes, no old
  notes, picker filtering/selection, quiet-room privacy, and truthful effects.
- [x] Package tests prove the `live` scripts and skills are absent and Claude Code
  and Codex carry byte-identical follow instructions at version 1.8.1.
- [x] A native Windows Terminal run proves launch, picker keys, refresh, close,
  and cleanup. Replay and automated tests prove error retention and fallback;
  the earlier PR4 evidence covers native cmd-started UTF-8/VT restoration.
- [ ] A native macOS run proves the same launcher and controls. No Mac was
  available during implementation, so this remains unverified.
- [x] Offline replay proves deterministic output without network access; the
  recorded fixture and historical evidence stay unchanged.
