# Follow: readable text, names and sleep

This is evidence for 1.8.0, stacked on the 1.7.1 recovery change. The original
recording and its drawings remain unchanged. The generator labels its later
moments as fictional review extensions; none of these messages or actions were
written to the city.

## Replay

```sh
node docs/evidence/follow-polish/make-scene.mjs docs/evidence/follow-polish/follow-polish-scene.json
node scripts/follow-feed.mjs thog --scene docs/evidence/follow-polish/follow-polish-scene.json --size 80x24 --color truecolor --dump docs/evidence/follow-polish/frames-80x24.txt
node scripts/follow-feed.mjs thog --scene docs/evidence/follow-polish/follow-polish-scene.json --size 38x18 --color 256 --dump docs/evidence/follow-polish/frames-38x18.txt
```

Each dump command produced 56 frames and its matching `.ansi` file. Each command
was run twice and both files compared byte for byte. [replay-proof.json](replay-proof.json)
records both hashes and byte counts. The fake clock reads no wall time or city.
To watch the recording in a terminal, omit `--dump`. Add `--at 87000` or
`--at 120000` to hold either screenshot's moment.

Read the frames at 70000 and 72000 for creation and use; 78000 and 79000 for the
two carry legs; 87000 for the long note's beginning, short bubble, names and z
marks; and 120000 for `THE LANTERN IS HOME.` after automatic scrolling. Full-text
tests check that every word can be read at both widths. Other tests cover paused
reading when no log rows fit, reflow after resize, quiet rooms, delayed note
events, old notes, and identical direct/paced clocks across queued room moves.

## Native Windows Terminal

These are actual Windows Terminal windows, captured using Windows
`PrintWindow` with `PW_RENDERFULLCONTENT`. Capture did not change foreground
focus. [Desktop metadata](terminal-polish-desktop-final.json) and
[phone-width metadata](terminal-polish-phone-final.json) confirm their real
80x24 and 38x18 TTY dimensions and Windows Terminal sessions.

![80x24 at 87000 ms](windows-terminal-80x24.png)

![38x18 at 120000 ms](windows-terminal-38x18.png)

The first town's recorded drawing is tiled and dimmed. Most residents and
things in this recording were undrawn in the public response, so their simple
placeholders are expected. Drawing tests separately prove resident transparency
and reduction of thing drawings. Names may shorten or disappear in crowds; the
phone layout leaves a row under the followed resident and keeps drift from
using that label row. z marks use the public asleep flag only.

The still images prove native drawing, not a real SSH reconnection. The recovery
tests and [separate evidence](../follow-recovery/README.md) cover repainting
after restored output. Actual Tailscale/Termius disconnection and a native macOS
window remain untested. No dependency or identity behavior changed.

## Checks

- `npm test`: 473 total, 464 passed, 9 platform skips, 0 failed.
- `npm run check:live-truth`: passed against llms.txt, /api/official and anonymous
  /api/me. A separate anonymous `follow --once` run reached the current room and
  displayed names and sleep marks; [public-follow.json](public-follow.json).
- `npm run check:release-version`: passed at 1.8.0. No typecheck or build script
  exists in package.json.
- Scoped viewer coverage: 99.74% lines, 87.95% branches, 98.33% functions.
  Independent review findings were fixed and their regression tests pass.

`npm audit --offline` returned `ENOLOCK`: this dependency-free plugin has no
lockfile. This is recorded as unavailable, not a passing audit.

Coverage command:

```sh
node --experimental-test-coverage --test-coverage-include='scripts/lib/follow-*.mjs' --test-coverage-include='scripts/lib/bubble-text.mjs' --test-coverage-include='scripts/lib/live-render.mjs' --test-coverage-include='scripts/lib/live-layout.mjs' --test-coverage-include='scripts/lib/live-motion.mjs' --test --test-reporter=spec test/follow-*.test.mjs test/bubble-text.test.mjs test/live-*.test.mjs
```
