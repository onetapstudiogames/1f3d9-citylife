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

test('sanitizes, clips, and measures wide Unicode names to eighteen cells', () => {
  const result = paint({ poses: [pose(resident(1, '猫猫猫\u001b[31m enormously long resident name'))] })
  assert.equal(result.rectangles.length, 1)
  assert.ok(result.rectangles[0].width <= 18)
  assert.doesNotMatch(result.plain, /\u001b/)
  assert.match(result.plain, /…/u)
  assert.equal(result.grid.cells[result.rectangles[0].y][result.rectangles[0].x][0], '猫')
})

test('labels things below floor marks and removes a carried thing label', () => {
  const thing = { item: { id: 7, name: 'teapot' }, x: 20, y: 5, width: 4, height: 2 }
  const states = [state({ plan: { things: [thing] } })]
  assert.match(paint({ states }).plain, /teapot/)
  assert.doesNotMatch(paint({ states, frame: { effects: [{ type: 'carry', thingId: 7, carrierResidentId: 1 }] } }).plain, /teapot/)
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
