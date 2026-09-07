import assert from 'node:assert/strict'
import test from 'node:test'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'
import { toPlainText } from '../scripts/lib/grid.mjs'

const size = { columns: 80, rows: 24 }
const person = (id, handle, placeId) => ({ id, handle, current_place_id: placeId, drawing: null })
const move = (id, from, to) => ({ id, kind: 'action', actor: 'walker', detail: { action: 'move', status: 'applied', from_place_id: from, to_place_id: to } })
const room = (id, extra = {}) => ({
  ok: true, target: { id, name: `room ${id}` }, focus: { id: 999, handle: 'walker', placeId: id },
  residents: [{ id: 999, handle: 'walker' }], events: [], notes: [],
  rooms: [{ id, name: `room ${id}`, focusResidentId: 999, residents: [person(999, 'walker', id)], things: [], thingsCount: 0, drawing: null }],
  ...extra,
})
const at = (previous, nowMs, observation, bounds = size) => stepFollowMotion(previous?.state ?? null, { nowMs, observation, size: bounds })
const text = result => toPlainText(paintLiveView(result.observation, size, result.frame))

test('follow keeps one full-width room and gives the chosen resident a visible place in a crowd', () => {
  const crowded = room(1)
  crowded.rooms[0].residents = [...Array.from({ length: 60 }, (_, i) => person(i + 1, `neighbor-${i}`, 1)), person(999, 'walker', 1)]
  const first = at(null, 0, crowded)
  assert.equal(first.frame.plans.length, 1)
  assert.equal(first.frame.plans[0].box.width, 78)
  assert.ok(first.frame.residents.some(pose => pose.resident.id === 999))
})

test('a recorded selected-resident move leaves one room, changes the camera, and enters the next in two seconds', () => {
  const first = at(null, 0, room(1))
  const changed = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  assert.equal(changed.observation.rooms[0].id, 1)
  assert.deepEqual(changed.frame.doors.map(door => door.roomId), [1])
  const arriving = at(changed, 2000)
  assert.equal(arriving.observation.rooms[0].id, 2)
  assert.deepEqual(arriving.frame.doors.map(door => door.roomId), [2])
  const settled = at(arriving, 3000)
  assert.equal(settled.observation.rooms[0].id, 2)
  assert.equal(settled.frame.plans.length, 1)
  assert.equal(settled.frame.doors.length, 0)
  assert.equal(settled.frame.residents.find(pose => pose.resident.id === 999).roomId, 2)
})

test('a recorded go_home uses the same two door legs and attributed arrival as move', () => {
  const first = at(null, 0, room(1))
  const record = { ...move(1, 1, 2), detail: { ...move(1, 1, 2).detail, action: 'go_home' } }
  const leaving = at(first, 1000, room(2, { events: [record] }))
  assert.deepEqual(leaving.frame.doors.map(door => door.roomId), [1])
  const arriving = at(leaving, 2000)
  assert.deepEqual(arriving.frame.doors.map(door => door.roomId), [2])
  assert.match(arriving.state.activity.history[0].text, /walker went home to room 2/u)
  assert.equal(at(arriving, 3000).frame.doors.length, 0)
})

test('a newly observed room activity gets its cue through the controller and expires', () => {
  let shown = at(null, 0, room(1))
  shown = at(shown, 1000, room(1, { contextEvents: [{ id: 1, actor: 'walker', kind: 'resident_edited', detail: { resident_id: 999 } }] }))
  assert.match(shown.state.activity.history[0].text, /walker changed their drawing/u)
  assert.equal(shown.frame.effects.find(effect => effect.type === 'activity').cue, 'change')
  assert.equal(at(shown, 4000).frame.effects.length, 0)
})

test('a witnessed note still gets a paper mark when its author is no longer pictured', () => {
  const seed = at(null, 0, room(1))
  const shown = at(seed, 1000, room(1, {
    notes: [{ id: 10, author: 'a-departed-neighbor', place_id: 1, body: 'I left a note.' }],
    events: [{ id: 1, actor: 'a-departed-neighbor', kind: 'note', detail: { note_id: 10, place_id: 1 } }],
  }))
  assert.equal(shown.frame.bubbles.length, 0)
  assert.match(shown.state.activity.history[0].text, /a-departed-neighbor: I left a note/u)
  assert.match(text(shown), /≡/u)
})

