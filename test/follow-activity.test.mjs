import assert from 'node:assert/strict'
import test from 'node:test'

import { stepActivity } from '../scripts/lib/follow-activity.mjs'

const focus = (placeId = 1, id = 10, handle = 'alice') => ({ id, handle, placeId })
const room = (id = 1, name = 'sun room', extra = {}) => ({
  id, name, quiet: false,
  residents: [{ id: 10, handle: 'alice' }, { id: 20, handle: 'bob' }],
  things: [{ id: 30, name: 'blue lantern' }],
  ...extra,
})
const observation = ({ events = [], notes = [], focusValue = focus(), roomValue = room() } = {}) => ({
  ok: true,
  target: { id: roomValue.id, name: roomValue.name },
  focus: focusValue,
  rooms: [roomValue],
  residents: roomValue.residents,
  events,
  notes,
})
const event = (id, kind, detail, actor = 'alice') => ({ id, kind, actor, detail })
const note = (id, body, placeId = 1, author = 'alice') => ({ id, body, place_id: placeId, author })
const at = (previous, nowMs, observed, columns = 24, rows = 3) => stepActivity(previous?.state ?? null, {
  nowMs, observation: observed, columns, rows,
})

test('opening history and old events seed cursors without appearing', () => {
  const opened = at(null, 0, observation({
    notes: [note(7, 'old room note')],
    events: [event(8, 'note', { note_id: 7, place_id: 1 })],
  }))
  assert.deepEqual(opened.lines, [])
  assert.equal(opened.nextAtMs, null)

  const repeated = at(opened, 1_000, observation({
    notes: [note(7, 'old room note')],
    events: [event(8, 'note', { note_id: 7, place_id: 1 })],
  }))
  assert.deepEqual(repeated.lines, [])
})

test('opening and quiet-reopening history stays hidden when its note event arrives late', () => {
  for (const reopen of [false, true]) {
    const quiet = reopen ? at(null, 0, observation({ roomValue: room(1, 'sun room', { quiet: true }) })) : null
    const baseline = at(quiet, 100, observation({ notes: [note(7, 'old snapshot note')] }))
    const delayed = at(baseline, 200, observation({
      notes: [note(7, 'old snapshot note')],
      events: [event(1, 'note', { note_id: 7, place_id: 1 })],
    }))
    assert.deepEqual(delayed.state.queue, [], `history stays hidden after ${reopen ? 'quiet' : 'opening'}`)
  }
})

test('a higher same-room note ID is fresh without an event, while an event-backed copy appears once', () => {
  let shown = at(null, 0, observation({ notes: [note(7, 'opening history')] }))
  shown = at(shown, 100, observation({ notes: [note(8, 'note-only delivery')] }))
  assert.deepEqual(shown.state.queue.map(({ text }) => text), ['alice: note-only delivery'])

  shown = at(shown, 200, observation({
    notes: [note(9, 'event and note agree')],
    events: [event(20, 'note', { note_id: 9, place_id: 1 })],
  }))
  assert.deepEqual(shown.state.queue.map(({ text }) => text), [
    'alice: note-only delivery',
    'alice: event and note agree',
  ])
})

test('a note-only delivery is not repeated when its matching event arrives on the next poll', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 100, observation({ notes: [note(2, 'delayed event')] }))
  assert.deepEqual(shown.state.queue.map(({ id }) => id), ['note-record:2'])

  shown = at(shown, 200, observation({
    notes: [note(2, 'delayed event')],
    events: [event(1, 'note', { note_id: 2, place_id: 1 })],
  }))
  assert.deepEqual(shown.state.queue.map(({ id }) => id), ['note-record:2'])
})

