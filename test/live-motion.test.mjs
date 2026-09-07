import assert from 'node:assert/strict'
import test from 'node:test'

import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { stepMotion } from '../scripts/lib/live-motion.mjs'

const SMALL = Object.freeze({ columns: 80, rows: 24 })
const LARGE = Object.freeze({ columns: 120, rows: 40 })

const resident = (id, handle, roomId) => ({ id, handle, current_place_id: roomId, drawing: null })
const room = (id, residents = [], things = []) => ({
  id,
  name: `room ${id}`,
  drawing: null,
  residents,
  things,
  thingsCount: things.length,
  notes: [],
})
const observation = ({ rooms, events = [], notes = [], targetId = 1 }) => ({
  ok: true,
  target: { id: targetId, name: `place ${targetId}` },
  rooms,
  events,
  notes,
  directory: [],
})
const moveEvent = (id, actor, from, to, overrides = {}) => ({
  id,
  kind: 'action',
  actor,
  detail: { action: 'move', status: 'applied', from_place_id: from, to_place_id: to, ...overrides },
})
const note = (id, author, placeId, body) => ({ id, author, place_id: placeId, body })
const pose = (frame, id) => frame.residents.find((entry) => String(entry.resident.id) === String(id))
const intersects = (left, right) => !(
  left.x + left.width <= right.x || right.x + right.width <= left.x ||
  left.y + left.height <= right.y || right.y + right.height <= left.y
)
const graphemes = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]

const assertCollisionFree = (frame, movingId) => {
  for (let index = 0; index < frame.residents.length; index += 1) {
    const current = frame.residents[index]
    for (let other = index + 1; other < frame.residents.length; other += 1) {
      assert.equal(intersects(current, frame.residents[other]), false, `resident collision at ${current.x},${current.y}`)
    }
    for (const plan of frame.plans) {
      for (const thing of plan.things) {
        assert.equal(intersects(current, thing), false, `thing collision in room ${plan.roomId} at ${current.x},${current.y}`)
      }
    }
  }

  const moving = pose(frame, movingId)
  if (!moving) return
  for (const plan of frame.plans) {
    const walls = {
      top: { x: plan.box.x, y: plan.box.y, width: plan.box.width, height: 1 },
      bottom: { x: plan.box.x, y: plan.box.y + plan.box.height - 1, width: plan.box.width, height: 1 },
      left: { x: plan.box.x, y: plan.box.y, width: 1, height: plan.box.height },
      right: { x: plan.box.x + plan.box.width - 1, y: plan.box.y, width: 1, height: plan.box.height },
    }
    assert.equal(intersects(moving, walls.top), false, `top wall collision in room ${plan.roomId}`)
    assert.equal(intersects(moving, walls.bottom), false, `bottom wall collision in room ${plan.roomId}`)
    for (const side of ['left', 'right']) {
      if (!intersects(moving, walls[side])) continue
      const door = frame.doors.find((entry) => roomKey(entry.roomId) === roomKey(plan.roomId) && entry.side === side)
      assert.ok(door && moving.y >= door.y && moving.y + moving.height <= door.y + door.height, `closed ${side} wall collision in room ${plan.roomId}`)
    }
  }
}

const roomKey = (value) => String(value)

