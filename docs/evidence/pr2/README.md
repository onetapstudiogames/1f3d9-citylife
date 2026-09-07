# PR2 room floor and occupancy evidence

This evidence covers steps 6 through 8 of the
[terminal live-view plan](../../terminal-live-view-plan.md):

1. Tile each room's own 8x8 drawing, blending painted pixels halfway toward
   the room base. Choose the wall tint separately from its dominant colours.
2. Keep full 8x4 resident portraits transparent over the floor. Show undrawn
   residents in grey.
3. Show up to five things as 4x2 marks. A drawn thing uses its majority colour,
   with its top-left cell breaking ties; an undrawn thing uses grey. Show at
   most 12 remaining things as single-cell dots.
4. Place residents and things deterministically in shared room space with a
   one-cell margin.

## Commands

The 80x24 evidence uses the replay's default truecolor output:

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --dump docs/evidence/pr2/frames-80x24.txt
```

The 120x40 evidence forces the xterm-256 fallback:

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 120x40 --color 256 --dump docs/evidence/pr2/frames-120x40.txt
```

Each `.txt` file contains plain replay frames. Its paired `.txt.ansi` file
contains the same frames with terminal colour escapes.

## Expected first frames

The 80x24 first frame shows the grass floor in `first town` and the undrawn
fair. The 120x40 first frame shows a drawn resident and a drawn thing in
Gable's Workroom.

## Current boundary

This PR does not add resident drift, animated walks, note bubbles, quiet error
retention, new key controls, or legacy Windows console support. Those parts
remain scheduled for PR3 and PR4.

## Verification

Both commands produced 13 frames. Plain and ANSI files were byte-identical on
two runs; [replay-proof.json](replay-proof.json) records hashes and byte counts.
The original scene fixture is unchanged from PR1.

Real Windows Terminal captures show frame 000000 in
[80x24 truecolor](windows-terminal-80x24.png) and
[120x40 with 256 colours](windows-terminal-120x40.png). The paired
`terminal-size-*.json` files record the actual terminal dimensions. Both proof
windows were displayed and captured without taking keyboard focus.

An anonymous `node scripts/follow-feed.mjs thog --once --size 80x24` read
succeeded and produced [public-follow-once.txt](public-follow-once.txt). The
resident's real room was the workshop at this read. No identity was loaded.

`npm test`: 355 total, 346 passed, 9 platform skips, 0 failed.
`npm run check:live-truth` and `npm run check:release-version`: passed (1.6.2).
Scoped coverage across grid, drawing, layout, and render: 99.80% lines,
85.96% branches, 100% functions. Independent review's 56 targeted tests passed,
including geometry probes for bounds, margins, clear paths, and drawing budgets.
No typecheck/build script is defined. The plugin still has zero dependencies;
npm audit requires an absent lockfile and is not claimed as passed.