test('snapshot-only relocation and a broken move chain switch rooms without an invented walk', () => {
  const first = at(null, 0, room(1))
  for (const events of [[], [move(1, 3, 2)]]) {
    const changed = at(first, 1000, room(2, { events }))
    assert.equal(changed.observation.rooms[0].id, 2)
    assert.equal(changed.frame.doors.length, 0)
  }
})

test('old room notes stay hidden on opening and arrival; only a later new note bubbles', () => {
  const note = (id, placeId, body) => ({ id, place_id: placeId, author: 'walker', body })
  const first = at(null, 0, room(1, { notes: [note(1, 1, 'old start')] }))
  assert.equal(first.frame.bubbles.length, 0)
  const changed = at(first, 1000, room(2, { events: [move(1, 1, 2)], notes: [note(2, 2, 'old arrival')] }))
  const settled = at(changed, 3000)
  assert.equal(settled.frame.bubbles.length, 0)
  const talking = at(settled, 4000, room(2, { notes: [note(3, 2, 'hello')] }))
  assert.equal(talking.frame.bubbles[0].text, 'hello')
})

test('room transition frames are identical for direct and paced clocks, and resize settles safely', () => {
  const first = at(null, 0, room(1))
  const changed = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  const direct = at(changed, 2250)
  let paced = changed
  for (let nowMs = 1125; nowMs <= 2250; nowMs += 125) paced = at(paced, nowMs)
  assert.equal(text(paced), text(direct))
  const resized = at(paced, 2375, undefined, { columns: 120, rows: 40 })
  assert.equal(resized.observation.rooms[0].id, 2)
  assert.equal(resized.frame.doors.length, 0)
})

test('changing who is followed cancels an old transition and follows the new resident immediately', () => {
  const first = at(null, 0, room(1))
  const changed = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  const replacement = room(3, { focus: { id: 8, handle: 'someone', placeId: 3 } })
  replacement.rooms[0].residents = [person(8, 'someone', 3)]
  const selected = at(changed, 1500, replacement)
  assert.equal(selected.observation.focus.handle, 'someone')
  assert.equal(selected.observation.rooms[0].id, 3)
  assert.equal(selected.frame.doors.length, 0)
})

test('fresh room use gets a short effect, while opening history and repeated reads stay quiet', () => {
  const use = { id: 1, kind: 'action', actor: 'walker', detail: { action: 'use', status: 'applied', source_thing_id: 5, place_id: 1 } }
  const observed = room(1)
  observed.rooms[0].things = [{ id: 5, drawing: null }]
  const history = at(null, 0, { ...observed, events: [use] })
  assert.deepEqual(history.frame.effects, [])
  const fresh = at(history, 1000, { ...observed, events: [{ ...use, id: 2 }] })
  assert.equal(fresh.frame.effects[0].type, 'glow')
  const expired = at(fresh, 1800, { ...observed, events: [{ ...use, id: 2 }] })
  assert.deepEqual(expired.frame.effects, [])
})

test('an exact carry follows both door legs and finishes on the destination floor', () => {
  const source = room(1)
  source.rooms[0].things = [{ id: 5, drawing: null }]
  const destination = room(2)
  destination.rooms[0].things = [{ id: 5, drawing: null }]
  destination.events = [
    { ...move(1, 1, 2), detail: { ...move(1, 1, 2).detail, mode: 'carry', action_id: 10, thing_id: 5 } },
    { id: 2, kind: 'thing_moved', actor: 'walker', detail: { mode: 'carry', action_id: 10, thing_id: 5, resident_id: 999, from_place_id: 1, place_id: 2 } },
  ]
  const first = at(null, 0, source)
  const departure = at(first, 1000, destination)
  assert.equal(departure.frame.effects[0].type, 'carry')
  assert.equal(departure.frame.effects[0].carrierResidentId, 999)
  const arrival = at(departure, 2250)
  assert.equal(arrival.observation.rooms[0].id, 2)
  assert.equal(arrival.frame.effects[0].type, 'carry')
  let paced = departure
  for (let time = 1125; time <= 2250; time += 125) paced = at(paced, time)
  assert.equal(text(arrival), text(paced))
  assert.deepEqual(at(arrival, 3000).frame.effects, [])
})