test('recorded replay ignores baseline history, walks only on the new applied move, and never infers a snapshot walk', async () => {
  const source = await createLiveSource({
    sceneFile: new URL('./fixtures/live-scene.json', import.meta.url),
    fetchImpl: async () => { throw new Error('motion replay attempted network') },
  })
  const initial = await source.read(0, { maxRooms: 2, size: SMALL })
  const moved = await source.read(30_000, { maxRooms: 2, size: SMALL })

  let result = stepMotion(null, { nowMs: 0, observation: initial, size: SMALL })
  assert.equal(result.frame.doors.length, 0, 'the real baseline move is history, not a new walk')
  assert.equal(result.frame.bubbles.length, 0, 'the real baseline notes are history, not new bubbles')

  result = stepMotion(result.state, { nowMs: 30_000, observation: moved, size: SMALL })
  assert.equal(pose(result.frame, 8).roomId, 2)
  assert.deepEqual(result.frame.doors.map(({ roomId, side }) => [roomId, side]), [[2, 'right'], [34, 'left']])
  assertCollisionFree(result.frame, 8)

  for (let nowMs = 30_125; nowMs < 32_000; nowMs += 125) {
    result = stepMotion(result.state, { nowMs, size: SMALL })
    assertCollisionFree(result.frame, 8)
  }
  assert.equal(pose(result.frame, 8).width, 8)
  assert.equal(pose(result.frame, 8).height, 4)

  result = stepMotion(result.state, { nowMs: 32_000, size: SMALL })
  assert.equal(pose(result.frame, 8).roomId, 34)
  assert.equal(result.frame.doors.length, 0)

  const withoutNewEvent = { ...moved, events: initial.events }
  const snapped = stepMotion(
    stepMotion(null, { nowMs: 0, observation: initial, size: SMALL }).state,
    { nowMs: 30_000, observation: withoutNewEvent, size: SMALL },
  )
  assert.equal(pose(snapped.frame, 8).roomId, 34)
  assert.equal(snapped.frame.doors.length, 0, 'presence relocation alone snaps without a walk')

  const noted = await source.read(60_000, { maxRooms: 2, size: SMALL })
  result = stepMotion(result.state, { nowMs: 60_000, observation: noted, size: SMALL })
  assert.deepEqual(result.frame.bubbles, [{
    noteId: 9007199254740000,
    roomId: 34,
    residentId: 8,
    text: 'The fair grass remembers',
  }])
  result = stepMotion(result.state, { nowMs: 65_999, size: SMALL })
  assert.equal(result.frame.bubbles.length, 1)
  result = stepMotion(result.state, { nowMs: 66_000, size: SMALL })
  assert.equal(result.frame.bubbles.length, 0)
})

test('a direct fake-clock jump advances old-scene deadlines before ingesting the next observation', async () => {
  const source = await createLiveSource({ sceneFile: new URL('./fixtures/live-scene.json', import.meta.url) })
  const initial = await source.read(0, { maxRooms: 2, size: SMALL })
  const moved = await source.read(30_000, { maxRooms: 2, size: SMALL })
  let repeated = stepMotion(null, { nowMs: 0, observation: initial, size: SMALL })
  for (let nowMs = 125; nowMs < 30_000; nowMs += 125) {
    repeated = stepMotion(repeated.state, { nowMs, size: SMALL })
  }
  repeated = stepMotion(repeated.state, { nowMs: 30_000, observation: moved, size: SMALL })

  const seeded = stepMotion(null, { nowMs: 0, observation: initial, size: SMALL })
  const jumped = stepMotion(seeded.state, { nowMs: 30_000, observation: moved, size: SMALL })
  assert.deepEqual(jumped.frame, repeated.frame)
  assert.equal(jumped.nextAtMs, repeated.nextAtMs)
})

test('the real move starts at the exact prior pose without moving any unchanged resident at the same clock', async () => {
  const source = await createLiveSource({ sceneFile: new URL('./fixtures/live-scene.json', import.meta.url) })
  const initial = await source.read(0, { maxRooms: 2, size: SMALL })
  const moved = await source.read(30_000, { maxRooms: 2, size: SMALL })
  let before = stepMotion(null, { nowMs: 0, observation: initial, size: SMALL })
  before = stepMotion(before.state, { nowMs: 30_000, size: SMALL })
  const after = stepMotion(before.state, { nowMs: 30_000, observation: moved, size: SMALL })

  for (const id of [8, 91, 123, 32]) {
    const oldPose = pose(before.frame, id)
    const newPose = pose(after.frame, id)
    assert.deepEqual(
      { x: newPose.x, y: newPose.y },
      { x: oldPose.x, y: oldPose.y },
      `resident ${id} does not teleport when the move record arrives`,
    )
  }
})

