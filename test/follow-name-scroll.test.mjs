import assert from 'node:assert/strict'
import test from 'node:test'
import { paintLiveView } from '../scripts/lib/live-render.mjs'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'
import { paintPicker } from '../scripts/lib/follow-picker.mjs'
import { Grid, DARK, toPlainText } from '../scripts/lib/grid.mjs'
import { readFile } from 'node:fs/promises'
import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { createReplay } from '../scripts/lib/live-view.mjs'

const size = { columns: 38, rows: 18 }
const placeName = 'the observatory above the orchard where the lanterns sleep'
const observed = {
  ok: true, target: { id: 1, name: placeName }, focus: { id: 7, handle: 'walker', placeId: 1 },
  residents: [], events: [], notes: [],
  rooms: [{ id: 1, name: placeName, residents: [], things: [], drawing: null }],
}
const render = time => {
  const motion = stepFollowMotion(null, { nowMs: time, observation: observed, size })
  return paintLiveView(motion.observation, size, motion.frame)
}

test('place and room name strips reveal their full endings without changing the room border', () => {
  const opening = render(0)
  assert.match(toPlainText(opening), /the observatory/)
  const seen = []
  for (let time = 0; time <= 20000; time += 400) {
    const frame = render(time)
    const lines = toPlainText(frame).split('\n')
    seen.push(lines[0], lines[2])
    assert.deepEqual(frame.cells.slice(3), opening.cells.slice(3))
    assert.equal(frame.cells[2][1][0], '╭')
    assert.equal(frame.cells[2][36][0], '╮')
    assert.equal(frame.nextNameAtMs, time + 400)
  }
  assert.ok(seen.some(line => line.includes('where the lanterns sleep')))
  assert.doesNotMatch(seen.join('\n'), /…/u)
})

test('short names stay still and request no name animation timer', () => {
  const scene = { ...observed, target: { id: 1, name: 'orchard' }, rooms: [{ ...observed.rooms[0], name: 'orchard' }] }
  const frames = [0, 2400, 10000].map(nameTimeMs => paintLiveView(scene, size, { residents: [], nameTimeMs }))
  assert.ok(frames.every(frame => frame.nextNameAtMs === undefined))
  assert.ok(frames.every(frame => toPlainText(frame) === toPlainText(frames[0])))
})

test('resident picker names scroll while selection markers and filter stay in place', () => {
  const handle = 'keeper-of-the-orchard-and-the-quiet-lantern'
  const residents = [{ id: 7, handle }]
  const frames = []
  for (let nowMs = 0; nowMs < 22000; nowMs += 400) {
    const frame = paintPicker(new Grid(38, 18, DARK.bg), { query: '', index: 0 }, residents, handle, nowMs)
    const plain = toPlainText(frame)
    frames.push(plain)
    assert.match(plain, /Filter:/)
    assert.match(plain, /› /)
    assert.equal(frame.nextNameAtMs, nowMs + 400)
  }
  assert.ok(frames.some(frame => frame.includes('the-quiet-lantern')))
  assert.notEqual(frames[0], frames[10])
})

test('long-name scene preserves the public recording and replays identically with direct or paced clocks', async () => {
  const sceneFile = new URL('../docs/archive/evidence/follow-names/follow-names-scene.json', import.meta.url)
  const base = JSON.parse(await readFile(new URL('../docs/archive/evidence/follow-polish/follow-polish-scene.json', import.meta.url), 'utf8'))
  const scene = JSON.parse(await readFile(sceneFile, 'utf8'))
  assert.deepEqual(scene.moments.slice(0, base.moments.length), base.moments)
  const open = () => createLiveSource({ sceneFile, mode: 'follow-room', followHandle: 'thog', fetchImpl: async () => { throw Error('Replay must stay offline.') } })
  const sources = [await open(), await open()]
  try {
    const direct = await createReplay(sources[0], size).at(200000)
    const replay = createReplay(sources[1], size)
    let paced
    const labels = []
    for (const time of scene.frameTimes) {
      paced = await replay.at(time)
      if (time >= 160000) labels.push(toPlainText(paced.frame))
    }
    assert.equal(toPlainText(paced.frame), toPlainText(direct.frame))
    assert.ok(labels.some(frame => frame.includes('very last apple tree')))
    assert.ok(labels.some(frame => frame.includes('moon on its lid')))
    assert.ok(labels.some(frame => frame.includes('quiet-lantern')))
  } finally {
    sources.forEach(source => source.close())
  }
})
