import assert from 'node:assert/strict'
import test from 'node:test'
import { stepActivity } from '../scripts/lib/follow-activity.mjs'
import { bubbleTextWidth } from '../scripts/lib/bubble-text.mjs'

const focus = (placeId = 1, id = 10) => ({ id, handle: id === 10 ? 'alice' : 'bob', placeId })
const room = (id = 1, name = 'sun room', extra = {}) => ({ id, name, quiet: false, residents: [{ id: 10, handle: 'alice' }, { id: 20, handle: 'bob' }], things: [{ id: 30, name: 'blue lantern' }], ...extra })
const observation = ({ events = [], notes = [], focusValue = focus(), roomValue = room() } = {}) => ({ ok: true, focus: focusValue, rooms: [roomValue], residents: roomValue.residents, events, notes })
const event = (id, kind, detail, actor = 'alice') => ({ id, kind, actor, detail })
const note = (id, body, placeId = 1, author = 'alice') => ({ id, body, place_id: placeId, author })
const at = (previous, nowMs, observed, columns = 24, rows = 3, scroll) => stepActivity(previous?.state ?? null, { nowMs, observation: observed, columns, rows, scroll })

test('opening seeds cursors without showing old notes or delayed note events', () => {
  let shown = at(null, 0, observation({ notes: [note(7, 'old room note')] }))
  shown = at(shown, 100, observation({ notes: [note(7, 'old room note')], events: [event(8, 'note', { note_id: 7, place_id: 1 })] }))
  assert.deepEqual(shown.lines, [])
  assert.deepEqual(shown.state.history, [])
  assert.equal(shown.nextAtMs, null)
})

test('fresh notes appear immediately once and retain full safe text', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 100, observation({ notes: [note(1, 'e\u0301猫✨\n next')] }), 12)
  shown = at(shown, 200, observation({ notes: [note(1, 'é猫✨ next')], events: [event(1, 'note', { note_id: 1, place_id: 1 })] }), 12)
  assert.equal(shown.state.history.length, 1)
  assert.equal(shown.state.history[0].text, 'alice: é猫✨ next')
  assert.equal(shown.nextAtMs, null)
})

test('manual scrolling covers lines, pages, and endpoints', () => {
  let shown = at(null, 0, observation(), 30, 2)
  for (let id = 1; id <= 6; id += 1) shown = at(shown, id, observation({ notes: [note(id, `message ${id}`)] }), 30, 2)
  assert.deepEqual(shown.lines, ['alice: message 5', 'alice: message 6'])
  shown = at(shown, 10, undefined, 30, 2, 'up'); assert.deepEqual(shown.lines, ['alice: message 4', 'alice: message 5'])
  shown = at(shown, 11, undefined, 30, 2, 'pageup'); assert.deepEqual(shown.lines, ['alice: message 2', 'alice: message 3'])
  shown = at(shown, 12, undefined, 30, 2, 'home'); assert.deepEqual(shown.lines, ['alice: message 1', 'alice: message 2'])
  shown = at(shown, 13, undefined, 30, 2, 'down'); assert.deepEqual(shown.lines, ['alice: message 2', 'alice: message 3'])
  shown = at(shown, 14, undefined, 30, 2, 'pagedown'); assert.deepEqual(shown.lines, ['alice: message 4', 'alice: message 5'])
  shown = at(shown, 15, undefined, 30, 2, 'end'); assert.deepEqual(shown.lines, ['alice: message 5', 'alice: message 6'])
})

test('new messages preserve an older viewport', () => {
  let shown = at(null, 0, observation(), 30, 2)
  for (let id = 1; id <= 4; id += 1) shown = at(shown, id, observation({ notes: [note(id, `message ${id}`)] }), 30, 2)
  shown = at(shown, 10, undefined, 30, 2, 'home')
  const before = shown.lines
  shown = at(shown, 11, observation({ notes: [note(5, 'message 5')] }), 30, 2)
  assert.deepEqual(shown.lines, before)
  assert.equal(shown.scrollOffset, 3)
})

test('idle, scrolling, and row-only steps reuse cached wrapped line objects', () => {
  let shown = at(null, 0, observation(), 20, 3)
  shown = at(shown, 1, observation({ notes: [note(1, 'one two three four five six')] }), 20, 3)
  const cached = shown.state.wrappedLines
  const firstLine = cached[0]

  shown = at(shown, 2, undefined, 20, 3)
  assert.equal(shown.state.wrappedLines, cached)
  shown = at(shown, 3, undefined, 20, 3, 'up')
  assert.equal(shown.state.wrappedLines, cached)
  shown = at(shown, 4, undefined, 20, 1)
  assert.equal(shown.state.wrappedLines, cached)
  assert.equal(shown.state.wrappedLines[0], firstLine)
})