test('failed, same-room, go-home, and unknown-actor events never start walks', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2)] })
  const after = observation({
    rooms: [room(1, [alice]), room(2)],
    events: [
      moveEvent(1, 'alice', 1, 2, { status: 'refused' }),
      moveEvent(2, 'alice', 1, 1),
      { ...moveEvent(3, 'alice', 1, 2), detail: { ...moveEvent(3, 'alice', 1, 2).detail, action: 'go_home' } },
      moveEvent(4, 'nobody', 1, 2),
    ],
  })
  const seeded = stepMotion(null, { nowMs: 0, observation: before, size: SMALL })
  const result = stepMotion(seeded.state, { nowMs: 30_000, observation: after, size: SMALL })

  assert.equal(result.frame.doors.length, 0)
  assert.equal(pose(result.frame, 1).roomId, 1)
})

test('a nonadjacent move fades between endpoint door legs and never crosses the displayed middle room', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2), room(3)] })
  const after = observation({ rooms: [room(1), room(2), room(3, [{ ...alice, current_place_id: 3 }])], events: [moveEvent(1, 'alice', 1, 3)] })
  let state = stepMotion(null, { nowMs: 0, observation: before, size: LARGE }).state
  const samples = []
  for (const nowMs of [30_000, 30_625, 30_750, 30_875, 31_000, 31_125, 31_250, 31_500, 32_000]) {
    const result = stepMotion(state, { nowMs, observation: nowMs === 30_000 ? after : undefined, size: LARGE })
    state = result.state
    samples.push(result.frame)
  }

  const middle = samples[0].plans.find((plan) => plan.roomId === 2).box
  for (const frame of samples) {
    const actor = pose(frame, 1)
    if (actor) assert.equal(intersects(actor, middle), false, `actor entered middle room at x=${actor.x}`)
  }
  assert.ok(samples.some((frame) => !pose(frame, 1)), 'the unshown route has a hidden middle phase')
  assert.ok(samples.some((frame) => pose(frame, 1)?.opacity === 0.5), 'departure or arrival uses a fade frame')
  assert.equal(pose(samples.at(-1), 1).roomId, 3)
})

test('one visible endpoint walks to its outer door and fades over exactly two 125ms frames', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2), room(3)] })
  const after = observation({ rooms: [room(1), room(2), room(3, [{ ...alice, current_place_id: 3 }])], events: [moveEvent(1, 'alice', 1, 3)] })
  let state = stepMotion(null, { nowMs: 0, observation: before, size: SMALL }).state
  const frames = []
  for (const nowMs of [30_000, 31_625, 31_750, 31_875, 32_000]) {
    const result = stepMotion(state, { nowMs, observation: nowMs === 30_000 ? after : undefined, size: SMALL })
    state = result.state
    frames.push(result.frame)
  }

  assert.equal(frames[0].doors.length, 1)
  assert.equal(pose(frames[1], 1).opacity, 1)
  assert.equal(pose(frames[2], 1).opacity, 0.5)
  assert.equal(pose(frames[3], 1).opacity, 0.25)
  assert.equal(pose(frames[4], 1), undefined)
})

test('resize during a walk cancels it and replans the current observation inside the new bounds', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2)] })
  const after = observation({ rooms: [room(1), room(2, [{ ...alice, current_place_id: 2 }])], events: [moveEvent(1, 'alice', 1, 2)] })
  let result = stepMotion(null, { nowMs: 0, observation: before, size: SMALL })
  result = stepMotion(result.state, { nowMs: 30_000, observation: after, size: SMALL })
  result = stepMotion(result.state, { nowMs: 31_000, size: SMALL })
  assert.equal(result.frame.doors.length, 2)

  result = stepMotion(result.state, { nowMs: 31_125, size: LARGE })
  const current = pose(result.frame, 1)
  const destination = result.frame.plans.find((plan) => plan.roomId === 2).box
  assert.equal(result.frame.doors.length, 0)
  assert.equal(current.roomId, 2)
  assert.ok(current.x >= destination.x + 1 && current.x + current.width <= destination.x + destination.width - 1)
})

