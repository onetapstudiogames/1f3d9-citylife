import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import test from 'node:test'

import { openTerminalRunning } from '../scripts/lib/terminal.mjs'

// `openTerminalRunning` is exercised for real (a genuine, visible window, not
// a background process) on Windows as part of manual verification for this
// change — see the PR body. These tests cover what can run unattended in CI
// (ubuntu-latest): the honest failure-reporting contract on every platform,
// and, on POSIX, a real successful launch against a fake terminal emulator.

// On win32 there is no portable way to make every launcher fail: `cmd.exe`
// (this module's own fallback) is always resolvable via the Windows system
// directory regardless of PATH, so clearing PATH can't reproduce "nothing
// can launch a terminal" without a real, empty Windows install to test on.
// That combination (wt.exe AND cmd.exe both unavailable) also cannot happen
// on a real Windows machine, since cmd.exe ships with every install. These
// tests instead run on POSIX, where PATH genuinely controls what resolves;
// the Windows success paths (both wt.exe and the cmd/start/powershell
// fallback) were verified for real on a live Windows host as part of this
// change — see the PR body.
if (process.platform !== 'win32') {
  test('openTerminalRunning reports an honest failure — never a false "opened" claim — when nothing on PATH can launch a terminal', async () => {
    const originalPath = process.env.PATH
    const emptyDir = await mkdtemp(join(tmpdir(), 'citylife-empty-path-'))
    try {
      process.env.PATH = emptyDir
      const result = await openTerminalRunning('/nonexistent/script.mjs', ['arg'])
      assert.equal(result.opened, false)
      assert.equal(typeof result.reason, 'string')
      assert.ok(result.reason.length > 0, 'a failed launch always explains why')
      assert.equal(typeof result.commandLine, 'string')
      assert.ok(result.commandLine.length > 0, 'a failed launch still reports the command it tried')
      assert.equal(result.pid, undefined)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('openTerminalRunning reports the real command and PID for a launcher that hands off and exits 0', async () => {
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'citylife-fake-term-'))
    const fakeEmulator = join(fakeBinDir, 'x-terminal-emulator')
    // Mimics a real launcher (wt.exe, macOS `open -a`) that starts the real
    // window in the background and exits 0 immediately — success, not failure.
    await writeFile(fakeEmulator, '#!/bin/sh\nexit 0\n')
    await chmod(fakeEmulator, 0o755)
    const originalPath = process.env.PATH
    try {
      process.env.PATH = `${fakeBinDir}${delimiter}${originalPath}`
      const result = await openTerminalRunning('/tmp/some script.mjs', ['hello world'])
      assert.equal(result.opened, true)
      assert.equal(typeof result.pid, 'number')
      assert.match(result.commandLine, /x-terminal-emulator/u)
      assert.match(result.commandLine, /some script\.mjs/u)
    } finally {
      process.env.PATH = originalPath
      await rm(fakeBinDir, { recursive: true, force: true })
    }
  })

  test('openTerminalRunning reports a real PID for a launcher that stays running (a long-lived terminal window)', async () => {
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'citylife-fake-term-longlived-'))
    const fakeEmulator = join(fakeBinDir, 'x-terminal-emulator')
    await writeFile(fakeEmulator, '#!/bin/sh\nsleep 5\n')
    await chmod(fakeEmulator, 0o755)
    const originalPath = process.env.PATH
    try {
      process.env.PATH = `${fakeBinDir}${delimiter}${originalPath}`
      const result = await openTerminalRunning('/tmp/script.mjs', [])
      assert.equal(result.opened, true)
      assert.equal(typeof result.pid, 'number')
      // Clean up the still-running fake window process this test launched.
      try {
        process.kill(result.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    } finally {
      process.env.PATH = originalPath
      await rm(fakeBinDir, { recursive: true, force: true })
    }
  })
}
