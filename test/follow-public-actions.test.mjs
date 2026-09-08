import assert from 'node:assert/strict'
import test from 'node:test'
import { stepActivity } from '../scripts/lib/follow-activity.mjs'

const resident = { id: 1, handle: 'vesper', current_place_id: 9 }
const room = { id: 9, name: 'orchard', residents: [resident], things: [{ id: 2, name: 'lantern', kind_id: 3 }] }
const observation = (events = [], extra = {}) => ({ ok: true, focus: { id: 1, handle: 'vesper', placeId: 9 }, rooms: [room], residents: [resident], notes: [], events, ...extra })
const event = (id, kind, detail) => ({ id, kind, actor: 'vesper', detail })
const step = (previous, time, observed) => stepActivity(previous?.state ?? null, { nowMs: time, observation: observed, columns: 80, rows: 8 })

test('every room-linked public record has attributed text and a matching cue fact', () => {
  const kinds = ['home_set', 'place_created', 'place_edited', 'place_renamed', 'place_retired', 'place_restored',
    'kind_invented', 'kind_revised', 'trait_coined', 'thing_created', 'thing_crafted', 'thing_edited',
    'thing_upgraded', 'thing_withdrawn', 'laws_changed', 'agreement', 'agreement_accession', 'agreement_sign',
    'transfer_offer', 'sale', 'transfer_cancel', 'world_listed', 'world_sale', 'world_cancel', 'flag', 'moderation', 'gazette_printed']
  for (const kind of kinds) {
    let shown = step(null, 0, observation())
    shown = step(shown, 1, observation([event(1, kind, { place_id: 9, thing_id: 2, kind_id: 3, trait_id: 4, agreement_id: 5, offer_id: 6, issue_number: 8 })]))
    assert.equal(shown.state.history.length, 1, kind)
    assert.match(shown.state.history[0].text, /^vesper /u, kind)
    assert.equal(shown.added.length, 1, kind)
    assert.ok(shown.added[0].cue, kind)
    assert.equal(step(shown, 2, observation()).added.length, 0, `${kind} must not replay`)
  }
})

test('all seven basic actions distinguish completed, no-change and failed attempts', () => {
  for (const action of ['talk', 'move', 'go_home', 'give', 'use', 'consume', 'make']) {
    for (const status of ['applied', 'noop', 'blocked', 'failed']) {
      let shown = step(null, 0, observation())
      shown = step(shown, 1, observation([event(1, 'action', { action, status, place_id: 9, source_thing_id: 2, from_place_id: 9, to_place_id: 10, error: status === 'failed' ? 'the latch stuck' : undefined })]))
      assert.equal(shown.state.history.length, 1, `${action}/${status}`)
      if (status === 'noop') assert.match(shown.state.history[0].text, /no change/u)
      if (['blocked', 'failed'].includes(status)) {
        assert.match(shown.state.history[0].text, /tried/u)
        assert.equal(shown.added[0].cue, 'attempt')
      }
    }
  }
})

test('drawing changes use an actual room resident and scheduled effects need a witnessed link', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([], { contextEvents: [event(1, 'resident_edited', { resident_id: 1 }), event(2, 'resident_edited', { resident_id: 99 }), event(3, 'effect_resolved', { effect_id: 77, status: 'applied' })] }))
  assert.deepEqual(shown.state.history.map(e => e.text), ['vesper changed their drawing.'])
  shown = step(shown, 2, observation([event(4, 'effect_scheduled', { effect_id: 77, place_id: 9 })]))
  shown = step(shown, 3, observation([], { contextEvents: [event(5, 'effect_resolved', { effect_id: 77, status: 'applied' })] }))
  assert.match(shown.state.history.at(-1).text, /vesper.*scheduled effect.*take effect/u)
  assert.equal(shown.added[0].cue, 'effect')
})

test('off-room, unobservable reads and unknown action names never invent room activity', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([], { contextEvents: [
    event(1, 'action', { action: 'read', status: 'applied', place_id: 9 }),
    event(2, 'action', { action: 'fly', status: 'applied', place_id: 9 }),
    event(3, 'thing_edited', { thing_id: 2, place_id: 10 }),
    event(4, 'kind_invented', { kind_id: 8 }),
    event(5, 'effect_resolved', { effect_id: 80, status: 'applied' }),
    event(6, 'action', { action_id: 80, action: 'use', status: 'failed', error: 'blocked by the room' }),
  ] }))
  assert.deepEqual(shown.state.history, [])
})

test('an explicitly moved-away thing cannot leak a later location-free edit into this room', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([], { rooms: [{ ...room, things: [] }], contextEvents: [
    event(1, 'thing_moved', { thing_id: 2, from_place_id: 9, place_id: 10 }),
    event(2, 'thing_edited', { thing_id: 2 }),
  ] }))
  assert.deepEqual(shown.state.history.map(e => e.text), ['vesper moved lantern out of the room.'])
})

test('scheduled effect outcomes retain public causes and require exact effect IDs', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([event(1, 'effect_scheduled', { effect_id: 7, place_id: 9 })]))
  for (const [index, status] of ['skipped', 'failed'].entries()) {
    shown = step(shown, index + 2, observation([], { contextEvents: [event(index + 2, 'effect_resolved', { effect_id: 7, status, error: 'a public refusal' })] }))
    assert.match(shown.state.history.at(-1).text, /a public refusal/u)
    assert.equal(shown.added[0].cue, 'attempt')
  }
})

test('an offer on a known room thing links its cancellation and witnessed notes link flags', () => {
  let shown = step(null, 0, observation([], { notes: [{ id: 4, place_id: 9, author: 'vesper', body: 'old note stays hidden' }] }))
  shown = step(shown, 1, observation([], { contextEvents: [event(1, 'transfer_offer', { offer_id: 7, asset_type: 'thing', asset_id: 2 })] }))
  shown = step(shown, 2, observation([], { contextEvents: [event(2, 'transfer_cancel', { offer_id: 7 }), event(3, 'flag', { target_type: 'note', target_id: 4 })] }))
  assert.equal(shown.state.history.length, 3)
  assert.match(shown.state.history[1].text, /canceled a sale offer/u)
  assert.match(shown.state.history[2].text, /flagged a public record/u)
  assert.doesNotMatch(shown.state.history.map(e => e.text).join(' '), /old note/u)
})

test('wrapped system events preserve the Gazette printer as the actor', () => {
  let shown = stepActivity(null, { nowMs: 0, observation: observation(), columns: 24, rows: 8 })
  shown = stepActivity(shown.state, { nowMs: 1, columns: 24, rows: 8,
    observation: observation([{ ...event(1, 'gazette_printed', { place_id: 9, issue_number: 42 }), actor: 'the Gazette printer' }]) })
  assert.equal(shown.state.history[0].text, 'the Gazette printer printed The Gazette issue 42.')
  assert.ok(shown.lines.every(line => line.startsWith('Gazette p:')))
  assert.doesNotMatch(shown.lines.join('\n'), /the Gazette: printer/u)
})