test('a follow re-layout treats a missing old source as offscreen and maps the arrival to the current box', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2)], targetId: 1 })
  const after = observation({
    rooms: [room(2, [{ ...alice, current_place_id: 2 }]), room(3)],
    events: [moveEvent(1, 'alice', 1, 2)],
    targetId: 2,
  })
  const seeded = stepMotion(null, { nowMs: 0, observation: before, size: SMALL })
  const result = stepMotion(seeded.state, { nowMs: 30_000, observation: after, size: SMALL })
  const current = pose(result.frame, 1)
  const currentBox = result.frame.plans.find((plan) => plan.roomId === 2).box

  assert.deepEqual(result.frame.doors.map(({ roomId }) => roomId), [2])
  assert.equal(current.roomId, 2)
  assert.ok(intersects(current, currentBox), 'arrival is drawn in the current room box')
})

test('same-actor A to B to C events queue real safe legs through the recorded intermediate endpoint', () => {
  const alice = resident(1, 'alice', 1)
  const before = observation({ rooms: [room(1, [alice]), room(2), room(3)] })
  const after = observation({
    rooms: [room(1), room(2), room(3, [{ ...alice, current_place_id: 3 }])],
    events: [moveEvent(1, 'alice', 1, 2), moveEvent(2, 'alice', 2, 3)],
  })
  let result = stepMotion(null, { nowMs: 0, observation: before, size: LARGE })
  result = stepMotion(result.state, { nowMs: 30_000, observation: after, size: LARGE })
  assert.deepEqual(result.frame.doors.map(({ roomId }) => roomId), [1, 2])

  result = stepMotion(result.state, { nowMs: 32_000, size: LARGE })
  assert.equal(pose(result.frame, 1).roomId, 2)
  assert.deepEqual(result.frame.doors.map(({ roomId }) => roomId), [2, 3])
  result = stepMotion(result.state, { nowMs: 34_000, size: LARGE })
  assert.equal(pose(result.frame, 1).roomId, 3)
  assert.equal(result.frame.doors.length, 0)
})

test('queued walks reserve synthetic feeders by freezing other residents until the recorded legs finish', () => {
  const alice = resident(1, 'alice', 1)
  const bob = resident(2, 'bob', 1)
  const cy = resident(3, 'cy', 2)
  const before = observation({ rooms: [room(1, [alice, bob]), room(2, [cy]), room(3)] })
  const after = observation({
    rooms: [room(1, [bob]), room(2, [cy]), room(3, [{ ...alice, current_place_id: 3 }])],
    events: [moveEvent(1, 'alice', 1, 2), moveEvent(2, 'alice', 2, 3)],
  })
  let result = stepMotion(null, { nowMs: 0, observation: before, size: LARGE })
  result = stepMotion(result.state, { nowMs: 1_000, observation: after, size: LARGE })
  const standing = new Map([2, 3].map((id) => [id, { x: pose(result.frame, id).x, y: pose(result.frame, id).y }]))

  for (let nowMs = 1_000; nowMs < 5_000; nowMs += 125) {
    if (nowMs > 1_000) result = stepMotion(result.state, { nowMs, size: LARGE })
    assertCollisionFree(result.frame, 1)
    for (const id of [2, 3]) {
      assert.deepEqual({ x: pose(result.frame, id).x, y: pose(result.frame, id).y }, standing.get(id))
    }
  }
})

