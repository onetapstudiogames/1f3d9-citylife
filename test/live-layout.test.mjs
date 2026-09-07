import assert from 'node:assert/strict'
import test from 'node:test'

import {
  layoutRooms,
  planRoomPlacements,
  residentDrawingLimit,
  visibleRoomLimit,
} from '../scripts/lib/live-layout.mjs'

const resident = (id) => ({ id })
const thing = (id) => ({ id })

const intersects = (left, right) => !(
  left.x + left.width <= right.x ||
  right.x + right.width <= left.x ||
  left.y + left.height <= right.y ||
  right.y + right.height <= left.y
)

const expanded = (rectangle) => ({
  x: rectangle.x - 1,
  y: rectangle.y - 1,
  width: rectangle.width + 2,
  height: rectangle.height + 2,
})

test('live layout: 80x24 keeps seven crowded residents and the four-row aisle clear', () => {
  const [box] = layoutRooms(2, { columns: 80, rows: 24 })
  const plan = planRoomPlacements({
    residents: [103, 123, 171, 226, 44, 91, 8].map(resident),
    things: [],
    thingsCount: 0,
  }, box)

  assert.equal(plan.residents.length, 7)
  assert.equal(plan.aisle.height, 4)
  for (const placement of plan.residents) assert.equal(intersects(placement, plan.aisle), false)
})

test('live layout: things claim ground before residents with one shared empty-cell margin', () => {
  const [box] = layoutRooms(2, { columns: 80, rows: 24 })
  const plan = planRoomPlacements({
    things: [9, 2, 7, 1, 4].map(thing),
    thingsCount: 5,
    residents: [1, 2, 3, 4].map(resident),
  }, box)

  assert.deepEqual(plan.things.map(({ item }) => item.id), [1, 2, 4, 7, 9])
  assert.equal(plan.overflowDots.length, 0)
  const placements = [...plan.things, ...plan.residents]
  for (let index = 0; index < placements.length; index += 1) {
    for (let other = index + 1; other < placements.length; other += 1) {
      assert.equal(intersects(placements[index], placements[other]), false)
      assert.equal(intersects(expanded(placements[index]), placements[other]), false)
      assert.equal(intersects(placements[index], expanded(placements[other])), false)
    }
  }
})

test('live layout: overflow dots represent only things past the fifth', () => {
  const tinyBox = { x: 1, y: 2, width: 20, height: 6 }
  const fiveThatCannotAllFit = [1, 2, 3, 4, 5].map(thing)
  const noOverflow = planRoomPlacements({ things: fiveThatCannotAllFit, thingsCount: 5, residents: [] }, tinyBox)
  const cappedOverflow = planRoomPlacements({ things: fiveThatCannotAllFit, thingsCount: 30, residents: [] }, tinyBox)

  assert.ok(noOverflow.things.length < 5)
  assert.equal(noOverflow.overflowDots.length, 0)
  assert.equal(cappedOverflow.overflowDots.length, 12)
})

test('live layout: each resident keeps an 8-cell feeder clear to the aisle', () => {
  const [box] = layoutRooms(2, { columns: 80, rows: 24 })
  const plan = planRoomPlacements({
    things: [thing(1), thing(2), thing(3), thing(4), thing(5)],
    thingsCount: 5,
    residents: Array.from({ length: 12 }, (_, index) => resident(index + 1)),
  }, box)

  for (const placement of plan.residents) {
    for (const blocker of [...plan.things, ...plan.residents.filter((other) => other !== placement)]) {
      assert.equal(intersects(placement.feeder, blocker), false)
    }
  }
})

test('live layout: placements and fetch budgets stay stable across input order', () => {
  const [box] = layoutRooms(2, { columns: 80, rows: 24 })
  const items = [resident(20), resident(3), resident(11)]
  const first = planRoomPlacements({ things: [], thingsCount: 0, residents: items }, box)
  const second = planRoomPlacements({ things: [], thingsCount: 0, residents: items.toReversed() }, box)
  const positions = (plan) => plan.residents.map(({ item, x, y }) => [item.id, x, y])

  assert.deepEqual(positions(first), positions(second))
  assert.equal(visibleRoomLimit({ columns: 80, rows: 24 }), 2)
  assert.ok(residentDrawingLimit({ columns: 80, rows: 24 }, 2) >= 7)
})
