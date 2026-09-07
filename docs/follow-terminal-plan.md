# Follow terminal plan

This is the current follow-only scope for release 1.7.0. It supersedes the exposed
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
  to follow, or Esc to cancel. Outside the picker, `r` refreshes and `q` or Esc
  closes; Ctrl+C always closes.
- Public reads are anonymous and make no city or identity write. A quiet room,
  including one inside a quiet place, conceals its contents. A failed refresh
  freezes the last picture and shows one muted bottom-line error until a read
  succeeds.

## Picture truth

- Room membership and public records come from the city. Positions within the
  room, drift, and timing between refreshes exist only for the picture.
- At most five 4x2 thing marks appear. Up to 12 dots, further limited by room
  width, show additional things. The followed resident gets first resident
  placement; a crowded room may omit other resident marks.
- A two-second door walk requires a fresh recorded move with `applied` status.
  A room change seen only in refreshed state snaps without an invented walk.
- Old records seed cursors without effects. Fresh notes may bubble for six seconds
  at 24 graphemes; older notes never appear.
- Creation, use, removal, gift, transfer, and carry cues require the matching
  typed public records. Failed, incomplete, off-room, or inferred actions do not
  animate. Carry requires the exact paired move and thing-moved records.

## Release proof checklist

- [x] Automated tests prove one-room following, automatic room changes, no old
  notes, picker filtering/selection, quiet-room privacy, and truthful effects.
- [x] Package tests prove the `live` scripts and skills are absent and Claude Code
  and Codex carry byte-identical follow instructions at version 1.7.0.
- [x] A native Windows Terminal run proves launch, picker keys, refresh, close,
  and cleanup. Replay and automated tests prove error retention and fallback;
  the earlier PR4 evidence covers native cmd-started UTF-8/VT restoration.
- [ ] A native macOS run proves the same launcher and controls. No Mac was
  available during implementation, so this remains unverified.
- [x] Offline replay proves deterministic output without network access; the
  recorded fixture and historical evidence stay unchanged.
