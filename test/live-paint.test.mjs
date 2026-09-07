import assert from 'node:assert/strict'
import test from 'node:test'

import { Grid, STANDIN, toPlainText } from '../scripts/lib/grid.mjs'
import { paintLiveView, visibleRoomLimit } from '../scripts/lib/live-render.mjs'

const solidDrawing = (hex) => ({ palette: [hex], indices: Array(64).fill(0) })

test('emoji, flags, keycaps, and CJK occupy two terminal cells without splitting at the edge', () => {
  for (const glyph of ['✨', '🇨🇦', '1️⃣', '界']) {
    const grid = new Grid(4, 1, '#000000')
    grid.put(0, 0, `A${glyph}B`)
    assert.deepEqual(grid.cells[0].map(cell => cell[0]), ['A', glyph, '', 'B'])
    const clipped = new Grid(2, 1, '#000000')
    clipped.put(0, 0, `A${glyph}`)
    assert.deepEqual(clipped.cells[0].map(cell => cell[0]), ['A', ' '])
  }
})

const room = (id, name, residents = []) => ({
  id,
  name,
  drawing: solidDrawing('#224422'),
  things: [{ id: id * 10, name: `thing ${id}`, drawing: solidDrawing('#ffff00') }],
  thingsCount: 99,
  residents,
  notes: [{ author: 'speaker', body: `a note in ${name}` }],
})

const resident = (id, handle, color = null) => ({
  id,
  handle,
  current_place_id: 1,
  drawing: color ? solidDrawing(color) : null,
})

const observation = (rooms) => ({
  ok: true,
  target: { id: 1, name: 'first town' },
  rooms,
  events: [{ actor: 'event-actor', kind: 'register' }],
  notes: [{ author: 'outside-speaker', body: 'outside note' }],
  directory: [{ id: 1, name: 'directory words' }],
})

const locationOfColor = (grid, color) => {
  const cells = []
  grid.cells.forEach((rowCells, y) => rowCells.forEach(([, fg], x) => {
    if (fg === color) cells.push([x, y])
  }))
  return cells
}

test('live paint: 80x24 shows two quiet room boxes and keeps the bottom line blank', () => {
  const view = paintLiveView(observation([
    room(1, 'town green', [resident(11, 'hidden-handle', '#ff0000')]),
    room(2, 'reading room', [resident(12, 'grey-handle')]),
    room(3, 'room that must be dropped'),
  ]), { columns: 80, rows: 24 })

  assert.equal(view.width, 80)
  assert.equal(view.height, 24)
  assert.ok(view.cells.every((rowCells) => rowCells.length === 80))
  assert.ok(view.cells.at(-1).every(([character]) => character === ' '))

  const plain = toPlainText(view)
  assert.match(plain, /^ first town/mu)
  assert.match(plain, /town green/u)
  assert.match(plain, /reading room/u)
  assert.doesNotMatch(plain, /room that must be dropped/u)
  for (const forbidden of ['hidden-handle', 'grey-handle', '99', 'thing 1', 'a note', 'event-actor', 'directory words', 'LIVE', 'resident', 'refreshed']) {
    assert.doesNotMatch(plain, new RegExp(forbidden, 'u'), forbidden)
  }
})

test('live paint: 120x40 fits three rooms in one horizontal row and silently drops the fourth', () => {
  const view = paintLiveView(observation([
    room(1, 'one'),
    room(2, 'two'),
    room(3, 'three'),
    room(4, 'four'),
  ]), { columns: 120, rows: 40 })
  const plain = toPlainText(view)

  for (const shown of ['one', 'two', 'three']) assert.match(plain, new RegExp(shown, 'u'))
  assert.doesNotMatch(plain, /four/u)

  const topBorders = view.cells.flat().filter(([character]) => character === '╭').length
  assert.equal(topBorders, 3)
  const borderRows = view.cells
    .map((rowCells, y) => rowCells.some(([character]) => character === '╭') ? y : null)
    .filter((y) => y !== null)
  assert.deepEqual([...new Set(borderRows)], [2])
})

test('live paint: the source can ask for the exact room limit before fetching room detail', () => {
  assert.equal(visibleRoomLimit({ columns: 80, rows: 24 }), 2)
  assert.equal(visibleRoomLimit({ columns: 120, rows: 40 }), 3)
  assert.equal(visibleRoomLimit({ columns: 3, rows: 24 }), 0)
  assert.equal(visibleRoomLimit({ columns: 80, rows: 3 }), 0)
})

test('live paint: drawn residents stay full 8x4 and undrawn residents use the four-line stand-in', () => {
  const view = paintLiveView(observation([
    room(1, 'portraits', [
      resident(11, 'painted', '#ff0000'),
      resident(12, 'not-painted'),
    ]),
  ]), { columns: 80, rows: 24 })
  const redCells = locationOfColor(view, '#ff0000')

  assert.equal(redCells.length, 32)
  assert.equal(new Set(redCells.map(([x]) => x)).size, 8)
  assert.equal(new Set(redCells.map(([, y]) => y)).size, 4)
  const plain = toPlainText(view)
  for (const line of STANDIN) assert.match(plain, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

test('live paint: resident positions are deterministic across input order changes', () => {
  const residents = [
    resident('resident-b', 'b', '#00ff00'),
    resident('resident-a', 'a', '#ff0000'),
    resident('resident-c', 'c', '#0000ff'),
  ]
  const first = paintLiveView(observation([room(1, 'stable room', residents)]), { columns: 80, rows: 24 })
  const second = paintLiveView(observation([room(1, 'stable room', residents.toReversed())]), { columns: 80, rows: 24 })

  for (const color of ['#00ff00', '#ff0000', '#0000ff']) {
    assert.deepEqual(locationOfColor(first, color), locationOfColor(second, color), color)
  }
})

test('live paint: numeric city ids decide which residents remain visible when a room is full', () => {
  const crowded = [103, 123, 171, 202, 221, 247, 286, 297, 8]
    .map((id) => resident(id, `resident-${id}`, id === 8 ? '#ff00ff' : null))
  const view = paintLiveView(observation([
    room(1, 'crowded room', crowded),
    room(2, 'second room'),
  ]), { columns: 80, rows: 24 })

  assert.equal(locationOfColor(view, '#ff00ff').length, 32)
})

test('live paint: public names cannot inject terminal controls or break requested bounds', () => {
  const unsafe = observation([room(1, 'room\x1b[2J\n猫の部屋')])
  unsafe.target.name = 'town\r\n\x1b[31m✨'
  const view = paintLiveView(unsafe, { columns: 37, rows: 12 })
  const plain = toPlainText(view)

  assert.equal(view.width, 37)
  assert.equal(view.height, 12)
  assert.ok(view.cells.every((rowCells) => rowCells.length === 37))
  assert.ok(view.cells.flat().every(([character]) => !/[\x00-\x1f\x7f-\x9f]/u.test(character)))
  assert.equal(view.cells[2][1][0], '╭')
  assert.equal(view.cells[2][35][0], '╮')
})
