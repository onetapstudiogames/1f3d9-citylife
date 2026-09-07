import assert from 'node:assert/strict'
import test from 'node:test'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'
import { DARK, toPlainText } from '../scripts/lib/grid.mjs'

const person = { id: 1, handle: 'reader', current_place_id: 1, drawing: null }
const city = (notes = [], quiet = false) => ({
  ok: true, target: { id: 1, name: 'reading room' },
  focus: { id: 1, handle: 'reader', placeId: 1 }, residents: [person],
  rooms: [{ id: 1, name: 'reading room', residents: [person], things: [], notes, quiet }],
  events: notes.map(note => ({ id: note.id, kind: 'note', actor: note.author, detail: { note_id: note.id, place_id: note.place_id } })), notes,
})
const body = 'BEGIN ' + Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ') + ' THE END'
const note = { id: 1, author: 'reader', place_id: 1, body }
const start = size => {
  const seeded = stepFollowMotion(null, { nowMs: 0, observation: city(), size })
  return stepFollowMotion(seeded.state, { nowMs: 1000, observation: city([note]), size })
}

for (const size of [{ columns: 80, rows: 24 }, { columns: 38, rows: 18 }]) {
  test(`long note stays still and every word is readable with chat keys at ${size.columns} columns`, () => {
    let result = start(size)
    assert.equal(result.state.activity.history[0].text, `reader: ${body}`)
    const newest = result.frame.activity
    result = stepFollowMotion(result.state, { nowMs: 10000, size })
    assert.deepEqual(result.frame.activity, newest, 'time alone never scrolls the chat')
    assert.match(newest.join(' '), /THE END/)
    result = stepFollowMotion(result.state, { nowMs: 10000, size, scroll: 'home' })
    const frames = []
    for (let index = 0; index < 200; index++) {
      const grid = paintLiveView(result.observation, size, result.frame)
      frames.push(result.frame.activity.join(' '))
      assert.equal(grid.cells.at(-1).map(cell => cell[0]).join('').trim(), '')
      for (const pose of result.frame.residents) {
        for (let y = pose.y; y < pose.y + pose.height; y++) {
          for (let x = pose.x; x < pose.x + pose.width; x++) assert.notEqual(grid.cells[y][x][2], DARK.bubble)
        }
      }
      if (result.frame.activityScroll.offset === 0) break
      result = stepFollowMotion(result.state, { nowMs: 10000 + index * 125, size, scroll: 'down' })
    }
    assert.match(frames[0], /reader.*BEGIN/)
    for (let i = 0; i < 60; i++) assert.match(frames.join(' '), new RegExp(`word${String(i).padStart(3, '0')}`))
    assert.match(frames.at(-1), /THE END/)
    assert.ok(frames.every(frame => frame.includes('reader')), 'the speaker is identifiable on every page')
  })
}

test('resize retains complete history and End reaches its full ending', () => {
  let result = start({ columns: 80, rows: 24 })
  result = stepFollowMotion(result.state, { nowMs: 4000, size: { columns: 80, rows: 24 }, scroll: 'home' })
  result = stepFollowMotion(result.state, { nowMs: 4000, size: { columns: 38, rows: 18 } })
  assert.equal(result.state.activity.history[0]?.text, `reader: ${body}`)
  result = stepFollowMotion(result.state, { nowMs: 4000, size: { columns: 38, rows: 18 }, scroll: 'end' })
  assert.match(result.frame.activity.join(' '), /THE END/)
})

test('long notes stay hidden when a room becomes quiet', () => {
  const first = start({ columns: 80, rows: 24 })
  const closed = stepFollowMotion(first.state, { nowMs: 4000, observation: city([note], true), size: { columns: 80, rows: 24 } })
  assert.doesNotMatch(toPlainText(paintLiveView(closed.observation, { columns: 80, rows: 24 }, closed.frame)), /BEGIN|word\d|THE END/)
})
