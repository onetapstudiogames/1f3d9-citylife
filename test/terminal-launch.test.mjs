import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import test from 'node:test'

import { openTerminalRunning } from '../scripts/lib/terminal.mjs'
import { canOpenFollowWindow } from '../scripts/lib/live-view.mjs'

const fakeChild = (pid, code) => {
  const child = new EventEmitter()
  child.pid = pid
  child.unref = () => {}
  queueMicrotask(() => child.emit('exit', code, null))
  return child
}

test('follow opens a window only from an interactive terminal', () => {
  assert.equal(canOpenFollowWindow({ inputIsTTY: true, outputIsTTY: true }), true)
  assert.equal(canOpenFollowWindow({ inputIsTTY: false, outputIsTTY: true }), false)
  assert.equal(canOpenFollowWindow({ inputIsTTY: true, outputIsTTY: false }), false)
})

test('Windows fallback transports public argv without embedding it in PowerShell source', async () => {
  const calls = []
  const malicious = '$([IO.File]::WriteAllText("owned", "yes")); `Get-Process`; line\r\nnext'
  const result = await openTerminalRunning('C:\\city view\\follow-feed.mjs', [malicious], {
    title: 'unsafe & calc.exe',
    platform: 'win32',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    env: { SystemRoot: 'C:\\Windows' },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakeChild(100 + calls.length, calls.length === 1 ? 1 : 0)
    },
  })

  assert.equal(result.opened, true)
  assert.equal(calls.length, 2)
  assert.match(calls[0].command, /wt\.exe$/iu)
  assert.match(calls[1].command, /cmd\.exe$/iu)
  assert.deepEqual(calls[1].args.slice(0, 4), ['/d', '/s', '/c', 'start'])
  assert.equal(calls[0].args[calls[0].args.indexOf('--title') + 1], '1F3D9 follow')
  assert.equal(calls[1].args[4], '1F3D9 follow')
  assert.equal(calls[1].args.includes('unsafe & calc.exe'), false)
  assert.equal(calls[1].args.includes('-NoExit'), true)
  const payload = JSON.parse(Buffer.from(calls[1].options.env.ONEF3D9_LEGACY_CONSOLE_PAYLOAD, 'base64').toString('utf8'))
  assert.deepEqual(payload.argv, ['C:\\city view\\follow-feed.mjs', malicious])
  const source = Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le')
  assert.equal(source.includes(malicious), false)
  assert.equal(calls[1].args.join(' ').includes(malicious), false)
})

test('macOS launcher activates visible Terminal and keeps public argv out of AppleScript source', async () => {
  const calls = []
  const malicious = '\"; do shell script \"touch owned\"; $() `cmd` \' line\r\nnext'
  const result = await openTerminalRunning('/city view/follow-feed.mjs', [malicious], {
    platform: 'darwin',
    executable: '/opt/node bin/node',
    env: {},
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakeChild(201, 0)
    },
  })

  assert.equal(result.opened, true)
  assert.equal(calls.length, 1)
  const appleScript = calls[0].args.at(-1)
  assert.match(appleScript, /tell application "Terminal"[\s\S]*activate[\s\S]*do script/u)
  assert.equal(appleScript.includes(malicious), false)
  const encoded = /echo ([A-Za-z0-9+/=]+) \|/u.exec(appleScript)?.[1]
  assert.ok(encoded)
  const command = Buffer.from(encoded, 'base64').toString('utf8')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  assert.equal(command, `exec ${['/opt/node bin/node', '/city view/follow-feed.mjs', malicious].map(quote).join(' ')} < /dev/tty`)
  assert.equal(command.includes("'\\''"), true, 'apostrophes use the standard POSIX literal escape')
})

test('macOS launcher waits for osascript failure instead of guessing success', async () => {
  const child = new EventEmitter()
  child.pid = 202
  child.unref = () => {}
  let observed
  const launched = openTerminalRunning('/city/follow-feed.mjs', ['thog'], {
    platform: 'darwin',
    spawnImpl: () => child,
  })
  launched.then(result => { observed = result })

  await new Promise(resolve => setImmediate(resolve))
  const resultBeforeExit = observed
  child.emit('exit', 1, null)
  const result = await launched

  assert.equal(resultBeforeExit, undefined)
  assert.equal(result.opened, false)
  assert.match(result.reason, /exited with code 1/u)
})

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
      const result = await openTerminalRunning('/nonexistent/script.mjs', ['arg'], { platform: 'linux' })
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
      const result = await openTerminalRunning('/tmp/some script.mjs', ['hello world'], { platform: 'linux' })
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
      const result = await openTerminalRunning('/tmp/script.mjs', [], { platform: 'linux' })
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
