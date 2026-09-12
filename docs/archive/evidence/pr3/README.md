# PR3 drift, recorded walks, and note bubbles

> Status: historical (2026-09-07)

This evidence covers steps 9 through 11 of the
[terminal live-view plan](../../terminal-live-view-plan.md).
The original three-moment scene is unchanged.

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --dump docs/archive/evidence/pr3/frames-80x24.txt
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 120x40 --color 256 --dump docs/archive/evidence/pr3/frames-120x40.txt
```

Each dump contains 13 frames and has a paired `.txt.ansi` file with colour.
Frame 000000 seeds the record without replaying old events or notes.
Frames 002000 and 004000 show quiet decorative drift near each resident's home.
The new recorded move arrives at 030000; frames 030250 through 032000 show
thog leaving first town through a door and entering the fair.
Frame 060000 introduces the fair's new note, shortened to
`The fair grass remembers`. It remains through 065999 and is absent at 066000.

For a single frame, `--at` first replays earlier observations:

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --at 30500
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 120x40 --color 256 --at 62000
```

Public presence alone never starts a walk. Only a fresh applied move event
does. Both commands share the same motion and drawing code; `follow` keeps
the selected room set in stable order while including the resident's real room.
Positions inside rooms are decorative. Public reads run independently of
animation, and terminal writes are limited to eight updates per second.

Quiet read-error retention, refresh and town keys, the old Windows console,
and final skill wording remain for PR4.

## Verification

Both sizes and both formats were byte-identical on two runs.
[replay-proof.json](replay-proof.json) records hashes and byte counts.
Real Windows Terminal screenshots show
[80x24 truecolor at 030500](windows-terminal-80x24.png) and
[120x40 with 256 colours at 062000](windows-terminal-120x40.png).
The `terminal-size-*.json` files confirm the actual terminal dimensions.
Both windows were displayed and captured without taking keyboard focus.

An anonymous `node scripts/follow-feed.mjs thog --once --size 80x24` read
succeeded. [public-follow-once.txt](public-follow-once.txt) shows the workshop
as the current room, beside first town. No identity was loaded.

`npm test`: 375 total, 366 passed, 9 platform skips, 0 failed.
`npm run check:live-truth` and `npm run check:release-version`: passed (1.6.3).
The 49 focused layout, motion, renderer, and controller tests passed; scoped coverage
is 98.09% lines, 83.61% branches, and 96.79% functions.
The controller test checks actual terminal writes during a recorded walk,
not just timer callbacks, and proves unchanged frames emit no bytes.
No typecheck/build script is defined. The plugin still has zero dependencies;
`npm audit --offline` returned ENOLOCK because there is no lockfile.