test('a long fresh note scrolls at reading pace and its ending stays reachable', () => {
  const baseline = at(null, 0, observation())
  const body = `first line ${'carefully preserved words '.repeat(8)}THE END`
  const fresh = observation({
    notes: [note(40, body)],
    events: [event(11, 'note', { note_id: 40, place_id: 1 })],
  })
  let shown = at(baseline, 100, fresh, 20)
  assert.deepEqual(shown.lines, ['alice: first line'])
  assert.equal(shown.nextAtMs, 3_100)

  shown = at(shown, 3_100, fresh, 20)
  assert.equal(shown.lines.length, 2)
  assert.ok(shown.nextAtMs >= 5_600)

  let now = 3_100
  while (shown.nextAtMs !== null && now < 120_000) {
    now = shown.nextAtMs
    shown = at(shown, now, fresh, 20)
  }
  assert.match(shown.lines.join(' '), /THE END$/u)
  assert.ok(shown.state.completed.at(-1).text.endsWith('THE END'))
})

test('new messages queue behind the current message without dropping its ending', () => {
  let shown = at(null, 0, observation())
  const firstBody = `${'long words '.repeat(10)}FIRST END`
  shown = at(shown, 100, observation({ notes: [note(1, firstBody)], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }), 18)
  shown = at(shown, 500, observation({
    notes: [note(1, firstBody), note(2, 'second message')],
    events: [event(1, 'note', { note_id: 1, place_id: 1 }), event(2, 'note', { note_id: 2, place_id: 1 })],
  }), 18)

  let sawFirstEnd = false
  let sawSecond = false
  for (let count = 0; shown.nextAtMs !== null && count < 100; count += 1) {
    shown = at(shown, shown.nextAtMs, undefined, 18)
    sawFirstEnd ||= shown.lines.join(' ').includes('FIRST END')
    sawSecond ||= shown.lines.join(' ').includes('second message')
  }
  assert.equal(sawFirstEnd, true)
  assert.equal(sawSecond, true)
})

test('idle history retains the latest three wrapped lines and at most twenty complete entries', () => {
  let shown = at(null, 0, observation())
  for (let id = 1; id <= 22; id += 1) {
    shown = at(shown, id * 10, observation({
      notes: [note(id, `message ${id}`)],
      events: [event(id, 'note', { note_id: id, place_id: 1 })],
    }), 30)
  }
  for (let count = 0; shown.nextAtMs !== null && count < 100; count += 1) shown = at(shown, shown.nextAtMs, undefined, 30)
  assert.equal(shown.state.completed.length, 20)
  assert.deepEqual(shown.lines, ['alice: message 20', 'alice: message 21', 'alice: message 22'])
})

test('known successful public records produce exact short labels and duplicates or failures do not', () => {
  let shown = at(null, 0, observation())
  const rows = [
    event(1, 'thing_created', { thing_id: 30, place_id: 1 }),
    event(2, 'action', { action: 'use', status: 'applied', source_thing_id: 30, place_id: 1 }),
    event(3, 'thing_withdrawn', { thing_id: 30 }),
    event(4, 'action', { action: 'move', status: 'applied', from_place_id: 2, to_place_id: 1 }),
    event(5, 'thing_moved', { mode: 'carry', action_id: 90, thing_id: 30, from_place_id: 2, place_id: 1 }),
    event(6, 'action', { action: 'move', status: 'applied', mode: 'carry', action_id: 90, thing_id: 30, from_place_id: 2, to_place_id: 1 }),
    event(7, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 30, resident_id: 20, place_id: 1 }),
    event(8, 'action', { action: 'use', status: 'noop', source_thing_id: 30, place_id: 1 }),
    event(9, 'transfer', { mode: 'effect', type: 'thing', id: 30, resident_id: 20, place_id: 1 }),
    event(10, 'action', { action: 'move', status: 'applied', mode: 'carry', action_id: 91, thing_id: 30, from_place_id: 2, to_place_id: 1 }),
    event(11, 'action', { action: 'use', status: 'refused', source_thing_id: 30, place_id: 1, error: 'no' }),
    event(12, 'mystery', { body: 'do not leak me', secret: 'hidden' }),
  ]
  shown = at(shown, 100, observation({ events: rows }), 80)
  assert.deepEqual(shown.state.queue.map(({ text }) => text), [
    'alice created blue lantern.',
    'alice used blue lantern.',
    'alice withdrew blue lantern.',
    'alice moved to sun room.',
    'alice carried blue lantern to sun room.',
    'alice gave blue lantern to bob.',
    'alice used blue lantern.',
    'alice transferred blue lantern to bob.',
    'alice moved to sun room.',
  ])
})

