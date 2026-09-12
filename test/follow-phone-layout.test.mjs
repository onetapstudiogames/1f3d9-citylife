import assert from 'node:assert/strict'
import test from 'node:test'

import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { createReplay } from '../scripts/lib/live-view.mjs'

const offline = async () => { throw new Error('phone layout replay attempted the network') }

test('the recorded phone view leaves the focused portrait one row for its name', async () => {
  const source = await createLiveSource({
    sceneFile: new URL('../docs/archive/evidence/follow-polish/follow-polish-scene.json', import.meta.url),
    followHandle: 'thog',
    mode: 'follow-room',
    fetchImpl: offline,
  })
  try {
    const result = await createReplay(source, { columns: 38, rows: 18 }).at(120000)
    const plan = result.motion.frame.plans[0]
    const thog = result.motion.frame.residents.find(({ resident }) => resident.handle === 'thog')
    const helena = result.motion.frame.residents.find(({ resident }) => resident.handle === 'helena')
    const row = (y) => result.frame.cells[y].map(([character]) => character).join('')

    assert.deepEqual({ width: thog.width, height: thog.height }, { width: 8, height: 4 })
    assert.equal(plan.aisle.height, 4)
    assert.match(row(thog.y + thog.height), /thog/)
    assert.ok(thog.y + thog.height < plan.box.y + plan.box.height - 1, 'the name stays above the bottom wall')
    if (helena) assert.match(row(helena.y - 1), /zzZ/)
    assert.ok(plan.things.every((thing) => thing.y + thing.height <= plan.aisle.y))
  } finally {
    source.close()
  }
})
