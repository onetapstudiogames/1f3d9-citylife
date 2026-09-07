import assert from 'node:assert/strict'
import test from 'node:test'

import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { DARK, Grid, toPlainText } from '../scripts/lib/grid.mjs'
import { cellPixels } from '../scripts/lib/live-drawing.mjs'
import { layoutRooms, planRoomPlacements } from '../scripts/lib/live-layout.mjs'
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
  for (const line of ['  ▄██▄  ', '  ▀██▀  ', ' ▄████▄ ', ' ▀▀  ▀▀ ']) {
    assert.match(plain, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
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

test('live paint: floors tile, transparent residents preserve them, and things stay pictorial', () => {
  const floorDrawing = solidDrawing('#204020')
  const transparentResident = { ...resident(1, 'sparse'), drawing: { palette: ['#ff0000'], indices: [0, ...Array(63).fill(null)] } }
  const view = paintLiveView(observation([{
    ...room(1, 'painted room', [transparentResident]),
    drawing: floorDrawing,
    things: [
      { id: 1, drawing: solidDrawing('#ffff00') },
      { id: 2, drawing: null },
      { id: 3, drawing: null },
      { id: 4, drawing: null },
      { id: 5, drawing: null },
    ],
    thingsCount: 17,
  }]), { columns: 80, rows: 24 })

  assert.equal(view.cells[2][1][1], '#587058', 'wall is lightened from the room drawing')
  assert.ok(view.cells.flat().some(([, fg, bg]) => fg === '#182e1d' || bg === '#182e1d'), 'dimmed floor is visible')
  const redCell = view.cells.flat().find(([, fg]) => fg === '#ff0000')
  assert.equal(redCell[2], '#182e1d', 'transparent lower portrait pixel keeps the floor')
  assert.equal(locationOfColor(view, '#ffff00').length, 8, 'drawn thing is 4x2 terminal cells')
  assert.equal(view.cells.flat().filter(([character]) => character === '·').length, 12)
  assert.doesNotMatch(toPlainText(view), /thing|sparse/u)
  assert.notEqual(view.cells[3][2][2], DARK.room, 'floor begins at the room interior')
})

test('live paint: recorded 80x24 and 120x40 scenes show the intended floors, things, and people offline', async () => {
  const source = await createLiveSource({
    sceneFile: new URL('./fixtures/live-scene.json', import.meta.url),
    fetchImpl: async () => { throw new Error('replay attempted network') },
  })
  const smallObservation = await source.read(0, { maxRooms: 2, size: { columns: 80, rows: 24 } })
  const largeObservation = await source.read(0, { maxRooms: 3, size: { columns: 120, rows: 40 } })
  const small = paintLiveView(smallObservation, { columns: 80, rows: 24 })
  const large = paintLiveView(largeObservation, { columns: 120, rows: 40 })

  assert.ok(small.cells.flat().some(([, fg, bg]) => ['#13221c', '#192d23'].includes(fg) || ['#13221c', '#192d23'].includes(bg)), 'first-town grass is visible')
  assert.equal(small.cells.flat().filter(([character]) => character === '·').length, 11, 'the fair shows 16 minus 5 overflow dots')
  const workroomThingColours = new Set(largeObservation.rooms[2].things.find((item) => item.drawing)?.drawing.palette)
  const workroomResidentColours = new Set(largeObservation.rooms[2].residents.find((item) => item.drawing)?.drawing.palette)
  assert.ok(large.cells.flat().some(([, fg, bg]) => workroomThingColours.has(fg) || workroomThingColours.has(bg)), 'workroom drawn thing is visible')
  assert.ok(large.cells.flat().some(([, fg, bg]) => workroomResidentColours.has(fg) || workroomResidentColours.has(bg)), 'workroom drawn resident is visible')
})

test('live paint: a motion frame owns resident positions and blends faded pixels with the floor', () => {
  const moving = {
    ...resident(11, 'moving'),
    drawing: { palette: ['#ff0000'], indices: [0, ...Array(63).fill(null)] },
  }
  const movingRoom = { ...room(1, 'motion room', [moving]), drawing: solidDrawing('#204020'), things: [], thingsCount: 0 }
  const [box] = layoutRooms(1, { columns: 80, rows: 24 })
  const plan = planRoomPlacements(movingRoom, box)
  const pose = { resident: moving, roomId: 1, x: 15, y: 10, width: 8, height: 4, opacity: 0.5 }
  const view = paintLiveView(observation([movingRoom]), { columns: 80, rows: 24 }, {
    residents: [pose],
    bubbles: [],
    plans: [{ roomId: 1, ...plan }],
    doors: [],
  })

  assert.deepEqual(locationOfColor(view, '#8c170f'), [[15, 10]])
  assert.deepEqual(cellPixels(view.cells[10][15]), ['#8c170f', '#182e1d'])
  assert.deepEqual(cellPixels(view.cells[10][16]), ['#182e1d', '#182e1d'], 'transparent pixels leave the floor unchanged')
  assert.equal(locationOfColor(view, '#ff0000').length, 0, 'the static home portrait is not also painted')
})

test('live paint: only active motion doors open and expose the room floor', () => {
  const walker = resident(11, 'walker', '#ff0000')
  const rooms = [
    { ...room(1, 'left room', [walker]), things: [], thingsCount: 0 },
    { ...room(2, 'right room'), things: [], thingsCount: 0 },
  ]
  const boxes = layoutRooms(2, { columns: 80, rows: 24 })
  const plans = rooms.map((entry, index) => ({ roomId: entry.id, ...planRoomPlacements(entry, boxes[index]) }))
  const activeDoor = plans[0].doors.right
  const view = paintLiveView(observation(rooms), { columns: 80, rows: 24 }, {
    residents: [],
    bubbles: [],
    plans,
    doors: [{ roomId: 1, side: 'right', ...activeDoor }],
  })

  for (let y = activeDoor.y; y < activeDoor.y + activeDoor.height; y += 1) {
    assert.equal(view.cells[y][activeDoor.x][0], ' ')
    assert.notEqual(view.cells[y][activeDoor.x][2], DARK.room, 'the opening continues the floor through the wall')
  }
  assert.equal(view.cells[plans[0].doors.left.y][plans[0].doors.left.x][0], '│', 'an inactive door remains closed')

  const walking = paintLiveView(observation(rooms), { columns: 80, rows: 24 }, {
    residents: [{ resident: walker, roomId: 1, x: activeDoor.x, y: activeDoor.y, width: 8, height: 4, opacity: 1 }],
    bubbles: [],
    plans,
    doors: [{ roomId: 1, side: 'right', ...activeDoor }],
  })
  assert.equal(walking.cells[activeDoor.y][activeDoor.x][1], '#ff0000', 'the walk paints over the opened wall')
  assert.equal(walking.cells[activeDoor.y][activeDoor.x + 1][1], '#ff0000', 'the walk paints through the external gap')
})

test('live paint: bubbles stay inside their room, avoid portraits, and sanitize clipped public text', () => {
  const author = resident(11, 'author', '#ff0000')
  const neighbor = resident(12, 'neighbor', '#00ff00')
  const bubbleRoom = { ...room(1, 'bubble room', [author, neighbor]), things: [], thingsCount: 0 }
  const [box] = layoutRooms(1, { columns: 80, rows: 24 })
  const plan = planRoomPlacements(bubbleRoom, box)
  const poses = [
    { resident: author, roomId: 1, x: 8, y: 4, width: 8, height: 4, opacity: 1 },
    { resident: neighbor, roomId: 1, x: 27, y: 4, width: 8, height: 4, opacity: 1 },
  ]
  const view = paintLiveView(observation([bubbleRoom]), { columns: 80, rows: 24 }, {
    residents: poses,
    bubbles: [{ noteId: 1, roomId: 1, residentId: 11, text: 'hello\x1b[2J\nworld 12345678901234567890 EXCLUDED' }],
    plans: [{ roomId: 1, ...plan }],
    doors: [],
  })

  const bubbleCells = []
  view.cells.forEach((rowCells, y) => rowCells.forEach((cell, x) => {
    if (cell[2] === DARK.bubble) bubbleCells.push({ x, y, character: cell[0] })
    assert.doesNotMatch(cell[0], /[\x00-\x1f\x7f-\x9f]/u)
  }))
  assert.ok(bubbleCells.length > 0)
  assert.ok(bubbleCells.every(({ x, y }) => x > box.x && x < box.x + box.width - 1 && y > box.y && y < box.y + box.height - 1))
  for (const pose of poses) {
    assert.equal(bubbleCells.some(({ x, y }) => x >= pose.x && x < pose.x + pose.width && y >= pose.y && y < pose.y + pose.height), false)
  }
  const plain = toPlainText(view)
  assert.match(plain, /hello \[2J world/u)
  assert.match(plain, /EXCLUDED/u)
  assert.match(plain, /[┬┴├┤]/u, 'the bubble has a small tail aimed toward its author')

  const wide = paintLiveView(observation([bubbleRoom]), { columns: 80, rows: 24 }, {
    residents: poses,
    bubbles: [{ noteId: 2, roomId: 1, residentId: 11, text: '猫✨123456789012345678901X' }],
    plans: [{ roomId: 1, ...plan }],
    doors: [],
  })
  assert.match(toPlainText(wide), /猫✨123456789012345678901X/u, '24 wide graphemes fit when the room has enough cells')
})