test('a late timer finishes a queued room transition without replaying its expired door leg', () => {
  const first = at(null, 0, room(1))
  const departure = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  const pending = at(departure, 1500, room(3, { events: [move(2, 2, 3)] }))
  const late = at(pending, 10000)
  assert.equal(late.observation.rooms[0].id, 3)
  assert.equal(late.frame.doors.length, 0)
  assert.equal(late.state.transition, null)
})

test('rapid successful reads retain all move records needed to reach the latest room', () => {
  const first = at(null, 0, room(1))
  const departure = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  const pending = at(departure, 1500, room(3, { events: [move(2, 2, 3)] }))
  const newest = at(pending, 1600, room(4, { events: [move(3, 3, 4)] }))
  const nextDeparture = at(newest, 3000)
  assert.equal(nextDeparture.observation.rooms[0].id, 2)
  assert.equal(nextDeparture.frame.doors.length, 1)
  assert.equal(at(nextDeparture, 4000).observation.rooms[0].id, 4)
  assert.equal(at(nextDeparture, 5000).state.transition, null)
})

test('new destination use waits for arrival and expires identically with a direct clock', () => {
  const first = at(null, 0, room(1))
  const destination = room(2, { events: [move(1, 1, 2), {
    id: 2, kind: 'action', actor: 'walker', detail: { action: 'use', status: 'applied', place_id: 2, source_thing_id: 5 },
  }] })
  destination.rooms[0].things = [{ id: 5, drawing: null }]
  const departure = at(first, 1000, destination)
  assert.deepEqual(departure.frame.effects, [])
  const arrival = at(departure, 2000)
  assert.equal(arrival.frame.effects[0].type, 'glow')
  assert.equal(arrival.frame.effects[0].startedAtMs, 2000)
  assert.deepEqual(at(departure, 3000).frame.effects, [])
  assert.equal(text(at(departure, 3000)), text(at(arrival, 3000)))
})

test('a fresh recorded note in the move read waits for arrival and keeps its six seconds', () => {
  const first = at(null, 0, room(1))
  const destination = room(2, {
    notes: [
      { id: 2, place_id: 2, author: 'walker', body: 'older room note' },
      { id: 3, place_id: 2, author: 'walker', body: 'just arrived' },
    ],
    events: [move(1, 1, 2), { id: 2, kind: 'note', actor: 'walker', detail: { note_id: 3, place_id: 2 } }],
  })
  const departure = at(first, 1000, destination)
  assert.deepEqual(departure.frame.bubbles, [])
  const arrival = at(departure, 2000)
  assert.equal(arrival.frame.bubbles[0].text, 'just arrived')
  const settled = at(arrival, 3000)
  assert.equal(settled.frame.bubbles[0].text, 'just arrived')
  assert.equal(at(settled, 7999).frame.bubbles.length, 1)
  assert.equal(at(settled, 8000).frame.bubbles.length, 0)
  assert.equal(text(at(departure, 3500)), text(at(settled, 3500)))
})

test('a recorded move enters the activity log only on arrival', () => {
  const first = at(null, 0, room(1))
  const departure = at(first, 1000, room(2, { events: [move(1, 1, 2)] }))
  assert.deepEqual(departure.frame.activity, [])
  const arrival = at(departure, 2000)
  assert.deepEqual(arrival.frame.activity, ['walker moved to room 2.'])
})

test('queued room moves and arrival notes have identical activity with direct or paced clocks', () => {
  const bounds = { columns: 38, rows: 18 }
  const first = at(null, 0, room(1), bounds)
  const departure = at(first, 1000, room(2, { events: [move(1, 1, 2)] }), bounds)
  const pending = at(departure, 1500, room(3, {
    notes: [{ id: 3, place_id: 3, author: 'walker', body: 'A new room and a long warm welcome with a readable ending.' }],
    events: [move(2, 2, 3), { id: 3, kind: 'note', actor: 'walker', detail: { note_id: 3, place_id: 3 } }],
  }), bounds)
  let paced = pending
  for (let time = 1625; time <= 20000; time += 125) {
    paced = at(paced, time, undefined, bounds)
    if (![2000, 3000, 4000, 5000, 10000, 20000].includes(time)) continue
    const direct = at(pending, time, undefined, bounds)
    assert.deepEqual(paced.state.activity, direct.state.activity, `activity at ${time}`)
    assert.equal(toPlainText(paintLiveView(paced.observation, bounds, paced.frame)),
      toPlainText(paintLiveView(direct.observation, bounds, direct.frame)), `picture at ${time}`)
  }
})
