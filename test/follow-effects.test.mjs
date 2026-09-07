import assert from 'node:assert/strict'
import test from 'node:test'

import { stepRoomEffects } from '../scripts/lib/follow-effects.mjs'

const drawing = { palette: ['#ffcc00'], indices: Array(64).fill(0) }
const thing = (id, roomId = 1) => ({ id, name: `thing ${id}`, place_id: roomId, drawing })
const resident = (id, handle, roomId = 1) => ({ id, handle, current_place_id: roomId })
const room = (things = [thing(10)], residents = [resident(1, 'alice'), resident(2, 'bob')]) => ({
  id: 1,
  name: 'work room',
  things,
  thingsCount: things.length,
  residents,
})
const observation = (events = [], roomValue = room()) => ({
  ok: true,
  target: { id: 1, name: 'work room' },
  focus: { id: 1, handle: 'alice', placeId: 1 },
  residents: roomValue.residents,
  rooms: [roomValue],
  events,
  notes: [],
})
const frame = (things = [thing(10)]) => ({
  residents: [
    { resident: resident(1, 'alice'), roomId: 1, x: 10, y: 4, width: 8, height: 4, opacity: 1 },
    { resident: resident(2, 'bob'), roomId: 1, x: 42, y: 4, width: 8, height: 4, opacity: 1 },
  ],
  plans: [{
    roomId: 1,
    things: things.map((item, index) => ({ item, x: 25 + (index * 5), y: 16, width: 4, height: 2 })),
  }],
})
const event = (id, kind, detail, actor = 'alice') => ({ id, kind, actor, detail })

test('room effects seed old history, then show only typed create, use, and removal records', () => {
  const oldCreate = event(1, 'thing_created', { thing_id: 10, place_id: 1, name: 'old' })
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation([oldCreate]), motionFrame: frame() })
  assert.deepEqual(result.effects, [])

  const made = thing(20)
  const create = event(2, 'thing_created', { thing_id: 20, place_id: 1, name: 'new' })
  result = stepRoomEffects(result.state, {
    nowMs: 30_000,
    observation: observation([oldCreate, create], room([thing(10), made])),
    motionFrame: frame([thing(10), made]),
  })
  assert.deepEqual(result.effects.map(({ type, thingId, roomId }) => [type, thingId, roomId]), [['puff', 20, 1]])

  result = stepRoomEffects(result.state, {
    nowMs: 31_000,
    observation: observation([...Array(2)].map((_, index) => index === 0 ? oldCreate : create).concat([
      event(3, 'action', { action: 'use', status: 'noop', source_thing_id: 10, place_id: 1 }),
      event(4, 'action', { action: 'use', status: 'failed', source_thing_id: 20, place_id: 1 }),
    ]), room([thing(10), made])),
    motionFrame: frame([thing(10), made]),
  })
  assert.deepEqual(result.effects.map(({ type, thingId }) => [type, thingId]), [['glow', 10]])

  result = stepRoomEffects(result.state, {
    nowMs: 32_000,
    observation: observation([oldCreate, create,
      event(3, 'action', { action: 'use', status: 'noop', source_thing_id: 10, place_id: 1 }),
      event(4, 'action', { action: 'use', status: 'failed', source_thing_id: 20, place_id: 1 }),
      event(5, 'thing_withdrawn', { thing_id: 10 }),
      event(6, 'action', { action: 'consume', status: 'noop', source_thing_id: 20, place_id: 1 }),
      event(7, 'action', { action: 'consume', status: 'applied', source_thing_id: 20 }),
    ], room([made])),
    motionFrame: frame([made]),
  })
  assert.deepEqual(result.effects.map(({ type, thingId }) => [type, thingId]), [['crumbs', 10]])
  assert.deepEqual(result.effects[0].anchor, { x: 25, y: 16, width: 4, height: 2 })
  assert.equal(result.effects[0].thing.drawing.palette[0], '#ffcc00')
})

test('gift and effect transfers float only between two visible, still, recorded partners', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  const rows = [
    event(10, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 10, resident_id: 2, place_id: 1 }),
    event(11, 'transfer', { mode: 'effect', type: 'thing', id: 10, resident_id: 2, place_id: 1 }),
    event(12, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 10, resident_id: 99, place_id: 1 }),
  ]
  result = stepRoomEffects(result.state, { nowMs: 100, observation: observation(rows), motionFrame: frame() })
  assert.deepEqual(result.effects.map(({ type, fromResidentId, toResidentId }) => [type, fromResidentId, toResidentId]), [
    ['gift', 1, 2],
    ['transfer', 1, 2],
  ])
  const animated = stepRoomEffects(result.state, { nowMs: 225, motionFrame: frame() })
  assert.equal(animated.effects.length, 2, 'timer frames retain the last public room membership')

  const moving = [{ actor: 'alice', residentId: 1, fromRoomId: 1, toRoomId: 2, startMs: 100, endMs: 2_100 }]
  const next = stepRoomEffects(result.state, {
    nowMs: 200,
    observation: observation([...rows, event(13, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 10, resident_id: 2, place_id: 1 })]),
    motionFrame: frame(),
    activeWalks: moving,
  })
  assert.equal(next.effects.some(({ type }) => type === 'gift' || type === 'transfer'), false, 'a moving partner cancels an active float')
})

