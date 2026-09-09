import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { createLiveSource, normalizeLookingPresence } from '../scripts/lib/live-source.mjs'
import { stepFollowMotion } from '../scripts/lib/follow-motion.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'
import { toPlainText } from '../scripts/lib/grid.mjs'
import { createReplay } from '../scripts/lib/live-view.mjs'

const size = { columns: 80, rows: 24 }
const stamp = ms => new Date(1_800_000_000_000 + ms).toISOString()
const rawLooking = (start, end, placeId = 1) => ({ place_id: placeId, started_at: stamp(start), expires_at: stamp(end) })
const looking = (start, end, placeId = 1) => ({ ...rawLooking(start, end, placeId), startedAtMs: start, expiresAtMs: end })
const resident = (id, handle, signal = null, asleep = false) => ({
  id, handle, current_place_id: 1, looking: signal, asleep, drawing: null,
})
const observation = (people, extra = {}) => ({
  ok: true, target: { id: 1, name: 'room one' }, focus: { id: 1, handle: 'alice', placeId: 1 },
  residents: people.map(({ id, handle }) => ({ id, handle })), events: [], notes: [],
  rooms: [{ id: 1, name: 'room one', focusResidentId: 1, residents: people, things: [], thingsCount: 0, drawing: null }],
  ...extra,
})
const step = (previous, nowMs, people) => stepFollowMotion(previous?.state ?? null, {
  nowMs, size, observation: people ? observation(people) : undefined,
})

test('looking presence accepts only current, bounded signals and maps ISO time to the replay clock', () => {
  const clock = { nowMs: 7_000, observedAtEpochMs: 1_800_000_010_000 }
  assert.deepEqual(normalizeLookingPresence(rawLooking(5_000, 65_000), 1, clock), {
    place_id: 1, started_at: stamp(5_000), expires_at: stamp(65_000),
    startedAtMs: 2_000, expiresAtMs: 62_000,
  })
  for (const malformed of [
    null, {}, rawLooking(5_000, 70_001), rawLooking(5_000, 9_000),
    rawLooking(5_000, 65_000, 2), { ...rawLooking(5_000, 65_000), expires_at: 'soon' },
  ]) assert.equal(normalizeLookingPresence(malformed, 1, clock), null)

  assert.deepEqual(normalizeLookingPresence(rawLooking(11_000, 72_000), 1, {
    nowMs: 9_000, observedAtEpochMs: 1_800_000_012_000,
  }), {
    place_id: 1, started_at: stamp(11_000), expires_at: stamp(72_000),
    startedAtMs: 8_000, expiresAtMs: 69_000,
  }, 'a server timestamp created during a slow read maps against the coherent end sample')

  assert.deepEqual(normalizeLookingPresence(rawLooking(14_000, 70_000), 1, clock), {
    place_id: 1, started_at: stamp(14_000), expires_at: stamp(70_000),
    startedAtMs: 7_000, expiresAtMs: 67_000,
  }, 'bounded server clock skew is accepted without a future monotonic start')
  assert.deepEqual(normalizeLookingPresence(rawLooking(16_000, 76_000), 1, clock), {
    place_id: 1, started_at: stamp(16_000), expires_at: stamp(76_000),
    startedAtMs: 7_000, expiresAtMs: 73_000, suppressed: true,
  }, 'an authentic sixty-second far-future burst remains available only as a dedup baseline')
  assert.equal(normalizeLookingPresence(rawLooking(16_000, 76_001), 1, clock), null,
    'a far-future baseline cannot extend beyond its authentic sixty-second TTL')
})

test('opening seeds looking without old history; a new burst logs once and gets a short resident cue', () => {
  let shown = step(null, 10_000, [resident(1, 'alice', looking(0, 60_000)), resident(2, 'bob')])
  assert.deepEqual(shown.state.activity.history, [])
  assert.equal(shown.frame.effects.some(effect => effect.type === 'looking'), false)

  shown = step(shown, 20_000, [resident(1, 'alice', looking(15_000, 75_000)), resident(2, 'bob')])
  assert.equal(shown.state.activity.history.at(-1).text, 'alice is looking around.')
  assert.equal(shown.frame.effects.filter(effect => effect.type === 'looking').length, 1)
  assert.match(toPlainText(paintLiveView(shown.observation, size, shown.frame)), /o o|- -/u)

  shown = step(shown, 21_000, [resident(1, 'alice', looking(15_000, 78_000)), resident(2, 'bob')])
  assert.equal(shown.state.activity.history.filter(entry => entry.text === 'alice is looking around.').length, 1)
  assert.equal(step(shown, 23_000).frame.effects.some(effect => effect.type === 'looking'), false)
})

