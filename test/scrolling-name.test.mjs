import assert from 'node:assert/strict'
import test from 'node:test'
import { NAME_STEP_MS, paintScrollingName, scrollingName } from '../scripts/lib/scrolling-name.mjs'
import { DARK, Grid, textCells } from '../scripts/lib/grid.mjs'

test('keeps short names readable and sanitizes terminal controls', () => {
  assert.equal(scrollingName('  cafe\u0301\u001b[31m  ', 10, 99_999), 'café [31m')
  assert.equal(scrollingName('alice', 8, 99_999), 'alice')
  assert.equal(scrollingName('alice', 0, 0), '')
})

test('pauses at both ends and exposes every part of a long name', () => {
  const name = 'abcdefgh'
  assert.equal(NAME_STEP_MS, 400)
  assert.equal(scrollingName(name, 4, 0), 'abcd')
  assert.equal(scrollingName(name, 4, 1_599), 'abcd')
  assert.equal(scrollingName(name, 4, 1_600), 'bcde')
  assert.equal(scrollingName(name, 4, 2_800), 'efgh')
  assert.equal(scrollingName(name, 4, 4_399), 'efgh')
  assert.equal(scrollingName(name, 4, 4_400), 'abcd')

  const cycle = Array.from({ length: 12 }, (_, index) => scrollingName(name, 4, index * NAME_STEP_MS))
  assert.ok(cycle.includes('abcd'))
  assert.ok(cycle.includes('efgh'))
})

test('never splits wide or combining graphemes and keeps overflow geometry stable', () => {
  const samples = [0, 1_600, 2_000, 2_400, 2_800, 3_200]
    .map((nowMs) => scrollingName('A猫e\u0301B猫Z', 4, nowMs))
  for (const sample of samples) {
    assert.equal(textCells(sample).length, 4)
    assert.doesNotMatch(sample, /\u001b/u)
    assert.doesNotMatch(sample.normalize('NFD'), /^\p{M}/u)
  }
  assert.ok(samples.some((sample) => sample.includes('A猫')))
  assert.ok(samples.some((sample) => sample.includes('猫Z')))
  assert.equal(textCells(scrollingName('猫', 1, 0)).length, 1)
})

test('normalizes invalid dimensions and clocks without exceeding the bound', () => {
  for (const columns of [-3, 0, 1, 2, 5]) {
    const result = scrollingName('long resident name', columns, Number.NaN)
    assert.ok(textCells(result).length <= Math.max(0, columns))
  }
})

test('paint schedules only visible overflowing names and preserves an earlier deadline', () => {
  const grid = new Grid(20, 2, DARK.bg)
  paintScrollingName(grid, 0, 0, 'short', DARK.muted, undefined, 8, 450)
  assert.equal(grid.nextNameAtMs, undefined)
  paintScrollingName(grid, 0, 1, 'overflowing name', DARK.muted, undefined, 8, 450)
  assert.equal(grid.nextNameAtMs, 800)
  grid.nextNameAtMs = 700
  paintScrollingName(grid, 0, 1, 'overflowing name', DARK.muted, undefined, 8, 450)
  assert.equal(grid.nextNameAtMs, 700)
})
