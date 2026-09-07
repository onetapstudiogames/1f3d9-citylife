import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { createReplay, dumpReplay } from '../scripts/lib/live-view.mjs'
import { toPlainText } from '../scripts/lib/grid.mjs'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'

const sceneFile = new URL('./fixtures/live-scene.json', import.meta.url)
const size = { columns: 80, rows: 24 }
const offline = async () => { throw new Error('follow replay attempted the network') }
const openReplay = () => createLiveSource({ sceneFile, followHandle: 'thog', mode: 'follow-room', fetchImpl: offline })

test('follow replay keeps one room and reproduces both recorded move legs', async () => {
  const source = await openReplay()
  try {
    const replay = createReplay(source, size)
    const opening = await replay.at(0)
    const departure = await replay.at(30000)
    const arrival = await replay.at(31000)
    const settled = await replay.at(32000)
    const shown = [opening, departure, arrival, settled]
      .map(result => result.motion?.observation ?? result.observation)

    assert.deepEqual(
      shown.map(observation => observation.rooms.length),
      [1, 1, 1, 1],
    )
    assert.deepEqual(
      shown.map(observation => observation.rooms[0].id),
      [2, 2, 34, 34],
    )
    assert.deepEqual(departure.motion.frame.doors.map(door => door.roomId), [2])
    assert.deepEqual(arrival.motion.frame.doors.map(door => door.roomId), [34])
    assert.equal(settled.motion.frame.doors.length, 0)
  } finally {
    source.close()
  }
})

test('follow replay is identical with direct or paced clocks', async () => {
  const directSource = await openReplay()
  const pacedSource = await openReplay()
  try {
    const direct = await createReplay(directSource, size).at(32000)
    const pacedReplay = createReplay(pacedSource, size)
    let paced
    for (const time of pacedSource.frameTimes.filter(value => value <= 32000)) paced = await pacedReplay.at(time)

    assert.equal(toPlainText(paced.frame), toPlainText(direct.frame))
  } finally {
    directSource.close()
    pacedSource.close()
  }
})

test('follow replay writes byte-identical plain and ANSI dumps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'follow-replay-'))
  const sources = [await openReplay(), await openReplay()]
  try {
    const paths = [join(directory, 'one.txt'), join(directory, 'two.txt')]
    await dumpReplay(sources[0], { ...size, color: '256', dump: paths[0] })
    await dumpReplay(sources[1], { ...size, color: '256', dump: paths[1] })

    assert.deepEqual(await readFile(paths[0]), await readFile(paths[1]))
    assert.deepEqual(await readFile(`${paths[0]}.ansi`), await readFile(`${paths[1]}.ansi`))
  } finally {
    for (const source of sources) source.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('labelled action extensions replay create, use, gift, removal, and both exact carry legs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'follow-actions-'))
  let source
  try {
    const fixture = join(directory, 'scene.json')
    execFileSync(process.execPath, [fileURLToPath(new URL('../docs/evidence/follow/make-action-scene.mjs', import.meta.url)), fixture])
    source = await createLiveSource({ mode: 'follow-room', followHandle: 'thog', sceneFile: fixture, fetchImpl: offline })
    const replay = createReplay(source, size)
    for (const [time, type] of [[70000, 'puff'], [72000, 'glow'], [74000, 'gift'], [76000, 'crumbs'], [78000, 'carry'], [79000, 'carry']]) {
      const frame = await replay.at(time)
      assert.ok(frame.motion.frame.effects.some(effect => effect.type === type), `expected ${type} at ${time}`)
    }
    assert.deepEqual((await replay.at(80000)).motion.frame.effects, [])
  } finally {
    source?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the witnessed chat scene has identical paced and direct pictures and readable scrollback', async () => {
  for (const bounds of [{ columns: 38, rows: 18 }, size]) {
    const options = {
      mode: 'follow-room', followHandle: 'thog', fetchImpl: offline,
      sceneFile: new URL('../docs/evidence/follow-polish/follow-polish-scene.json', import.meta.url),
    }
    const sources = [await createLiveSource(options), await createLiveSource(options)]
    try {
      const paced = createReplay(sources[0], bounds)
      const direct = createReplay(sources[1], bounds)
      const rendered = []
      for (const time of sources[0].frameTimes) {
        const result = await paced.at(time)
        rendered.push(toPlainText(result.frame))
        if ([62000, 79000, 84000, 92000, 150000].includes(time)) {
          assert.equal(toPlainText(result.frame), toPlainText((await direct.at(time)).frame), `${bounds.columns} columns at ${time}`)
        }
      }
      let shown = (await paced.at(150000)).motion
      const history = []
      shown = stepFollowMotion(shown.state, { nowMs: 150000, size: bounds, scroll: 'home' })
      for (let index = 0; index < 200; index++) {
        history.push(shown.frame.activity.join(' '))
        if (shown.frame.activityScroll.offset === 0) break
        shown = stepFollowMotion(shown.state, { nowMs: 150000, size: bounds, scroll: 'down' })
      }
      assert.match(history.join(' '), /THE LANTERN IS(?: thog:)? HOME/)
      assert.match(history.join(' '), /first town fair/, 'witnessed prior-room activity remains in scrollback')
      assert.match(history.join(' '), /created|used|carried/)
    } finally {
      sources.forEach(source => source.close())
    }
  }
})
