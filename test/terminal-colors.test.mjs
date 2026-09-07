import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseColorMode, createColorEncoder } from '../scripts/lib/terminal-colors.mjs'

test('terminal colors: truecolor hints win on supported terminals', () => {
  assert.equal(chooseColorMode({ env: { COLORTERM: '24bit' }, platform: 'linux', isTTY: true }), 'truecolor')
  assert.equal(chooseColorMode({ env: { WT_SESSION: 'abc' }, platform: 'win32', isTTY: true }), 'truecolor')
  assert.equal(chooseColorMode({ env: { TERM_PROGRAM: 'iTerm.app' }, platform: 'darwin', isTTY: true }), 'truecolor')
})

test('terminal colors: a tty falls back through xterm 256 to basic 16', () => {
  assert.equal(chooseColorMode({ env: {}, platform: 'win32', isTTY: true }), '256')
  assert.equal(chooseColorMode({
    env: { ONEF3D9_LEGACY_CONSOLE_MODE: 'ansi', TERM: 'dumb' },
    platform: 'win32',
    isTTY: true,
  }), '256')
  assert.equal(chooseColorMode({
    env: { ONEF3D9_LEGACY_CONSOLE_MODE: 'ansi', TERM: 'dumb', COLORTERM: 'truecolor' },
    platform: 'win32',
    isTTY: true,
  }), 'truecolor')
  assert.equal(chooseColorMode({ env: { WT_SESSION: 'abc', TERM: 'dumb' }, platform: 'win32', isTTY: true }), 'truecolor')
  assert.equal(chooseColorMode({ env: { COLORTERM: 'truecolor', TERM: 'dumb' }, platform: 'linux', isTTY: true }), '16')
  assert.equal(chooseColorMode({ env: { TERM: 'xterm-256color' }, platform: 'linux', isTTY: true }), '256')
  assert.equal(chooseColorMode({ env: { TERM: 'dumb' }, platform: 'linux', isTTY: true }), '16')
  assert.equal(chooseColorMode({ env: {}, platform: 'linux', isTTY: false }), '16')
})

test('terminal colors: encoders emit foreground and background escapes for each mode', () => {
  const truecolor = createColorEncoder('truecolor')
  assert.equal(truecolor.foreground('#aA00fF'), '\x1b[38;2;170;0;255m')
  assert.equal(truecolor.background('#aa00ff'), '\x1b[48;2;170;0;255m')

  const xterm = createColorEncoder('256')
  assert.equal(xterm.foreground('#ff0000'), '\x1b[38;5;9m')
  assert.equal(xterm.background('#ff0000'), '\x1b[48;5;9m')
  assert.equal(xterm.foreground('#800000'), '\x1b[38;5;1m')

  const basic = createColorEncoder('16')
  assert.equal(basic.foreground('#ff0000'), '\x1b[91m')
  assert.equal(basic.background('#ff0000'), '\x1b[101m')
  assert.equal(basic.reset, '\x1b[0m')
})

test('terminal colors: invalid colors and modes fail at their boundary', () => {
  assert.throws(() => createColorEncoder('bogus'), /color mode/u)
  assert.throws(() => createColorEncoder('256').foreground('red'), /hex color/u)
})