test('append and width changes invalidate the wrapped-line cache exactly once per step', () => {
  let shown = at(null, 0, observation(), 20, 3)
  shown = at(shown, 1, observation({ notes: [note(1, 'one two three four')] }), 20, 3)
  const original = shown.state.wrappedLines
  const survivingLine = original[0]

  shown = at(shown, 2, observation({ notes: [note(2, 'five six seven eight')] }), 20, 3)
  const appended = shown.state.wrappedLines
  assert.notEqual(appended, original)
  assert.equal(appended[0], survivingLine)
  assert.equal(at(shown, 3, undefined, 20, 3).state.wrappedLines, appended)

  shown = at(shown, 4, undefined, 10, 3)
  assert.notEqual(shown.state.wrappedLines, appended)
  assert.notEqual(shown.state.wrappedLines[0], survivingLine)
  assert.equal(at(shown, 5, undefined, 10, 3).state.wrappedLines, shown.state.wrappedLines)
})

test('append eviction preserves cached line objects for every surviving entry', () => {
  let shown = at(null, 0, observation(), 40, 2)
  for (let id = 1; id <= 200; id += 1) shown = at(shown, id, observation({ notes: [note(id, `message ${id}`)] }), 40, 2)
  const firstEvictedLine = shown.state.wrappedLines.find((line) => line.entryId === 'note-record:1')
  const firstSurvivorLine = shown.state.wrappedLines.find((line) => line.entryId === 'note-record:2')

  shown = at(shown, 201, observation({ notes: [note(201, 'message 201')] }), 40, 2)
  assert.equal(shown.state.wrappedLines.includes(firstEvictedLine), false)
  assert.equal(shown.state.wrappedLines.find((line) => line.entryId === 'note-record:2'), firstSurvivorLine)
})

test('resize keeps the anchored entry visible and history evicts at 200', () => {
  let shown = at(null, 0, observation(), 18, 2)
  for (let id = 1; id <= 201; id += 1) shown = at(shown, id, observation({ notes: [note(id, id === 1 ? 'one two three four five six' : `message ${id}`)] }), 18, 2)
  shown = at(shown, 300, undefined, 18, 2, 'home')
  const resized = at(shown, 301, undefined, 10, 2)
  assert.equal(resized.state.history.length, 200)
  assert.equal(resized.state.history[0].id, 'note-record:2')
  assert.ok(resized.lines.every((line) => line.startsWith('alice:') || line.startsWith('a:')))
})

test('wrapped note continuations carry a compact speaker marker', () => {
  let shown = at(null, 0, observation(), 12, 6)
  shown = at(shown, 1, observation({ notes: [note(1, 'one two three four five six')] }), 12, 6)
  assert.ok(shown.lines.length > 1)
  assert.ok(shown.lines.every((line) => line.startsWith('alice:') || line.startsWith('a:')))
})

test('Unicode note wrapping stays within every narrow width and preserves the complete body', () => {
  for (const columns of [2, 3, 8, 12]) {
    let shown = at(null, 0, observation(), columns, 20)
    shown = at(shown, 1, observation({ notes: [note(1, '猫 élan ✨ done', 1, '猫alice')] }), columns, 20)
    assert.ok(shown.lines.every((line) => bubbleTextWidth(line) <= columns), `width ${columns}`)
    const bodyPieces = shown.lines.map((line) => line.replace(/^(?:猫alice|猫):\s*/u, ''))
    assert.equal(bodyPieces.join('').replace(/\s+/gu, ''), '猫élan✨done')
  }
})

test('resize anchors the source word being read inside a long entry', () => {
  let shown = at(null, 0, observation(), 14, 2)
  shown = at(shown, 1, observation({ notes: [note(1, 'zero one two three four five six seven eight nine ten')] }), 14, 2)
  shown = at(shown, 2, undefined, 14, 2, 'up')
  const anchoredWord = shown.lines.at(0).split(' ').at(-1)
  shown = at(shown, 3, undefined, 9, 3)
  assert.match(shown.lines.join(' '), new RegExp(`\\b${anchoredWord}\\b`, 'u'))
})

test('evicting an oldest anchor keeps the viewport at the nearest surviving old text', () => {
  let shown = at(null, 0, observation(), 40, 2)
  for (let id = 1; id <= 200; id += 1) shown = at(shown, id, observation({ notes: [note(id, `message ${id}`)] }), 40, 2)
  shown = at(shown, 201, undefined, 40, 2, 'home')
  shown = at(shown, 202, observation({ notes: [note(201, 'message 201')] }), 40, 2)
  assert.deepEqual(shown.lines, ['alice: message 2', 'alice: message 3'])
})