test('note records emit once, require matching event IDs, and preserve safe Unicode at narrow widths', () => {
  let shown = at(null, 0, observation({ notes: [note(1, 'unproven snapshot')] }), 2)
  shown = at(shown, 100, observation({
    notes: [note(1, 'unproven snapshot'), note(2, 'e\u0301猫✨\n next')],
    events: [event(1, 'note', { note_id: 2, place_id: 1 })],
  }), 2)
  assert.equal(shown.state.queue.length, 1)
  assert.equal(shown.state.queue[0].text, 'alice: é猫✨ next')
  const repeated = at(shown, 200, observation({ notes: [note(2, 'é猫✨ next')], events: [event(1, 'note', { note_id: 2, place_id: 1 })] }), 2)
  assert.equal(repeated.state.queue.length, 1)
})

test('quiet rooms clear immediately and never replay text missed while quiet', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 100, observation({ notes: [note(1, 'visible')], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }))
  const quietRoom = room(1, 'sun room', { quiet: true, residents: [], things: [] })
  shown = at(shown, 200, observation({ roomValue: quietRoom, notes: [], events: [] }))
  assert.deepEqual(shown.lines, [])
  assert.deepEqual(shown.state.queue, [])
  assert.deepEqual(shown.state.completed, [])

  const reopened = at(shown, 300, observation({ notes: [note(2, 'missed quiet text')], events: [event(2, 'note', { note_id: 2, place_id: 1 })] }))
  assert.deepEqual(reopened.lines, [])
})

test('room or selected-resident changes clear prior log but keep an event-proven fresh arrival note', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 100, observation({ notes: [note(1, 'old room')], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }))
  const destination = room(2, 'blue room')
  shown = at(shown, 200, observation({
    focusValue: focus(2), roomValue: destination,
    notes: [note(2, 'old arrival', 2), note(3, 'fresh arrival', 2)],
    events: [event(2, 'action', { action: 'move', status: 'applied', from_place_id: 1, to_place_id: 2 }), event(3, 'note', { note_id: 3, place_id: 2 })],
  }))
  assert.equal(shown.state.queue.some(({ text }) => text.includes('old room') || text.includes('old arrival')), false)
  assert.equal(shown.state.queue.some(({ text }) => text === 'alice: fresh arrival'), true)

  const switched = at(shown, 300, observation({ focusValue: focus(2, 20, 'bob'), roomValue: destination }))
  assert.deepEqual(switched.lines, [])
})

test('resizing reflows preserved full text and restarts the current entry deterministically', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 100, observation({ notes: [note(1, 'one two three four five six')], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }), 10)
  shown = at(shown, 3_100, undefined, 10)
  const resized = at(shown, 3_200, undefined, 24)
  assert.deepEqual(resized.lines, ['alice: one two three'])
  assert.equal(resized.state.queue[0].text, 'alice: one two three four five six')
  assert.equal(resized.nextAtMs, 6_200)
})

test('a zero-row viewport pauses unread text until every line can be read after resize', () => {
  let shown = at(null, 0, observation(), 30, 0)
  const body = `${'preserved words '.repeat(8)}ZERO ROW END`
  shown = at(shown, 100, observation({ notes: [note(1, body)], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }), 18, 0)
  assert.deepEqual(shown.lines, [])
  assert.equal(shown.nextAtMs, null)
  shown = at(shown, 60_000, undefined, 18, 0)
  assert.deepEqual(shown.lines, [])
  assert.equal(shown.state.completed.length, 0)

  shown = at(shown, 60_100, undefined, 18, 1)
  assert.deepEqual(shown.lines, ['alice: preserved'])
  assert.equal(shown.nextAtMs, 63_100)

  let sawEnding = false
  for (let count = 0; shown.nextAtMs !== null && count < 100; count += 1) {
    shown = at(shown, shown.nextAtMs, undefined, 18, 1)
    sawEnding ||= shown.lines.join(' ').includes('ZERO ROW END')
  }
  assert.equal(sawEnding, true)
  assert.ok(shown.state.completed.at(-1).text.endsWith('ZERO ROW END'))
})