test('drift is deterministic for 100 seconds, stays near home, respects every visible rectangle, and never asks for more than 8Hz', () => {
  const people = [
    resident(1, 'alice', 1),
    resident(2, 'bob', 1),
    resident(3, 'cy', 1),
  ]
  const city = observation({
    rooms: [room(1, people, [{ id: 10, drawing: null }, { id: 11, drawing: null }])],
  })
  let left = stepMotion(null, { nowMs: 0, observation: city, size: SMALL })
  let right = stepMotion(null, { nowMs: 0, observation: structuredClone(city), size: SMALL })
  const homes = new Map(left.frame.residents.map((entry) => [entry.resident.id, { x: entry.x, y: entry.y }]))
  let changedAfterStart = 0

  for (let nowMs = 125; nowMs <= 100_000; nowMs += 125) {
    left = stepMotion(left.state, { nowMs, size: SMALL })
    right = stepMotion(right.state, { nowMs, size: SMALL })
    assert.deepEqual(left.frame, right.frame, `deterministic frame at ${nowMs}`)
    if (left.changed) changedAfterStart += 1
    if (left.nextAtMs !== null) assert.ok(left.nextAtMs - nowMs >= 125, `next tick at ${nowMs}`)

    const plan = left.frame.plans[0]
    for (const current of left.frame.residents) {
      const home = homes.get(current.resident.id)
      assert.ok(Math.abs(current.x - home.x) <= 2 && Math.abs(current.y - home.y) <= 2)
      for (const thing of plan.things) assert.equal(intersects(current, thing), false)
      assert.equal(intersects(current, plan.aisle), false)
    }
    for (let index = 0; index < left.frame.residents.length; index += 1) {
      for (let other = index + 1; other < left.frame.residents.length; other += 1) {
        assert.equal(intersects(left.frame.residents[index], left.frame.residents[other]), false)
      }
    }
  }
  assert.ok(changedAfterStart >= 20, 'the room visibly drifts over 100 seconds')

  const reread = stepMotion(left.state, { nowMs: 100_001, observation: structuredClone(city), size: SMALL })
  assert.deepEqual(
    reread.frame.residents.map(({ resident: item, x, y }) => [item.id, x, y]),
    left.frame.residents.map(({ resident: item, x, y }) => [item.id, x, y]),
    'unchanged membership and bounds preserve standing positions',
  )
})

test('new visible notes queue one six-second 24-grapheme bubble per room; old and offscreen notes stay silent', () => {
  const alice = resident(1, 'alice', 1)
  const hidden = resident(2, 'hidden', 3)
  const oldNote = note(10, 'alice', 1, 'old words')
  const before = observation({ rooms: [room(1, [alice]), room(2), room(3, [hidden])], notes: [oldNote] })
  const long = '👨‍👩‍👧‍👦 café\nwith\tcontrols and considerably more than twenty-four graphemes'
  const after = observation({
    rooms: [room(1, [alice]), room(2), room(3, [hidden])],
    notes: [oldNote, note(11, 'alice', 1, long), note(12, 'alice', 1, 'second'), note(13, 'hidden', 3, 'offscreen')],
  })
  let result = stepMotion(null, { nowMs: 0, observation: before, size: SMALL })
  assert.equal(result.frame.bubbles.length, 0)

  result = stepMotion(result.state, { nowMs: 60_000, observation: after, size: SMALL })
  assert.equal(result.frame.bubbles.length, 1)
  assert.equal(result.frame.bubbles[0].noteId, 11)
  assert.ok(graphemes(result.frame.bubbles[0].text).length <= 24)
  assert.doesNotMatch(result.frame.bubbles[0].text, /[\x00-\x1f\x7f-\x9f]/u)
  assert.equal(result.frame.bubbles[0].residentId, 1)

  result = stepMotion(result.state, { nowMs: 65_999, size: SMALL })
  assert.equal(result.frame.bubbles[0].noteId, 11)
  result = stepMotion(result.state, { nowMs: 66_000, size: SMALL })
  assert.equal(result.frame.bubbles[0].noteId, 12)
  result = stepMotion(result.state, { nowMs: 71_999, size: SMALL })
  assert.equal(result.frame.bubbles[0].noteId, 12)
  result = stepMotion(result.state, { nowMs: 72_000, size: SMALL })
  assert.equal(result.frame.bubbles.length, 0)
})
