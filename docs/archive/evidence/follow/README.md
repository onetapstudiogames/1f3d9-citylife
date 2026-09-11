# One-room follow evidence

> Status: historical (2026-09-07)

Release 1.7.0 replaces the exposed `live` command with `follow <handle>`.
The window follows the selected resident's current room, including moves to a
parent place or into a nested room. A fresh recorded move shows departure and
arrival. A changed location without its move record switches the room directly.
The website worktree was inspected only and was not changed or interrupted.

## Original scene

```sh
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 80x24 --dump docs/archive/evidence/follow/frames-80x24.txt
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 120x40 --color 256 --dump docs/archive/evidence/follow/frames-120x40.txt
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 80x24 --fail-at 30000 --dump docs/archive/evidence/follow/frames-error-80x24.txt
```

Each command writes 13 plain frames and paired ANSI frames. All four replay
commands match byte for byte on two runs in both formats;
[replay-proof.json](replay-proof.json) records the hashes. The original JSON
and its three moments remain unchanged. At 030000 the resident leaves room 2;
at 031000 the same window shows arrival in room 34; at 032000 the walk is over.
The new note appears at 060000 and expires at 066000. Opening and entering a
room never displays older notes. The failure replay freezes the picture until
the next successful read, with only the bottom error line added.

## Room activity

The small builder extends that same recording with five clearly labelled,
fictional moments. These actions never ran in the city. The original public
drawings and undrawn answers are reused; no image is fetched during replay.

```sh
node docs/archive/evidence/follow/make-action-scene.mjs follow-actions.json
node scripts/follow-feed.mjs thog --scene follow-actions.json --size 80x24 --dump docs/archive/evidence/follow/frames-actions-80x24.txt
```

The 35-frame dump shows creation at 070000, use at 072000, a gift at 074000,
removal at 076000, and an exact recorded carry at 078000. At 079000 the carried
thing remains attached through arrival; at 080000 it is back on the floor.
Removal does not claim whether an item was eaten, withdrawn, or destroyed.
Gift hearts require a gift record and two visible residents; other transfers
have no heart. A destination effect waits for the camera to arrive.

## Real Windows Terminal windows

- [80x24, departure at 030500](windows-terminal-80x24.png).
- [120x40, new note at 062000](windows-terminal-120x40.png).
- [80x24, fictional gift at 074500](windows-terminal-actions-80x24.png).

These are captures of actual Windows Terminal windows, not rendered mockups.
The adjacent `terminal-size-*.json` files record the actual TTY dimensions.
All three launches left the foreground window unchanged. Each proof window
was then closed by sending `q` only to its own console process.

[windows-terminal-keys.json](windows-terminal-keys.json) records real input:
refresh, opening/filtering/selecting in the resident picker, Esc cancelling the
picker before closing the window, and Ctrl+C closing even with the picker open.
Selecting `dry-run` produced one room for that resident. All sessions restored
raw input, closed their source once, and let Node exit. Input used the exact
Node process's console; no global keyboard input or focus change was used.

The cmd-started classic console implementation and its UTF-8/VT restoration
were already proved in [PR4](../pr4/README.md). This follow-only change has
automated classic-launcher checks; no new classic screenshot is claimed here.

## Public reads and portability

[public-follow.json](public-follow.json) records an actual anonymous read,
continuation, and resident selection against the city. It records public paths
and statuses, with no key, cookie, city write, or browser sign-in.

Claude Code and Codex use identical follow skill text and the same launcher.
On macOS, the launch command reconnects keyboard input to `/dev/tty`; an actual
POSIX shell test under a terminal confirmed Node saw a TTY after the command
passed through a pipe ([shell proof](macos-shell-proof.json)). Launcher tests
cover argument quoting and late failures. CI now runs the follow and terminal
checks on macOS and Windows, alongside the full Ubuntu suite.
No Mac was available, so a native macOS Terminal run remains unverified.

The terminal keeps the original five thing marks per room, with quiet overflow
dots, and fits resident portraits to available space. It gives the followed
resident priority. It cannot reproduce the website's mouse controls or rich
graphics. Drawings without public art keep the existing grey silhouette.
Positions, drift, and animation timing are decorative. The skill explains that;
the picture does not. There are no package dependencies or chat narration.

## Checks

`npm test`: **439 total, 430 passed, 9 platform skips, 0 failed**.
`npm run check:live-truth` and `npm run check:release-version` passed at 1.7.0.
The 145 focused follow/terminal tests passed, with scoped coverage of 96.72%
lines, 84.85% branches, and 96.59% functions. Four skill directories passed the
skill validator; Claude/Codex mirrors are byte-identical.

Independent reviews passed 48 source/controller checks and 24 motion checks,
and found no remaining blockers. The public proof made 52 anonymous GETs,
including changes, marker-covered presence and ancestry, and a resident switch.
The reader reconciles changing snapshots before committing its checkpoint.
Missing art for a removed event-only thing cannot permanently freeze refresh.

There is no typecheck/build script. `npm audit --offline` returned ENOLOCK
because this dependency-free plugin has no lockfile; audit is not claimed as
passed. Registration, rotation, recovery, credentials, and Playwright were not
changed. No new keyed city call was made.
