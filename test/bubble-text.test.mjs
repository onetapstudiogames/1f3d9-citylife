import test from 'node:test'
import assert from 'node:assert/strict'

import { bubbleTextWidth, sanitizeBubbleText, wrapBubbleText } from '../scripts/lib/bubble-text.mjs'
import { textCells } from '../scripts/lib/grid.mjs'

test('sanitizeBubbleText preserves full NFC text while neutralizing controls and whitespace', () => {
  const longEnding = `start\x00\x1b[2J\u200B\n\t cafe\u0301 ${'middle '.repeat(12)}猫✨ THE END`
  const safe = sanitizeBubbleText(longEnding)

  assert.equal(safe, `start [2J café ${'middle '.repeat(12)}猫✨ THE END`)
  assert.doesNotMatch(safe, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
  assert.match(safe, /THE END$/u)
})

test('bubbleTextWidth uses the grid cell measure for ASCII, combining text, CJK, and emoji', () => {
  const value = 'e\u0301猫✨'
  const safe = sanitizeBubbleText(value)

  assert.equal(bubbleTextWidth(value), textCells(safe).length)
  assert.equal(bubbleTextWidth(value), 5)
})

test('wrapBubbleText prefers word boundaries and keeps every sanitized character reachable', () => {
  const source = `alpha beta gamma ${'long-note '.repeat(10)}ending beyond sixty-four cells`
  const safe = sanitizeBubbleText(source)
  const lines = wrapBubbleText(source, 12)

  assert.ok(lines.length > 6)
  assert.ok(lines.every((line) => bubbleTextWidth(line) <= 12))
  assert.equal(lines.join(' '), safe)
  assert.equal(lines.at(-1), 'cells')
})

test('wrapBubbleText splits oversized words only between graphemes', () => {
  const source = 'ab猫✨e\u0301cdWITHOUTSPACES'
  const lines = wrapBubbleText(source, 5)

  assert.ok(lines.every((line) => bubbleTextWidth(line) <= 5))
  assert.equal(lines.join(''), sanitizeBubbleText(source))
  assert.ok(lines.some((line) => line.includes('é')))
  assert.ok(lines.some((line) => line.includes('猫')))
  assert.ok(lines.some((line) => line.includes('✨')))
})

test('wrapBubbleText handles empty and narrow widths without hanging or clipping wide graphemes', () => {
  assert.deepEqual(wrapBubbleText(' \n\t ', 8), [])
  assert.deepEqual(wrapBubbleText('猫a', 0), ['猫', 'a'])
  assert.deepEqual(wrapBubbleText('猫a', 1), ['猫', 'a'])
  assert.ok(wrapBubbleText('猫a', 1).every((line) => bubbleTextWidth(line) <= 2))
})
