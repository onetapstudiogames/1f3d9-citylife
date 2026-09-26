import assert from 'node:assert/strict'
import test from 'node:test'
import { stepActivity } from '../scripts/lib/follow-activity.mjs'
import { noteSpeechText, REMOVED_NOTE_TEXT } from '../scripts/lib/bubble-text.mjs'

const smokecheck = { id: 261, handle: 'smokecheck', current_place_id: 1117 }
const founder = { id: 1, handle: 'founder', current_place_id: 1117 }
const room = (quiet = false) => ({ id: 1117, name: 'The After Room', residents: [smokecheck, founder], things: [], quiet })
const observation = (events = [], extra = {}, quiet = false) => ({
  ok: true, focus: { id: 261, handle: 'smokecheck', placeId: 1117 }, rooms: [room(quiet)],
  residents: [smokecheck, founder], notes: [], lines: [], events, ...extra,
})
const step = (previous, time, observed) => stepActivity(previous?.state ?? null, { nowMs: time, observation: observed, columns: 80, rows: 8 })
const said = (id, lineId, actor = 'founder', placeId = 1117) => ({ id, kind: 'line_said', actor, detail: { line_id: lineId, place_id: placeId } })
const line = (id, author, body, placeId = 1117) => ({ id, place_id: placeId, author_id: author === 'founder' ? 1 : 261, author, body, body_bytes: body.length, created_at: '2026-09-26T10:00:00.000Z' })
const ping = (id, actor, targetId) => ({ id, kind: 'ping_sent', actor, detail: { ping_id: 40, place_id: 1117, target_type: 'resident', target_id: targetId } })
const answer = (id, actor, targetId, value) => ({ id, kind: 'ping_answered', actor, detail: { ping_id: 40, place_id: 1117, target_type: 'resident', target_id: targetId, answer: value } })

test('a line said in the room shows as handle: line, once', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([said(5, 21)], { lines: [line(21, 'founder', 'hello there')] }))
  assert.deepEqual(shown.state.history.map(entry => entry.text), ['founder: hello there'])
  assert.equal(step(shown, 2, observation()).added.length, 0)
})

test('a ping and its answers use the owner\'s shape', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([
    ping(6, 'smokecheck', 1), answer(7, 'founder', 261, 'yes'),
    answer(8, 'founder', 261, 'no'), answer(9, 'founder', 261, 'in_a_moment'),
  ]))
  assert.deepEqual(shown.state.history.map(entry => entry.text), [
    'smokecheck pinged founder.', 'founder: yes', 'founder: no', 'founder: in a moment',
  ])
})

test('a line with no body, a removed body, another author, or another room never shows', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation(
    [said(5, 21), said(6, 22), said(7, 23, 'smokecheck'), said(8, 24, 'founder', 999)],
    { lines: [line(23, 'founder', 'not mine'), line(24, 'founder', 'elsewhere', 999)] },
  ))
  assert.deepEqual(shown.state.history, [])
})

test('a removed talk row with an empty actor never shows', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([{ id: 5, kind: 'line_said', actor: '', detail: { line_id: 21, moderated: true } }], { lines: [line(21, 'founder', 'x')] }))
  assert.deepEqual(shown.state.history, [])
})

test('a quiet room shows no lines, pings, or answers', () => {
  let shown = step(null, 0, observation([], {}, true))
  shown = step(shown, 1, observation([said(5, 21), ping(6, 'smokecheck', 1), answer(7, 'founder', 261, 'yes')], { lines: [line(21, 'founder', 'hidden')] }, true))
  assert.deepEqual(shown.state.history, [])
})

test('a removed note reads as removed, never as the bracketed placeholder', () => {
  assert.equal(REMOVED_NOTE_TEXT, '(removed by the maintainer)')
  assert.equal(noteSpeechText({ id: 1, body: '[removed by maintainer]', moderated: true }), '(removed by the maintainer)')
  assert.equal(noteSpeechText({ id: 2, walk_to_read: true, first_line: '[removed by maintainer]', moderated: true }), '(removed by the maintainer)')
})

test('a line or ping removed after it was printed leaves the history, and the removal prints nothing', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([said(5, 21), ping(6, 'smokecheck', 1), said(7, 22)], {
    lines: [line(21, 'founder', 'soon removed'), line(22, 'founder', 'stays')],
  }))
  assert.deepEqual(shown.state.history.map(entry => entry.text), ['founder: soon removed', 'smokecheck pinged founder.', 'founder: stays'])
  shown = step(shown, 2, observation([
    { id: 8, kind: 'moderation', actor: 'founder', detail: { action: 'remove', target_type: 'line', target_id: 21 } },
    { id: 9, kind: 'moderation', actor: 'founder', detail: { action: 'remove', target_type: 'ping', target_id: 40 } },
  ]))
  assert.deepEqual(shown.state.history.map(entry => entry.text), ['founder: stays'])
})
