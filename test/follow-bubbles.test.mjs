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
  test(`long note retains its full body and every word is readable at ${size.columns} columns`, () => {
    let result = start(size)
    assert.equal(result.state.activity.queue[0].text, `reader: ${body}`)
    const ending = 120000
    assert.ok(ending > 7000, 'a long note has more than six seconds to read')
    const frames = []
    for (let time = 1000; time < ending; time += 500) {
      result = stepFollowMotion(result.state, { nowMs: time, size })
      const grid = paintLiveView(result.observation, size, result.frame)
      frames.push(toPlainText(grid))
      assert.equal(grid.cells.at(-1).map(cell => cell[0]).join('').trim(), '')
      for (const pose of result.frame.residents) {
        for (let y = pose.y; y < pose.y + pose.height; y++) {
          for (let x = pose.x; x < pose.x + pose.width; x++) assert.notEqual(grid.cells[y][x][2], DARK.bubble)
        }
      }
    }
    assert.match(frames[0], /BEGIN/)
    for (let i = 0; i < 60; i++) assert.match(frames.join('\n'), new RegExp(`word${String(i).padStart(3, '0')}`))
    assert.match(frames.at(-1), /THE END/)
    assert.notEqual(frames[0], frames.at(-1), 'the text actually advances')
  })
}

test('resize preserves the reading log and reflows its full ending', () => {
  let result = start({ columns: 80, rows: 24 })
  result = stepFollowMotion(result.state, { nowMs: 4000, size: { columns: 38, rows: 18 } })
  assert.equal(result.state.activity.queue[0]?.text, `reader: ${body}`)
  const ending = 120000
  result = stepFollowMotion(result.state, { nowMs: ending - 1, size: { columns: 38, rows: 18 } })
  assert.match(toPlainText(paintLiveView(result.observation, { columns: 38, rows: 18 }, result.frame)), /THE END/)
})

test('long notes stay hidden when a room becomes quiet', () => {
  const first = start({ columns: 80, rows: 24 })
  const closed = stepFollowMotion(first.state, { nowMs: 4000, observation: city([note], true), size: { columns: 80, rows: 24 } })
  assert.doesNotMatch(toPlainText(paintLiveView(closed.observation, { columns: 80, rows: 24 }, closed.frame)), /BEGIN|word\d|THE END/)
})
