import assert from 'node:assert/strict'
import test from 'node:test'

import { DARK, toPlainText } from '../scripts/lib/grid.mjs'
import { layoutRooms, planRoomPlacements } from '../scripts/lib/live-layout.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'

const solidDrawing = (hex) => ({ palette: [hex], indices: Array(64).fill(0) })
const resident = (id, handle, color, asleep = false) => ({ id, handle, current_place_id: 1, drawing: solidDrawing(color), asleep })
const thing = { id: 10, drawing: solidDrawing('#ffff00') }
const room = (overrides = {}) => ({
  id: 1,
  name: 'follow room',
  quiet: false,
  drawing: solidDrawing('#224422'),
  things: [thing],
  thingsCount: 1,
  residents: [resident(1, 'alice', '#ff0000'), resident(2, 'bob', '#0000ff')],
  notes: [],
  ...overrides,
})
const scene = (roomValue) => ({
  ok: true,
  target: { id: 1, name: 'follow room' },
  focus: { id: 1, handle: 'alice', placeId: 1 },
  residents: roomValue.residents,
  rooms: [roomValue],
  events: [],
  notes: [],
})
const framed = (roomValue, effects = []) => {
  const box = layoutRooms(1, { columns: 80, rows: 24 })[0]
  const plan = { roomId: 1, ...planRoomPlacements(roomValue, box) }
  return {
    plans: [plan],
    residents: plan.residents.map((entry) => ({
      resident: entry.item, roomId: 1, x: entry.x, y: entry.y, width: 8, height: 4, opacity: 1,
    })),
    bubbles: [],
    doors: [],
    effects,
  }
}
const colored = (grid, color) => grid.cells.flat().filter(([, fg, bg]) => fg === color || bg === color).length

test('follow paint marks the focused portrait and draws use, gift, and carry cues without prose', () => {
  const current = room()
  const baseFrame = framed(current)
  const alice = baseFrame.residents.find(({ resident: item }) => item.id === 1)
  const bob = baseFrame.residents.find(({ resident: item }) => item.id === 2)
  const effects = [
    { id: 1, type: 'glow', roomId: 1, thingId: 10, progress: 0.25 },
    { id: 2, type: 'gift', roomId: 1, thing, fromResidentId: 1, toResidentId: 2, progress: 0.5 },
    { id: 3, type: 'carry', roomId: 1, thing, carrierResidentId: 1, progress: 0.5 },
  ]
  const view = paintLiveView(scene(current), { columns: 80, rows: 24 }, { ...baseFrame, effects })
  const plain = toPlainText(view)

  assert.equal(view.cells[alice.y + 1][alice.x - 1][0], '›')
  assert.equal(view.cells[alice.y + 1][alice.x + alice.width][0], '‹')
  assert.match(plain, /♥/u)
  assert.doesNotMatch(plain, /alice|gift|carry|use/iu)
  assert.ok(colored(view, DARK.hi) > 2, 'effects add a warm visual cue')
  assert.ok(bob, 'the recorded recipient is visible')
})

test('a carried thing leaves its reserved floor spot and appears only on its visible carrier', () => {
  const current = room()
  const baseFrame = framed(current)
  const floorThing = baseFrame.plans[0].things.find(({ item }) => item.id === 10)
  const alice = baseFrame.residents.find(({ resident: item }) => item.id === 1)
  const view = paintLiveView(scene(current), { columns: 80, rows: 24 }, {
    ...baseFrame,
    effects: [{ id: 3, type: 'carry', roomId: 1, thingId: 10, thing, carrierResidentId: 1, progress: 0.5 }],
  })
  const uncarried = paintLiveView(scene(current), { columns: 80, rows: 24 }, baseFrame)
  const hasYellow = (x, y) => view.cells[y][x][1] === '#ffff00' || view.cells[y][x][2] === '#ffff00'

  assert.equal(Array.from({ length: floorThing.height }, (_, y) =>
    Array.from({ length: floorThing.width }, (_, x) => hasYellow(floorThing.x + x, floorThing.y + y))).flat().some(Boolean), false)
  assert.notDeepEqual(view.cells[alice.y + 1][alice.x + alice.width - 2], uncarried.cells[alice.y + 1][alice.x + alice.width - 2],
    'the carried pixels replace part of the carrier portrait')
  assert.equal(baseFrame.plans[0].things.length, 1, 'the floor reservation remains in the plan')
})

