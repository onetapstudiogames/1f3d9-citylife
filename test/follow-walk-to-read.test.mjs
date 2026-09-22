import assert from 'node:assert/strict'
import test from 'node:test'
import { stepActivity } from '../scripts/lib/follow-activity.mjs'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'
import { noteSpeechText, WALK_TO_READ_MARKER } from '../scripts/lib/bubble-text.mjs'

// The city's withheld walk-to-read note row (city PR #355, decision 102): the
// window notes collection and GET /api/note/:id send no body, only first_line,
// body_text_bytes, and read_in_person.
const withheld = Object.freeze({
  id: 17942,
  place_id: 1,
  author: 'alice',
  created_at: '2026-09-22T12:00:00.000Z',
  moderated: false,
  walk_to_read: true,
  first_line: 'Field note, east wall',
  body_text_bytes: 412,
  read_in_person: 'This note is walk-to-read: its body is read in person. Stand in place_id 1, then call read_here with note_id 17942, or use GET /api/note/17942/here if your client can open URLs. It is not private: anyone who walks there can read it.',
})
const ordinary = Object.freeze({ id: 17943, place_id: 1, author: 'alice', created_at: '2026-09-22T12:01:00.000Z', moderated: false, body: 'plain words' })

const person = { id: 10, handle: 'alice', current_place_id: 1, drawing: null }
const observation = (notes = []) => ({
  ok: true,
  target: { id: 1, name: 'sun room' },
  focus: { id: 10, handle: 'alice', placeId: 1 },
  residents: [person],
  rooms: [{ id: 1, name: 'sun room', residents: [person], things: [], notes, quiet: false }],
  events: notes.map(note => ({ id: note.id, kind: 'note', actor: note.author, detail: { note_id: note.id, place_id: note.place_id } })),
  notes,
})

test('a withheld walk-to-read note speaks its first line and the fixed in-person marker', () => {
  assert.equal(WALK_TO_READ_MARKER, '(read in person)')
  assert.equal(noteSpeechText(withheld), 'Field note, east wall (read in person)')
  assert.equal(noteSpeechText({ ...withheld, first_line: '' }), '(read in person)')
  assert.equal(noteSpeechText({ ...withheld, first_line: ' \n\t ' }), '(read in person)')
})

test('ordinary, whole, and malformed notes keep their existing text', () => {
  assert.equal(noteSpeechText(ordinary), 'plain words')
  assert.equal(noteSpeechText({ ...withheld, body: 'whole body in a retired place' }), 'whole body in a retired place')
  assert.equal(noteSpeechText({ id: 1, author: 'alice', place_id: 1, first_line: 'no mark' }), '')
  assert.equal(noteSpeechText({ id: 1, author: 'alice', place_id: 1 }), '')
  assert.equal(noteSpeechText(null), '')
})

test('the follow chat history shows a fresh walk-to-read note instead of dropping it', () => {
  let shown = stepActivity(null, { nowMs: 0, observation: observation(), columns: 80, rows: 4 })
  shown = stepActivity(shown.state, { nowMs: 100, observation: observation([withheld, ordinary]), columns: 80, rows: 4 })
  assert.deepEqual(shown.state.history.map(entry => entry.text), [
    'alice: Field note, east wall (read in person)',
    'alice: plain words',
  ])
  assert.doesNotMatch(shown.lines.join('\n'), /read_here|place_id|walk-to-read:/u)
})

test('the follow room bubble shows the first line and marker, never an invented body', () => {
  const size = { columns: 80, rows: 24 }
  const seeded = stepFollowMotion(null, { nowMs: 0, observation: observation(), size })
  const result = stepFollowMotion(seeded.state, { nowMs: 1000, observation: observation([withheld]), size })
  assert.equal(result.state.activity.history[0].text, 'alice: Field note, east wall (read in person)')
  const bubbleTexts = result.state.motion.state.bubbles.map(bubble => bubble.text)
  assert.deepEqual(bubbleTexts, ['Field note, east wall (read in person)'])
})