test('a far-future authentic burst is seeded once and does not appear when local time catches up', () => {
  const startedAt = stamp(16_000)
  const expiresAt = stamp(76_000)
  const suppressed = { place_id: 1, started_at: startedAt, expires_at: expiresAt,
    startedAtMs: 0, expiresAtMs: 66_000, suppressed: true }
  let shown = step(null, 0, [resident(1, 'alice', suppressed), resident(2, 'bob')])
  assert.deepEqual(shown.state.activity.history, [])
  assert.equal(shown.frame.effects.some(effect => effect.type === 'looking'), false)

  const eligible = { place_id: 1, started_at: startedAt, expires_at: expiresAt,
    startedAtMs: 6_000, expiresAtMs: 66_000 }
  shown = step(shown, 6_000, [resident(1, 'alice', eligible), resident(2, 'bob')])
  assert.deepEqual(shown.state.activity.history, [])
  assert.equal(shown.frame.effects.some(effect => effect.type === 'looking'), false)
})

test('another resident can look, sleep is overridden briefly, and quiet or off-room signals never cue', () => {
  let shown = step(null, 0, [resident(1, 'alice'), resident(2, 'bob', null, true)])
  shown = step(shown, 1_000, [resident(1, 'alice'), resident(2, 'bob', looking(500, 60_500), true)])
  const cue = shown.frame.effects.find(effect => effect.type === 'looking')
  assert.equal(cue.residentId, 2)
  assert.equal(cue.roomId, 1)
  assert.equal(cue.overridesSleep, true)
  assert.equal(shown.state.activity.history.at(-1).text, 'bob is looking around.')

  const quiet = observation([resident(1, 'alice'), resident(2, 'bob', looking(2_000, 62_000))])
  quiet.rooms[0].quiet = true
  shown = stepFollowMotion(shown.state, { nowMs: 2_000, size, observation: quiet })
  assert.equal(shown.frame.effects.some(effect => effect.type === 'looking'), false)
})

test('the offline looking fixture replays byte-identically without network access', async () => {
  const replayOnce = async () => {
    const source = await createLiveSource({
      mode: 'follow-room', followHandle: 'thog',
      sceneFile: new URL('../docs/evidence/follow-looking/follow-looking-scene.json', import.meta.url),
      fetchImpl: async () => { throw new Error('offline looking fixture attempted network access') },
    })
    try {
      const replay = createReplay(source, size)
      const frames = []
      const states = new Map()
      for (const atMs of source.frameTimes) {
        const shown = await replay.at(atMs)
        const plain = toPlainText(shown.frame)
        frames.push(`${atMs}\n${plain}`)
        states.set(atMs, { plain, motion: shown.motion })
      }
      return { bytes: frames.join('\n'), states }
    } finally { source.close() }
  }
  const first = await replayOnce()
  const second = await replayOnce()
  assert.equal(first.bytes, second.bytes)
  assert.match(first.states.get(266000).plain, /\n/u)
  assert.match(first.states.get(266000).plain, /o o|- -/u)
  assert.equal(first.states.get(274000).motion.frame.effects.some(effect => effect.type === 'looking'), false)
  assert.equal(first.states.get(271000).motion.state.activity.history
    .filter(entry => entry.text === 'thog is looking around.').length, 1)
  assert.equal(first.states.get(333000).motion.state.activity.history
    .filter(entry => entry.text === 'dry-run is looking around.').length, 1)
  assert.equal(first.states.get(340000).motion.frame.effects.some(effect => effect.type === 'looking'), false)

  const base = JSON.parse(await readFile(new URL('../docs/evidence/follow-actions-1.8.1/follow-actions-scene.json', import.meta.url), 'utf8'))
  const extended = JSON.parse(await readFile(new URL('../docs/evidence/follow-looking/follow-looking-scene.json', import.meta.url), 'utf8'))
  assert.deepEqual(extended.moments.slice(0, base.moments.length), base.moments)
  assert.deepEqual(extended.moments[0].raw.drawings, base.moments[0].raw.drawings)
  assert.equal(extended.frameTimes.length, 155)
})