test('focus marks stay inside the room when the followed resident reaches a door', () => {
  const current = room({ things: [], thingsCount: 0, residents: [resident(1, 'alice', '#ff0000')] })
  const baseFrame = framed(current)
  const plan = baseFrame.plans[0]
  const atDoor = {
    ...baseFrame.residents[0],
    x: plan.box.x,
    y: plan.doors.left.y,
  }
  const view = paintLiveView(scene(current), { columns: 80, rows: 24 }, {
    ...baseFrame,
    residents: [atDoor],
    doors: [{ roomId: 1, side: 'left', ...plan.doors.left }],
  })

  assert.notEqual(view.cells[atDoor.y + 1][plan.box.x][0], '›', 'the opened wall cell is not used as a marker')
  assert.equal(view.cells[atDoor.y + 1][plan.box.x + 1][0], '›')
  assert.equal(view.cells[atDoor.y + 1][plan.box.x - 1][0], ' ')
})

test('quiet follow rooms paint a closed curtain and suppress every person, thing, bubble, and effect', () => {
  const closed = room({ quiet: true })
  const motion = framed(closed, [{ id: 1, type: 'gift', roomId: 1, thing, fromResidentId: 1, toResidentId: 2, progress: 0.5 }])
  motion.bubbles = [{ noteId: 1, roomId: 1, residentId: 1, text: 'must stay hidden' }]
  const view = paintLiveView(scene(closed), { columns: 80, rows: 24 }, motion)
  const plain = toPlainText(view)

  assert.match(plain, /[░▒]/u)
  assert.doesNotMatch(plain, /♥|must stay hidden/u)
  for (const hiddenColor of ['#ff0000', '#0000ff', '#ffff00']) assert.equal(colored(view, hiddenColor), 0)
})

test('asleep rotates only the resident drawing while preserving its 8 by 4 home', () => {
  const asymmetric = { palette: ['#ff0000'], indices: [0, ...Array(63).fill(null)] }
  const awakeRoom = room({ things: [], thingsCount: 0, residents: [{ ...resident(1, 'alice', '#ff0000'), drawing: asymmetric }] })
  const asleepRoom = room({ things: [], thingsCount: 0, residents: [{ ...awakeRoom.residents[0], asleep: true }] })
  const awakeFrame = framed(awakeRoom)
  const asleepFrame = framed(asleepRoom)
  const awake = paintLiveView(scene(awakeRoom), { columns: 80, rows: 24 }, awakeFrame)
  const asleep = paintLiveView(scene(asleepRoom), { columns: 80, rows: 24 }, asleepFrame)
  const locations = (grid) => grid.cells.flatMap((cells, y) => cells.flatMap(([, fg, bg], x) => fg === '#ff0000' || bg === '#ff0000' ? [[x, y]] : []))

  assert.notDeepEqual(locations(asleep), locations(awake))
  assert.equal(new Set(asleepFrame.residents.map(({ width }) => width)).has(8), true)
  assert.equal(new Set(asleepFrame.residents.map(({ height }) => height)).has(4), true)

  const walkingFrame = { ...asleepFrame, doors: [{ roomId: 1, side: 'left', ...asleepFrame.plans[0].doors.left }] }
  const walking = paintLiveView(scene(asleepRoom), { columns: 80, rows: 24 }, walkingFrame)
  assert.deepEqual(locations(walking), locations(awake), 'a recorded walk keeps the sleeping resident upright')

  const legacy = paintLiveView({ ...scene(asleepRoom), focus: null }, { columns: 80, rows: 24 }, asleepFrame)
  const legacyAwake = paintLiveView({ ...scene(awakeRoom), focus: null }, { columns: 80, rows: 24 }, awakeFrame)
  assert.deepEqual(legacy.cells, legacyAwake.cells, 'non-follow pictures preserve their existing pose')
})
