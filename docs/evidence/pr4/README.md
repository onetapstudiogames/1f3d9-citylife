# PR4 quiet errors, controls, and classic Windows Console

This completes steps 12 through 15 of the
[terminal live-view plan](../../terminal-live-view-plan.md).
The original three-moment scene remains unchanged.

## Replay commands

```sh
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --dump docs/evidence/pr4/frames-80x24.txt
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 120x40 --color 256 --dump docs/evidence/pr4/frames-120x40.txt
node scripts/live-feed.mjs --scene test/fixtures/live-scene.json --size 80x24 --fail-at 30000 --dump docs/evidence/pr4/frames-error-80x24.txt
```

Each command writes 13 plain frames and a paired `.txt.ansi` file.
Both sizes and the failure replay match byte for byte on two runs;
[replay-proof.json](replay-proof.json) and
[error-replay-proof.json](error-replay-proof.json) record their hashes.

The failure replay freezes the picture at 030000 and adds only
`Could not read the city.` on its bottom line. Frames 030250 through 032000
retain that exact picture. At 060000 the read succeeds and the line clears.
The regular replay retains the recorded walk and six-second note bubble.
The reviewed 120x40 note frame at 062000 is also a committed text snapshot
under `test/fixtures/live-frame-120x40.txt`.

## Real terminal evidence

The screenshots are actual terminal windows:

- [Windows Terminal, 120x40, note at 062000](windows-terminal-120x40.png).
- [Windows Terminal, 80x24, failed read at 030000](windows-terminal-error-80x24.png).
- [cmd-started classic Console Host, 80x24, note at 062000](classic-console-80x24.png).

The Windows Terminal captures used the `--at` values above, with 256 colours
for 120x40 and truecolor for the failure picture. Their `terminal-size-*.json`
files record the actual dimensions. Capture does not require keyboard focus;
the windows must be visible and uncovered.

[windows-terminal-keys.json](windows-terminal-keys.json) records three real
Windows Terminal sessions against the offline scene. `r` repeated the read;
Left/Right reached navigation and refused the unrecorded town. `q`, Esc, and
Ctrl+C each closed their session, restored raw input, and let Node exit.
Inputs went only to each view's exact process with `WriteConsoleInputW`.
The foreground window stayed unchanged.

The classic window was started through `conhost.exe cmd.exe`, then Windows
PowerShell and the same scene entry point. This explicit Console Host launch
uses the Windows mechanism described in Microsoft's
[default-terminal specification](https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md).
The [startup record](classic-console-startup.json) confirms ANSI, 256 colours,
and no synchronized output.
After resizing the actual window to 80x24,
[classic-console-mode.json](classic-console-mode.json) read both code pages as
65001 and confirmed virtual-terminal processing directly from Windows.

[classic-console-q.json](classic-console-q.json) records a real `q` input
written only to that console with `WriteConsoleInputW`. The Node view exited;
the wrapper restored its saved console settings, including input code page 437.
No global keyboard event or browser step was used.

## Behavior and limits

`r` refreshes; `q`, Esc, and Ctrl+C close. In `live`, Left/Right cycle through
towns in the same continent in numeric ID order with wraparound. `follow`
stays centered on the resident. Pending old reads cannot overwrite a newer
town selection. Offline arrows refuse towns missing from the recording.

A real anonymous navigation read moved the view from first town to test town;
[public-navigation.json](public-navigation.json) records the returned place IDs.
This changed only the viewed town, with no city write or identity access.

If classic-console negotiation fails, the command prints one quiet explanation
and one plain frame without entering the alternate screen. Automated tests cover
that refusal; the real console here supported ANSI, so a hardware refusal was
not observed. The skill pages document keys, replay, real room membership, and
decorative positions inside rooms. Those explanations stay off the picture.

## Checks

`npm test`: 394 total, 385 passed, 9 platform skips, 0 failed.
`npm run check:live-truth` and `npm run check:release-version` passed at 1.6.4.
All 100 focused view and terminal tests passed, with scoped coverage of 95.63%
lines, 85.47% branches, and 96.49% functions. Six skill directories passed
the skill validator. No typecheck/build script is defined. The plugin still has
zero dependencies; `npm audit --offline` returned ENOLOCK because there is no
lockfile, so audit is not claimed as passed.

An independent final review found no correctness or security blockers and
passed 55 source, controller, controls, launcher, console, and colour tests.
The live/follow import chain has no identity or vault access; its city requests
are anonymous GETs. Registration, rotation, recovery, and Playwright were not
changed in this PR.
