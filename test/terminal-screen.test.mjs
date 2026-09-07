import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalScreen } from '../scripts/lib/terminal-screen.mjs'

const frame = (lines) => ({
  width: lines[0].length, height: lines.length,
  cells: lines.map(line => [...line].map(ch => [ch, '#ffffff', '#000000'])),
})
const capture = (options = {}) => {
  const writes = []
  return { writes, screen: new TerminalScreen({ output: { write: text => writes.push(text) }, ...options }) }
}

test('screen enters once, writes changed runs only, and leaves unchanged frames silent', () => {
  const { screen, writes } = capture({ synchronized: true })
  screen.enter()
  screen.enter()
  screen.present(frame(['abc', 'def']))
  assert.equal(writes.filter(text => text.includes('\x1b[?1049h')).length, 1)
  assert.match(writes.at(-1), /^\x1b\[\?2026h/u)
  assert.match(writes.at(-1), /\x1b\[\?2026l$/u)
  const count = writes.length
  screen.present(frame(['abc', 'def']))
  assert.equal(writes.length, count)
  screen.present(frame(['aXc', 'def']))
  assert.match(writes.at(-1), /\x1b\[1;2H/u)
  assert.match(writes.at(-1), /X/u)
  assert.doesNotMatch(writes.at(-1), /abc|def|\x1b\[2J/u)
})

test('resize repaints the new cell bounds and restore is idempotent', () => {
  const { screen, writes } = capture({ synchronized: false })
  screen.enter()
  screen.present(frame(['abc']))
  screen.present(frame(['xy', 'zz']))
  assert.match(writes.at(-1), /\x1b\[2;1H/u)
  assert.doesNotMatch(writes.join(''), /2026|\x1b\[2J/u)
  screen.restore()
  const count = writes.length
  screen.restore()
  assert.equal(writes.length, count)
  assert.match(writes.at(-1), /\x1b\[\?25h\x1b\[\?1049l$/u)
})

test('differences are compared after color snapping', () => {
  const { screen, writes } = capture({ mode: '16' })
  const first = frame(['a'])
  screen.present(first)
  const next = frame(['a'])
  next.cells[0][0][1] = '#fefefe'
  screen.present(next)
  assert.equal(writes.length, 1)
})
