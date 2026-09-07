import assert from 'node:assert/strict'
import test from 'node:test'

import { stepRoomEffects } from '../scripts/lib/follow-effects.mjs'
import { toPlainText } from '../scripts/lib/grid.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'

const resident = (id, handle, roomId = 1) => ({ id, handle, current_place_id: roomId })
const thing = (id, roomId = 1) => ({ id, name: `thing ${id}`, place_id: roomId })
const room = (overrides = {}) => ({
  id: 1, name: 'work room', quiet: false, things: [thing(10)], thingsCount: 1,
  residents: [resident(1, 'alice')], notes: [], ...overrides,
})
const observation = (roomValue = room(), events = []) => ({
  ok: true, target: { id: roomValue.id, name: roomValue.name },
  focus: { id: 1, handle: 'alice', placeId: roomValue.id },
  residents: roomValue.residents, rooms: [roomValue], events, notes: [],
})
const frame = (roomId = 1) => ({
  residents: [{ resident: resident(1, 'alice', roomId), roomId, x: 10, y: 4, width: 8, height: 4, opacity: 1 }],
  plans: [{ roomId, box: { x: 0, y: 1, width: 60, height: 18 }, things: [{ item: thing(10, roomId), x: 25, y: 12, width: 4, height: 2 }], residents: [], overflowDots: [] }],
  bubbles: [], doors: [],
})
const activity = (eventId, cue, overrides = {}) => ({
  id: `event:${eventId}`, eventId, roomId: 1, actor: 'alice', text: 'alice did something.', cue, ...overrides,
})

test('fresh witnessed activity gets one deterministic three-second cue for every cue family', () => {
  const cues = ['change', 'make', 'home', 'agreement', 'trade', 'rules', 'effect', 'wait', 'attempt', 'departure', 'arrival', 'action']
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  result = stepRoomEffects(result.state, {
    nowMs: 100, observation: observation(), motionFrame: frame(),
    activities: cues.map((cue, index) => activity(index + 1, cue, index === 0 ? { thingId: 10 } : {})),
  })

  assert.deepEqual(result.effects.map(({ type, cue }) => [type, cue]), cues.map((cue) => ['activity', cue]))
  assert.equal(result.effects[0].anchor.x, 25, 'a relevant visible thing is preferred')
  assert.equal(result.effects[1].residentId, 1, 'the visible actor is the next anchor')
  assert.equal(result.nextAtMs, 225)

  const repeated = stepRoomEffects(result.state, {
    nowMs: 200, observation: observation(), motionFrame: frame(), activities: [activity(1, 'change')],
  })
  assert.equal(repeated.effects.length, cues.length, 'a repeated activity id does not add another mark')
  assert.deepEqual(stepRoomEffects(repeated.state, { nowMs: 3_100, motionFrame: frame() }).effects, [])
})

test('specialized effects and active walks suppress fallback marks with the same event id', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  const create = { id: 20, kind: 'thing_created', actor: 'alice', detail: { thing_id: 10, place_id: 1 } }
  result = stepRoomEffects(result.state, {
    nowMs: 100, observation: observation(room(), [create]), motionFrame: frame(),
    activities: [activity(20, 'make', { thingId: 10 }), activity(21, 'departure')],
    activeWalks: [{ eventId: 21, actor: 'alice', residentId: 1, fromRoomId: 1, toRoomId: 2, startMs: 100, endMs: 2_000 }],
  })
  assert.deepEqual(result.effects.map(({ id, type }) => [id, type]), [[20, 'puff']])
})

test('a thing outside the displayed five still gets a visible activity mark', () => {
  for (const [kind, detail, cue] of [
    ['thing_created', { thing_id: 99, place_id: 1 }, 'make'],
    ['action', { action: 'use', status: 'applied', source_thing_id: 99, place_id: 1 }, 'action'],
    ['thing_withdrawn', { thing_id: 99, place_id: 1 }, 'change'],
  ]) {
    const seed = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
    const row = { id: 20, kind, detail, actor: 'alice', thing: thing(99) }
    const shown = stepRoomEffects(seed.state, { nowMs: 100, observation: observation(room(), [row]), motionFrame: frame(),
      activities: [activity(20, cue, { thingId: 99 })] })
    assert.deepEqual(shown.effects.map(effect => effect.type), ['activity'])
    const plain = toPlainText(paintLiveView(observation(), { columns: 60, rows: 20 }, { ...frame(), effects: shown.effects }))
    assert.ok(plain.includes({ make: '✦', action: '•', change: '∆' }[cue]), kind)
  }
})

test('fallback marks hide in quiet rooms and drop when their room leaves the picture', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  const closed = room({ quiet: true })
  result = stepRoomEffects(result.state, {
    nowMs: 100, observation: observation(closed), motionFrame: frame(), activities: [activity(30, 'attempt')],
  })
  assert.deepEqual(result.effects, [])

  result = stepRoomEffects(result.state, {
    nowMs: 200, observation: observation(), motionFrame: frame(), activities: [activity(31, 'action')],
  })
  assert.equal(result.effects.length, 1)
  const other = { ...room({ id: 2, name: 'elsewhere', things: [], thingsCount: 0 }), residents: [resident(1, 'alice', 2)] }
  assert.deepEqual(stepRoomEffects(result.state, { nowMs: 300, observation: observation(other), motionFrame: frame(2) }).effects, [])
})

test('activity effects paint a small symbol without explanatory words', () => {
  const current = room()
  const cueEffects = ['change', 'make', 'home', 'agreement', 'trade', 'rules', 'effect', 'wait', 'attempt', 'departure', 'arrival', 'action']
    .map((cue, index) => ({ id: 40 + index, type: 'activity', cue, roomId: 1, residentId: 1, progress: 0.25 }))
  const view = paintLiveView(observation(current), { columns: 60, rows: 20 }, {
    ...frame(), effects: cueEffects,
  })
  const plain = toPlainText(view)
  for (const mark of ['∆', '✦', '⌂', '≈', '↔', '§', '⁕', '·', '?', '‹', '›', '•']) assert.equal(plain.includes(mark), true, mark)
  assert.doesNotMatch(plain, /agreement|activity/iu)
})

test('a delayed activity keeps its first-observed clock and is not revived after expiry', () => {
  let result = stepRoomEffects(null, { nowMs: 0, observation: observation(), motionFrame: frame() })
  result = stepRoomEffects(result.state, {
    nowMs: 2_000, observation: observation(), motionFrame: frame(), activities: [activity(50, 'action', { atMs: 1_000 })],
  })
  assert.equal(result.effects[0].progress, 1 / 3)
  assert.equal(result.effects[0].untilMs, 4_000)

  const expired = stepRoomEffects(result.state, {
    nowMs: 7_000, observation: observation(), motionFrame: frame(), activities: [activity(51, 'action', { atMs: 1_000 })],
  })
  assert.deepEqual(expired.effects, [])
})
