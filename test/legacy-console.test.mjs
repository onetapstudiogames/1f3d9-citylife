import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  LEGACY_CONSOLE_MESSAGE,
  LEGACY_CONSOLE_MODE,
  buildLegacyConsoleLaunch,
  prepareLegacyConsole,
} from '../scripts/lib/legacy-console.mjs'

const exitingSpawn = (calls, code = 0) => (command, args, options) => {
  calls.push({ command, args, options })
  const child = new EventEmitter()
  child.pid = 321
  queueMicrotask(() => child.emit('exit', code, null))
  return child
}

test('legacy console: public argv stays data and the bootstrap restores console state', () => {
  const argv = [
    'C:\\city view\\scripts\\live-feed.mjs',
    '$([IO.File]::WriteAllText("owned", "yes"))',
    '`Get-Process`',
    'quote" and apostrophe\'',
    'line one\r\nline two',
    '',
  ]
  const launch = buildLegacyConsoleLaunch({
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    argv,
    keepOpen: false,
    env: { SystemRoot: 'C:\\Windows', SAFE_PARENT: 'kept' },
  })

  const payload = JSON.parse(Buffer.from(launch.options.env.ONEF3D9_LEGACY_CONSOLE_PAYLOAD, 'base64').toString('utf8'))
  const source = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le')
  assert.deepEqual(payload, { executable: 'C:\\Program Files\\nodejs\\node.exe', argv, keepOpen: false })
  assert.equal(launch.options.env.SAFE_PARENT, 'kept')
  for (const value of argv) if (value) assert.equal(source.includes(value), false, value)
  assert.ok(source.indexOf('SetConsoleCP(65001)') < source.indexOf('& $executable @childArgs'))
  assert.ok(source.indexOf('SetConsoleOutputCP(65001)') < source.indexOf('& $executable @childArgs'))
  assert.match(source, /ENABLE_PROCESSED_OUTPUT = 0x0001/u)
  assert.match(source, /ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004/u)
  assert.match(source, /finally \{/u)
  assert.match(source, /SetConsoleMode\(\$consoleHandle, \$originalMode\)/u)
  assert.match(source, /SetConsoleCP\(\$originalInputCodePage\)/u)
  assert.match(source, /SetConsoleOutputCP\(\$originalOutputCodePage\)/u)
  assert.deepEqual(launch.options.stdio, 'inherit')
  assert.equal(launch.options.detached, false)
  assert.equal(launch.options.windowsHide, false)
})

test('legacy console: only an interactive classic Windows console relaunches', async () => {
  const bypasses = [
    { platform: 'linux', isTTY: true, env: {} },
    { platform: 'win32', isTTY: false, env: {} },
    { platform: 'win32', isTTY: true, env: { WT_SESSION: 'terminal' } },
  ]
  for (const options of bypasses) {
    assert.deepEqual(await prepareLegacyConsole(options), {
      mode: 'ansi', legacy: false, relaunched: false,
    })
  }

  assert.deepEqual(await prepareLegacyConsole({
    platform: 'win32', isTTY: true, env: { [LEGACY_CONSOLE_MODE]: 'ansi' },
  }), { mode: 'ansi', legacy: true, relaunched: false, synchronized: false })
  assert.deepEqual(await prepareLegacyConsole({
    platform: 'win32', isTTY: true, env: { [LEGACY_CONSOLE_MODE]: 'plain' },
  }), { mode: 'plain', legacy: true, relaunched: false, synchronized: false, message: LEGACY_CONSOLE_MESSAGE })

  const calls = []
  const relaunched = await prepareLegacyConsole({
    platform: 'win32',
    isTTY: true,
    env: { SystemRoot: 'C:\\Windows' },
    executable: 'node.exe',
    argv: ['live-feed.mjs', '--scene', 'scene.json'],
    spawnImpl: exitingSpawn(calls),
  })
  assert.deepEqual(relaunched, {
    mode: 'relaunched', legacy: true, relaunched: true, synchronized: false, exitCode: 0,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.env[LEGACY_CONSOLE_MODE], undefined)
})

test('legacy console: a bootstrap spawn failure selects the escape-free plain path', async () => {
  const result = await prepareLegacyConsole({
    platform: 'win32',
    isTTY: true,
    env: { SystemRoot: 'C:\\Windows' },
    argv: ['live-feed.mjs'],
    spawnImpl: () => { throw new Error('PowerShell unavailable') },
  })
  assert.deepEqual(result, {
    mode: 'plain', legacy: true, relaunched: false, synchronized: false, message: LEGACY_CONSOLE_MESSAGE,
  })
})
