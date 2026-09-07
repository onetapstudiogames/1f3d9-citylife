# PR1 terminal live-view evidence

This evidence covers steps 1 through 5 of the
[terminal live-view plan](../../terminal-live-view-plan.md):

1. Record one public city read as a local scene fixture, with every drawing the
   picture needs.
2. Replay that scene without contacting the city.
3. Paint exact-size frames through the alternate-screen controller, restore the
   terminal on exit, update only changed cells, and recalculate on resize.
4. Encode colours as truecolor, nearest xterm-256, or nearest basic ANSI 16.
5. Reduce the picture to the selected place name, room names, rounded boxes,
   and full 8x4 resident portraits or grey stand-ins. The bottom line is blank.

## Replay provenance

The first fixture moment is one real public baseline read. The next two moments
are clearly labelled hand-authored extensions of that baseline: one moves a
resident between recorded rooms, and one adds a new note. They make later motion
and bubble work repeatable; they are not presented as live city observations.

Replay snapshots relocate a resident immediately when the selected moment
changes. Animated walking arrives in PR3.

## Commands

The 80x24 evidence uses the replay's default truecolor output:

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --dump docs/evidence/pr1/frames-80x24.txt
```

The 120x40 evidence forces the xterm-256 fallback:

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 120x40 --color 256 --dump docs/evidence/pr1/frames-120x40.txt
```

Each `.txt` file contains plain replay frames. Its paired `.txt.ansi` file
contains the same frames with terminal colour escapes. The rendered Windows
Terminal captures are
[`windows-terminal-80x24.png`](windows-terminal-80x24.png) and
[`windows-terminal-120x40.png`](windows-terminal-120x40.png).

## Current boundary

This PR does not yet paint room floors or things, drift residents, animate
walks, show note bubbles, retain the last good frame with a quiet read error,
add the new key controls, or negotiate the old Windows console. Those parts are
scheduled for later PRs. `follow` now uses the same picture as `live` and starts
with the resident's actual room.

## Verification

Two independent runs produced 13 frames per size. Plain text and ANSI bytes
matched in both sizes; [replay-proof.json](replay-proof.json) records SHA-256
hashes and file sizes. Frame 000000 shows the baseline. Frame 030000 shows
`thog` relocated to the fair. Frame 060000 still has no bubble, as intended
until PR3. The terminal screenshots use `--at 0` at 80x24 and `--at 30000`
at 120x40, with Windows Terminal setting the actual cell dimensions.

An anonymous `node scripts/live-feed.mjs 'first town' --once --size 80x24`
read produced [public-live-once.txt](public-live-once.txt). This read and the
fixture recording used no identity, key, browser, or environment credential.

The owner resized the small proof window. The captured restored terminal is
[windows-terminal-restored.png](windows-terminal-restored.png). This exposed
a dormant-input cleanup issue, which was fixed: a fresh Windows Terminal run
then exercised the same q handler and exited with Node code 0, recorded in
[windows-terminal-exit.json](windows-terminal-exit.json). The proof driver
emitted q locally after one second; it did not send global keyboard input.
The Codex PTY wrapper separately reported status 1 despite the controller
returning success, so the actual Windows Terminal process exit is the exit
proof used here.

`npm test`: 344 total, 335 passed, 9 platform skips, 0 failed.
`npm run check:live-truth` and `npm run check:release-version`: passed (1.6.1).
The 42 focused view tests cover 92.99% of lines, 80.54% of branches, and
96.43% of functions in the six view modules. No typecheck or build script is
defined. The plugin still has zero dependencies; npm audit cannot run without
a lockfile and is not claimed as passed.