test('carry attaches only when both exact carry rows match the active recorded walk', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  const action = event(20, 'action', {
    action: 'move', status: 'applied', mode: 'carry', thing_id: 10, action_id: 700, from_place_id: 1, to_place_id: 2,
  })
  const notice = event(21, 'thing_moved', {
    mode: 'carry', thing_id: 10, action_id: 700, resident_id: 1, from_place_id: 1, place_id: 2,
  })
  const activeWalks = [{
    eventId: 20, actor: 'alice', residentId: 1, fromRoomId: 1, toRoomId: 2,
    startMs: 100, endMs: 2_100, actionId: 700, thingId: 10,
  }]
  result = stepRoomEffects(result.state, {
    nowMs: 100,
    observation: observation([action, notice], room([])),
    motionFrame: frame([]),
    activeWalks,
  })
  assert.deepEqual(result.effects.map(({ type, thingId, carrierResidentId }) => [type, thingId, carrierResidentId]), [['carry', 10, 1]])
  assert.equal(result.effects[0].roomId, 1)

  let mismatch = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  mismatch = stepRoomEffects(mismatch.state, {
    nowMs: 100,
    observation: observation([action, { ...notice, id: 22, detail: { ...notice.detail, action_id: 701 } }], room([])),
    motionFrame: frame([]),
    activeWalks,
  })
  assert.equal(mismatch.effects.some(({ type }) => type === 'carry'), false)
})

test('destination effects wait for arrival and direct clocks match paced expiry progress', () => {
  const sourceRoom = room([], [resident(1, 'alice')])
  const destinationRoom = { ...room([], [resident(1, 'alice', 2)]), id: 2, name: 'room 2' }
  const destinationFrame = {
    residents: [{ resident: resident(1, 'alice', 2), roomId: 2, x: 10, y: 4, width: 8, height: 4, opacity: 1 }],
    plans: [{ roomId: 2, things: [{ item: thing(30, 2), x: 25, y: 16, width: 4, height: 2 }] }],
  }
  const use = event(30, 'action', { action: 'use', status: 'applied', source_thing_id: 30, place_id: 2 })
  let seeded = stepRoomEffects(null, { nowMs: 0, observation: observation([], sourceRoom), motionFrame: frame([]) })
  const departed = stepRoomEffects(seeded.state, {
    nowMs: 100,
    observation: observation([use], sourceRoom),
    motionFrame: frame([]),
    deferUntil: { roomId: 2, atMs: 1_100 },
  })
  assert.deepEqual(departed.effects, [])
  assert.equal(departed.state.cursor, 30)
  assert.equal(departed.state.deferred.length, 1)

  const arrivedObservation = { ...observation([use], destinationRoom), target: { id: 2, name: 'room 2' }, focus: { id: 1, handle: 'alice', placeId: 2 } }
  const direct = stepRoomEffects(departed.state, { nowMs: 1_500, observation: arrivedObservation, motionFrame: destinationFrame })
  const arrival = stepRoomEffects(departed.state, { nowMs: 1_100, observation: arrivedObservation, motionFrame: destinationFrame })
  const paced = stepRoomEffects(arrival.state, { nowMs: 1_500, observation: arrivedObservation, motionFrame: destinationFrame })
  assert.deepEqual(direct.effects, paced.effects)
  assert.equal(direct.effects[0].type, 'glow')
  assert.equal(direct.effects[0].progress, 0.5)
  assert.deepEqual(stepRoomEffects(departed.state, {
    nowMs: 2_000, observation: arrivedObservation, motionFrame: destinationFrame,
  }).effects, [], 'a direct clock past the recorded expiry does not revive the cue')
})

test('carry stops as soon as the current walk no longer matches its exact recorded move', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  const action = event(40, 'action', {
    action: 'move', status: 'applied', mode: 'carry', thing_id: 10, action_id: 800, from_place_id: 1, to_place_id: 2,
  })
  const notice = event(41, 'thing_moved', {
    mode: 'carry', thing_id: 10, action_id: 800, resident_id: 1, from_place_id: 1, place_id: 2,
  })
  const matching = [{
    eventId: 40, actor: 'alice', residentId: 1, fromRoomId: 1, toRoomId: 2,
    startMs: 100, endMs: 2_100, actionId: 800, thingId: 10,
  }]
  result = stepRoomEffects(result.state, {
    nowMs: 100, observation: observation([action, notice]), motionFrame: frame(), activeWalks: matching,
  })
  assert.equal(result.effects[0].type, 'carry')

  const ordinaryArrival = [{ ...matching[0], eventId: 42, actionId: null, thingId: null, fromRoomId: 2, toRoomId: 3 }]
  result = stepRoomEffects(result.state, {
    nowMs: 200, observation: observation([action, notice]), motionFrame: frame(), activeWalks: ordinaryArrival,
  })
  assert.equal(result.effects.some(({ type }) => type === 'carry'), false)
})

test('an exact event-only thing drawing can animate without inventing a floor copy', () => {
  const empty = room([], [resident(1, 'alice'), resident(2, 'bob')])
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation([], empty), motionFrame: frame([]) })
  const gift = {
    ...event(50, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 99, resident_id: 2, place_id: 1 }),
    thing: { id: 99, name: 'event parcel', drawing },
  }
  result = stepRoomEffects(result.state, {
    nowMs: 100, observation: observation([gift], empty), motionFrame: frame([]),
  })
  assert.equal(result.effects[0].type, 'gift')
  assert.equal(result.effects[0].thing.id, 99)
  assert.equal(result.effects[0].thing.drawing.palette[0], '#ffcc00')
  assert.equal(result.state.placements.some(({ thingId }) => thingId === 99), false)
})
