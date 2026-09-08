import assert from 'node:assert/strict'
import test from 'node:test'
import { paintAnnotations } from '../scripts/lib/follow-annotations.mjs'
import { Grid, DARK, toPlainText } from '../scripts/lib/grid.mjs'

const box = { x: 1, y: 1, width: 38, height: 14 }
const resident = (id, handle, asleep = false) => ({ id, handle, asleep })
const pose = (item, overrides = {}) => ({ resident: item, roomId: 1, x: 5, y: 5, width: 8, height: 4, ...overrides })
const state = (overrides = {}) => ({ room: { id: 1, quiet: false }, box, plan: { things: [] }, ...overrides })
const paint = ({ states = [state()], poses = [pose(resident(1, 'alice'))], focus = { id: 1 }, frame = {} } = {}) => {
  const grid = new Grid(42, 18, DARK.bg)
  const rectangles = paintAnnotations(grid, { focus }, states, poses, frame)
  return { grid, rectangles, plain: toPlainText(grid) }
}

test('labels residents and truly asleep residents with deterministic sleep phases', () => {
  for (const [sleepPhase, mark] of [[0, 'z'], [1, 'zz'], [2, 'zzZ'], [5, 'zzZ']]) {
    const result = paint({ poses: [pose(resident(1, 'alice', true))], frame: { sleepPhase } })
    assert.match(result.plain, new RegExp(mark))
    assert.match(result.plain, /alice/)
    assert.equal(result.rectangles.length, 2)
  }
  assert.doesNotMatch(paint().plain, /\bz/i)
})

test('sleep marks skip awake, walking, and the focused resident during active door travel', () => {
  assert.doesNotMatch(paint({ poses: [pose(resident(1, 'awake'))] }).plain, /\bz/i)
  assert.doesNotMatch(paint({ poses: [pose(resident(1, 'walker', true), { walking: true })] }).plain, /\bz/i)
  assert.doesNotMatch(paint({ poses: [pose(resident(1, 'doorway', true))], frame: { doors: [{}] } }).plain, /\bz/i)
  assert.match(paint({ poses: [pose(resident(2, 'sleeper', true))], frame: { doors: [{}] } }).plain, /z/)
})

test('quiet rooms and observations without a focus reveal no annotations', () => {
  const quiet = state({ room: { id: 1, quiet: true }, plan: { things: [{ item: { id: 7, name: 'secret' }, x: 20, y: 5, width: 4, height: 2 }] } })
  assert.deepEqual(paint({ states: [quiet], poses: [pose(resident(1, 'hidden', true))] }).rectangles, [])
  assert.deepEqual(paint({ focus: null }).rectangles, [])
})

test('sanitizes and scrolls wide Unicode resident names through stable eighteen-cell labels', () => {
  const handle = '猫猫猫\u001b[31m enormously long resident name'
  const start = paint({ poses: [pose(resident(1, handle))], frame: { nameTimeMs: 0 } })
  const end = paint({ poses: [pose(resident(1, handle))], frame: { nameTimeMs: 11_000 } })
  const result = start
  assert.equal(result.rectangles.length, 1)
  assert.equal(result.rectangles[0].width, 18)
  assert.deepEqual(end.rectangles, start.rectangles)
  assert.doesNotMatch(result.plain, /\u001b/)
  assert.equal(result.grid.cells[result.rectangles[0].y][result.rectangles[0].x][0], '猫')
  assert.match(end.plain, /resident name/)
})

test('labels things below floor marks and removes a carried thing label', () => {
  const thing = { item: { id: 7, name: 'teapot' }, x: 20, y: 5, width: 4, height: 2 }
  const states = [state({ plan: { things: [thing] } })]
  assert.match(paint({ states }).plain, /teapot/)
  assert.doesNotMatch(paint({ states, frame: { effects: [{ type: 'carry', thingId: 7, carrierResidentId: 1 }] } }).plain, /teapot/)
})

test('scrolls long thing names to their ending without moving the label', () => {
  const thing = { item: { id: 7, name: 'ceremonial copper teapot' }, x: 20, y: 5, width: 4, height: 2 }
  const states = [state({ plan: { things: [thing] } })]
  const start = paint({ states, frame: { nameTimeMs: 0 } })
  const end = paint({ states, frame: { nameTimeMs: 4_000 } })
  assert.deepEqual(end.rectangles, start.rectangles)
  assert.match(start.plain, /ceremonial copper/)
  assert.match(end.plain, /copper teapot/)
})

test('shrinks a seventeen-cell name into a scrolling slot when its full width collides', () => {
  const long = pose(resident(1, 'abcdefghijklmnopq'), { x: 5 })
  const blocker = pose(resident(2, ''), { x: 18, y: 9, width: 8, height: 4 })
  const result = paint({ poses: [long, blocker] })
  assert.equal(result.rectangles.length, 1)
  assert.ok(result.rectangles[0].width >= 2)
  assert.ok(result.rectangles[0].width < 17)
  assert.equal(result.grid.nextNameAtMs, 400)
})

test('omits labels outside room bounds or blocked by another portrait', () => {
  const cramped = { x: 1, y: 1, width: 16, height: 6 }
  const low = pose(resident(1, 'low'), { x: 4, y: 3, width: 8, height: 3 })
  assert.doesNotMatch(paint({ states: [state({ box: cramped })], poses: [low] }).plain, /low/)
  const alice = pose(resident(1, 'alice'))
  const blocker = pose(resident(2, 'blocker'), { x: 5, y: 9, width: 8, height: 4 })
  const result = paint({ poses: [alice, blocker] })
  assert.doesNotMatch(result.plain, /alice/)
  assert.match(result.plain, /blocker/)
  for (const rectangle of result.rectangles) {
    assert.ok(rectangle.x > box.x && rectangle.x + rectangle.width <= box.x + box.width - 1)
    assert.ok(rectangle.y > box.y && rectangle.y < box.y + box.height - 1)
  }
})

test('annotations avoid each other and all entity rectangles', () => {
  const thing = { item: { id: 7, name: 'lamp' }, x: 24, y: 5, width: 4, height: 2 }
  const poses = [pose(resident(1, 'alice', true)), pose(resident(2, 'bob'), { x: 15, y: 5 })]
  const result = paint({ states: [state({ plan: { things: [thing] } })], poses, frame: { sleepPhase: 2 } })
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  for (let i = 0; i < result.rectangles.length; i++) {
    for (let j = i + 1; j < result.rectangles.length; j++) assert.equal(intersects(result.rectangles[i], result.rectangles[j]), false)
    for (const entity of [...poses, thing]) assert.equal(intersects(result.rectangles[i], entity), false)
  }
})

test('same-row labels keep one blank cell between their rectangles', () => {
  const poses = [
    pose(resident(1, 'abcdefghij'), { x: 5 }),
    pose(resident(2, 'klmnopqrst'), { x: 15 }),
  ]
  const result = paint({ poses })
  assert.equal(result.rectangles.length, 2)
  const labels = [...result.rectangles].sort((left, right) => left.x - right.x)
  assert.equal(labels[0].y, labels[1].y)
  assert.ok(labels[0].x + labels[0].width + 1 <= labels[1].x)
})