test('room moves retain witnessed history but exclude arrival history and off-room activity', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 1, observation({ notes: [note(1, 'witnessed')] }))
  shown = at(shown, 2, observation({ focusValue: focus(2), roomValue: room(2, 'blue room'), notes: [note(2, 'old arrival', 2), note(3, 'fresh arrival', 2)], events: [event(2, 'thing_created', { thing_id: 30, place_id: 1 }), event(3, 'note', { note_id: 3, place_id: 2 })] }))
  assert.deepEqual(shown.state.history.map(({ text }) => text), ['alice: witnessed', 'alice: fresh arrival'])
  assert.deepEqual(shown.state.history.map(({ roomName }) => roomName), ['sun room', 'blue room'])
})

test('quiet and selected-resident changes clear observed history', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 1, observation({ notes: [note(1, 'visible')] }))
  shown = at(shown, 2, observation({ roomValue: room(1, 'sun room', { quiet: true }) }))
  assert.deepEqual(shown.state.history, [])
  shown = at(shown, 3, observation({ focusValue: focus(1, 20) }))
  assert.deepEqual(shown.lines, [])
})

test('quiet reopening does not reveal a snapshot note when its event arrives late', () => {
  let shown = at(null, 0, observation({ roomValue: room(1, 'sun room', { quiet: true }) }))
  shown = at(shown, 1, observation({ notes: [note(7, 'old snapshot note')] }))
  shown = at(shown, 2, observation({ notes: [note(7, 'old snapshot note')], events: [event(1, 'note', { note_id: 7, place_id: 1 })] }))
  assert.deepEqual(shown.state.history, [])
})

test('room-linked failures are described as attempts without claiming success', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 1, observation({ events: [event(1, 'thing_created', { thing_id: 30, place_id: 1 }), event(2, 'action', { action: 'use', status: 'applied', source_thing_id: 30, place_id: 1 }), event(3, 'action', { action: 'use', status: 'refused', source_thing_id: 30, place_id: 1, error: 'no' })] }), 80, 4)
  assert.deepEqual(shown.state.history.map(({ text }) => text), ['alice created blue lantern.', 'alice used blue lantern.', 'alice tried to use blue lantern; refused: no.'])
})

test('all successful public action shapes retain exact labels without carry duplicates', () => {
  let shown = at(null, 0, observation())
  shown = at(shown, 1, observation({ events: [
    event(1, 'thing_created', { thing_id: 30, place_id: 1 }),
    event(2, 'action', { action: 'use', status: 'applied', source_thing_id: 30, place_id: 1 }),
    event(3, 'thing_withdrawn', { thing_id: 30 }),
    event(4, 'action', { action: 'move', status: 'applied', from_place_id: 2, to_place_id: 1 }),
    event(5, 'thing_moved', { mode: 'carry', action_id: 90, thing_id: 30, from_place_id: 2, place_id: 1 }),
    event(6, 'action', { action: 'move', status: 'applied', mode: 'carry', action_id: 90, thing_id: 30, from_place_id: 2, to_place_id: 1 }),
    event(7, 'transfer', { mode: 'gift', asset_type: 'thing', asset_id: 30, resident_id: 20, place_id: 1 }),
    event(8, 'action', { action: 'use', status: 'noop', source_thing_id: 30, place_id: 1 }),
    event(9, 'transfer', { mode: 'effect', type: 'thing', id: 30, resident_id: 20, place_id: 1 }),
    event(10, 'action', { action: 'consume', status: 'applied', source_thing_id: 30, place_id: 1 }),
  ] }), 80, 20)
  assert.deepEqual(shown.state.history.map(({ text }) => text), [
    'alice created blue lantern.', 'alice used blue lantern.', 'alice withdrew blue lantern.',
    'alice moved to sun room.', 'alice carried blue lantern to sun room.',
    'alice gave blue lantern to bob.', 'alice used blue lantern; no change.',
    'alice transferred blue lantern to bob.', 'alice consumed blue lantern.',
  ])
})

test('every wrapped page of a long action identifies its actor and action', () => {
  const longRoom = room(1, 'sun room', { things: [{ id: 30, name: 'carefully polished ceremonial blue lantern' }] })
  let shown = at(null, 0, observation({ roomValue: longRoom }), 20, 2)
  shown = at(shown, 1, observation({ roomValue: longRoom, events: [event(1, 'thing_created', { thing_id: 30, place_id: 1 }, 'thog')] }), 20, 2)
  while (true) {
    assert.ok(shown.lines.every((line) => line.startsWith('thog created:')), shown.lines.join(' | '))
    if (shown.scrollOffset === shown.maxScroll) break
    shown = at(shown, shown.state.nowMs + 1, undefined, 20, 2, 'pageup')
  }
})
