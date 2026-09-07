import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { toPlainText } from '../scripts/lib/grid.mjs'
import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { createReplay } from '../scripts/lib/live-view.mjs'

const sceneFile = new URL('../docs/evidence/follow-actions-1.8.1/follow-actions-scene.json', import.meta.url)
const baseFile = new URL('../docs/evidence/follow-names/follow-names-scene.json', import.meta.url)
const size = { columns: 80, rows: 24 }

test('complete action scene preserves its source and uses the documented public event shapes', async () => {
  const [base, scene] = await Promise.all([baseFile, sceneFile].map(async url => JSON.parse(await readFile(url, 'utf8'))))
  assert.deepEqual(scene.moments.slice(0, base.moments.length), base.moments)
  const added = scene.moments.slice(base.moments.length)
  assert.ok(added.every(moment => moment.atMs > 200000))
  assert.ok(added.every(moment => moment.metadata?.provenance === 'hand-authored-extension'
    && moment.metadata?.cityWriteOccurred === false && moment.metadata?.label))

  const changes = added.flatMap(moment => moment.changes ?? [])
  const events = changes.filter(change => change.path?.join('/') === 'events/events').map(change => change.value)
  const schedules = events.filter(event => event.kind === 'effect_scheduled')
  const resolutions = events.filter(event => event.kind === 'effect_resolved')
  assert.deepEqual(Object.keys(schedules[0].detail).sort(), ['effect_id', 'place_id'])
  assert.deepEqual(Object.keys(resolutions[0].detail).sort(), ['effect_id', 'status'])
  assert.deepEqual(Object.keys(resolutions[1].detail).sort(), ['effect_id', 'error', 'status'])
  const failure = events.find(event => event.kind === 'action' && event.detail.status === 'failed')
  assert.deepEqual(Object.keys(failure.detail).sort(), ['action', 'action_id', 'error', 'status'])
  assert.equal(events.find(event => event.detail.effect_id === 700001 && event.kind === 'effect_resolved')?.detail.status, 'applied')
  assert.equal(events.find(event => event.detail.effect_id === 700002 && event.kind === 'effect_resolved')?.detail.status, 'failed')

  const drawingChanges = changes.filter(change => change.path?.[0] === 'drawings' && change.value?.response?.body?.drawing)
  assert.ok(drawingChanges.length >= 3)
  assert.ok(drawingChanges.every(change => change.value.response?.body?.drawing))
  assert.ok(added.some(moment => moment.metadata.label === 'hand-authored portrait changes'))
  const originalPortrait = base.moments[0].raw.drawings.find(item => item.key === 'resident:8').response.body
  const changedPortrait = added[0].changes.find(change => change.path?.[0] === 'drawings').value.response.body
  assert.equal(originalPortrait.drawing, null)
  assert.ok(changedPortrait.drawing?.indices.some(Number.isInteger))
  const firstThingChange = added.find(moment => moment.metadata.label === 'hand-authored undrawn thing appears').changes[0].value[0]
  const editedThingChange = added.find(moment => moment.metadata.label === 'hand-authored existing thing drawing changes')
  assert.equal(firstThingChange.has_drawing, false)
  assert.equal(editedThingChange.changes[0].value[0].has_drawing, true)
  assert.ok(editedThingChange.changes[1].value.response.body.drawing.indices.some(Number.isInteger))
  const crafted = added.find(moment => moment.metadata.label === 'hand-authored newly crafted drawn thing')
  assert.equal(crafted.changes[0].value[0].has_drawing, true)
  assert.ok(crafted.changes[1].value.response.body.drawing.indices.some(Number.isInteger))
  const home = events.find(event => event.detail.action === 'go_home')
  assert.deepEqual(home.detail, { action_id: 800004, action: 'go_home', status: 'applied', from_place_id: 2, to_place_id: 34 })
})

test('complete action scene has deterministic direct and paced final frames with visible cues and history', async () => {
  const scene = JSON.parse(await readFile(sceneFile, 'utf8'))
  const open = () => createLiveSource({
    sceneFile, mode: 'follow-room', followHandle: 'thog',
    fetchImpl: async () => { throw Error('Replay must stay offline.') },
  })
  const [directSource, pacedSource] = await Promise.all([open(), open()])
  try {
    const direct = await createReplay(directSource, size).at(scene.durationMs)
    const pacedReplay = createReplay(pacedSource, size)
    const frames = []
    let paced
    for (const atMs of scene.frameTimes) {
      paced = await pacedReplay.at(atMs)
      if (atMs > 200000) frames.push(toPlainText(paced.frame))
    }
    assert.equal(toPlainText(paced.frame), toPlainText(direct.frame))
    const all = frames.join('\n')
    for (const text of ['changed their drawing', 'crafted', 'changed', 'changed the local laws',
      'set their home', 'used', 'no change', 'scheduled an effect', 'take effect', 'fail']) {
      assert.match(all, new RegExp(text, 'u'))
    }
    for (const cue of ['∆', '✦', '⌂', '§', '⁕', '·', '?']) assert.equal(all.includes(cue), true, `missing ${cue} cue`)
  } finally {
    directSource.close()
    pacedSource.close()
  }
})
