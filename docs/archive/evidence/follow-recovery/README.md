# Follow recovery evidence

> Status: historical (2026-09-07)

This evidence covers the 1.7.1 terminal repaint recovery. The source scene is
the unchanged public recording in `test/fixtures/live-scene.json`. Each run
wrote 13 plain frames and 13 matching ANSI frames.

## Reproduction

Run these commands from the repository root:

```sh
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 80x24 --color truecolor --dump docs/archive/evidence/follow-recovery/frames-80x24.txt
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 80x24 --color truecolor --dump docs/archive/evidence/follow-recovery/repeat/frames-80x24.txt
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 38x18 --color 256 --dump docs/archive/evidence/follow-recovery/frames-38x18.txt
node scripts/follow-feed.mjs thog --scene test/fixtures/live-scene.json --size 38x18 --color 256 --dump docs/archive/evidence/follow-recovery/repeat/frames-38x18.txt
```

Compare each top-level file with the generated file of the same name under
`repeat/`; the duplicate files do not need to be kept. [replay-proof.json](replay-proof.json)
records both equal SHA-256 hashes and byte counts for all four plain and ANSI
pairs. This proves deterministic replay at
both sizes; the controller tests separately prove that every successful poll,
`r`, Enter, and a supported terminal-focus report invalidate the retained
screen and write a full frame.

## Real reads and terminals

[public-follow.json](public-follow.json) records one anonymous, read-only
`follow --once` result from this PC. It returned exit code 0 and centered the
picture on `thog` in `the waystation`. No key, cookie, browser session, or city
write was used.

The native Windows Terminal captures show the fixed replay at 62000 ms:

- [80x24 truecolor](windows-terminal-80x24.png), with [TTY metadata](terminal-recovery-80x24.json)
- [38x18 256 color](windows-terminal-38x18.png), with [TTY metadata](terminal-recovery-38x18.json)

Both images were captured from their own Windows Terminal windows with Windows
`PrintWindow` and `PW_RENDERFULLCONTENT`; the foreground window did not change.
The screenshots prove native drawing at the recorded sizes. Automated tests,
rather than these still images, prove full refresh and key recovery.

The actual phone Termius/Tailscale disconnect was not reproduced. The view can
fully repaint after a working terminal stream returns, but it cannot reconnect
a dead SSH session. A native macOS Terminal run was not tested.
