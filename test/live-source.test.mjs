import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLiveSource } from '../scripts/lib/live-source.mjs'

const drawing = (colour = '#123456') => ({
  type: 'place',
  id: 1,
  state: 'complete',
  presentation_state: 'complete',
  description: 'recorded drawing',
  drawing: { palette: [colour], indices: Array(64).fill(0) },
  rows: Array(8).fill('0 0 0 0 0 0 0 0'),
  source: 'place',
})

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const validScene = () => ({
  schemaVersion: 1,
  frameTimes: [0, 25, 50, 60],
  durationMs: 60,
  moments: [
    {
      atMs: 0,
      raw: {
        target: { id: 1, name: 'first town' },
        directory: { places: [{ id: 1, parent_id: null, name: 'first town' }] },
        presence: { pages: [{ residents: [] }], focused: null },
        rooms: [{ placeId: 1, response: { place: { id: 1, name: 'first town' }, things: [] } }],
        notes: { notes: [] },
        events: { events: [] },
        drawings: [],
      },
    },
    { atMs: 25, changes: [{ op: 'replace', path: ['target', 'name'], value: 'changed town' }] },
    { atMs: 50, changes: [{ op: 'prepend', path: ['events', 'events'], value: { id: 1 } }] },
  ],
})

const withSceneFile = async (scene, run) => {
  const directory = await mkdtemp(join(tmpdir(), 'live-source-scene-'))
  const path = join(directory, 'scene.json')
  try {
    await writeFile(path, JSON.stringify(scene), 'utf8')
    return await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const defaultResidents = () => [
  { id: 12, handle: 'moss', current_place_id: 3, asleep: false, has_drawing: true },
  { id: 11, handle: 'ember', current_place_id: 2, asleep: false, has_drawing: false },
]

const publicFixtures = (residents = defaultResidents()) => ({
  directory: {
    view: 'directory',
    places: [
      { type: 'place', id: 1, parent_id: null, name: 'first town', quiet: false },
      { type: 'place', id: 3, parent_id: 1, name: 'blue room', quiet: false },
      { type: 'place', id: 2, parent_id: 1, name: 'amber room', quiet: false },
    ],
    residents: residents.map(({ id, handle, has_drawing }) => ({ type: 'resident', id, handle, has_drawing })),
  },
  outline: { view: 'outline', places: [], residents: [], change_marker: '7' },
  presence: {
    residents,
    has_more: false,
    next_before_id: null,
  },
  map: {
    view: 'outline',
    place: { id: 1, parent_id: null, name: 'first town', things: 0, notes: 0 },
    subplaces: [
      { id: 3, parent_id: 1, name: 'blue room', things: 1, notes: 0 },
      { id: 2, parent_id: 1, name: 'amber room', things: 7, notes: 1 },
    ],
  },
  rooms: {
    1: { view: 'outline', place: { id: 1, parent_id: null, name: 'first town' }, things: [], notes: [], things_page: { total_items: 0 } },
    2: {
      view: 'outline',
      place: { id: 2, parent_id: 1, name: 'amber room' },
      things: [9, 8, 7, 6, 5].map((id) => ({ id, place_id: 2, name: `thing ${id}` })),
      notes: [{ id: 20, place_id: 2, author: 'ember', body_text_bytes: 5 }],
      things_page: { total_items: 7 },
    },
    3: { view: 'outline', place: { id: 3, parent_id: 1, name: 'blue room' }, things: [{ id: 10, place_id: 3, name: 'thing 10' }], notes: [], things_page: { total_items: 1 } },
  },
  notes: { notes: [{ id: 20, place_id: 2, author: 'ember', body: 'hello', created_at: '2026-09-07T00:00:00Z' }] },
  events: { events: [] },
})

const makeFetch = ({ transientResident = false, residents } = {}) => {
  const fixture = publicFixtures(residents)
  const calls = []
  let residentDrawingAttempts = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url: url.href, init })
    const path = `${url.pathname}${url.search}`
    if (path === '/api/window?view=directory') return jsonResponse(fixture.directory)
    if (path === '/api/window?view=outline') return jsonResponse(fixture.outline)
    if (path === '/api/residents?view=presence&limit=200') return jsonResponse(fixture.presence)
    if (path === '/api/residents?view=presence&handle=moss') return jsonResponse({ resident: fixture.presence.residents[0] })
    if (path === '/api/map?view=outline&parent_id=1&subplace_limit=200') return jsonResponse(fixture.map)
    const roomMatch = path.match(/^\/api\/place\/(\d+)\?view=outline&subplace_limit=1&thing_limit=5&note_limit=1$/u)
    if (roomMatch) return jsonResponse(fixture.rooms[Number(roomMatch[1])])
    if (path === '/api/window?collection=notes&within_place_id=1&limit=100') return jsonResponse(fixture.notes)
    if (path === '/api/events?within_place_id=1&limit=100') return jsonResponse(fixture.events)
    const residentDrawingMatch = path.match(/^\/api\/drawing\/resident\/(\d+)$/u)
    if (residentDrawingMatch) {
      const id = Number(residentDrawingMatch[1])
      if (id === 12) residentDrawingAttempts += 1
      if (transientResident && id === 12 && residentDrawingAttempts === 1) return jsonResponse({ error: 'busy' }, 503)
      const resident = fixture.presence.residents.find((value) => Number(value.id) === id)
      return jsonResponse(resident?.has_drawing === false
        ? { ...drawing(), type: 'resident', id, state: 'undrawn', presentation_state: 'undrawn', description: null, drawing: null, rows: null, source: 'none' }
        : { ...drawing('#abcdef'), type: 'resident', id, source: 'resident' })
    }
    if (path === '/api/drawing/place/1') return jsonResponse(drawing('#111111'))
    if (path === '/api/drawing/place/2') return jsonResponse({ ...drawing(), id: 2, state: 'undrawn', presentation_state: 'undrawn', description: null, drawing: null, rows: null, source: 'none' })
    if (path === '/api/drawing/place/3') return jsonResponse({ ...drawing('#333333'), id: 3 })
    if (path.startsWith('/api/drawing/thing/')) {
      const id = Number(url.pathname.split('/').at(-1))
      return jsonResponse(id === 5
        ? { ...drawing(), type: 'thing', id, state: 'undrawn', presentation_state: 'undrawn', description: null, drawing: null, rows: null, source: 'none' }
        : { ...drawing('#654321'), type: 'thing', id, source: 'thing' })
    }
    throw new Error(`unexpected public read ${path}`)
  }
  return { fetchImpl, calls }
}

test('recorded replay stays offline and chooses the three exact moments', async () => {
  let networkCalls = 0
  const source = await createLiveSource({
    sceneFile: new URL('./fixtures/live-scene.json', import.meta.url),
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('offline replay attempted the network')
    },
  })

  assert.deepEqual(source.frameTimes, [0, 2000, 4000, 30000, 30250, 30500, 31000, 32000, 60000, 62000, 65999, 66000, 68000])
  assert.deepEqual(source.momentTimes, [0, 30000, 60000])
  assert.equal(source.durationMs, 68000)
  const baseline = await source.read(0, { maxRooms: 9 })
  const moved = await source.read(30000, { maxRooms: 9 })
  const noted = await source.read(60000, { maxRooms: 9 })
  assert.equal(networkCalls, 0)
  assert.equal(baseline.ok, true)
  assert.equal(baseline.target.name, 'first town')
  assert.equal(baseline.rooms[0].id, baseline.target.id, 'the selected place is its own first room')
  assert.equal(baseline.rooms[0].residents.slice(0, 3).some((resident) => resident.handle === 'thog'), true, 'the moved actor is visible among the first three stable resident ids')
  assert.deepEqual(baseline.rooms.slice(1).map((room) => room.id), baseline.rooms.slice(1).map((room) => room.id).toSorted((a, b) => a - b))
  assert.ok(baseline.rooms.some((room) => room.residents.length > 1), 'the real baseline preserves a crowded room')
  assert.ok(baseline.rooms.some((room) => room.thingsCount > 5), 'the real baseline preserves an overflow room')
  assert.ok(baseline.rooms.flatMap((room) => room.things).some((thing) => thing.drawing))
  assert.ok(baseline.rooms.flatMap((room) => room.things).some((thing) => thing.drawing === null))
  assert.equal(baseline.events.some((event) => event.id === 100197), false)
  const recordedMove = moved.events.find((event) => event.id === 100197)
  assert.deepEqual(
    { actor: recordedMove.actor, action: recordedMove.detail.action, from: recordedMove.detail.from_place_id, to: recordedMove.detail.to_place_id },
    { actor: 'thog', action: 'move', from: 2, to: 34 },
  )
  assert.notEqual(
    baseline.rooms.flatMap((room) => room.residents).find((resident) => resident.handle === 'thog')?.current_place_id,
    moved.rooms.flatMap((room) => room.residents).find((resident) => resident.handle === 'thog')?.current_place_id,
  )
  assert.equal(baseline.notes.some((note) => note.id === 9007199254740000), false)
  assert.equal(noted.notes.some((note) => note.id === 9007199254740000 && note.place_id === 34 && note.author === 'thog'), true)
})

test('scene validation accepts three ordered moments with fixture-independent times', async () => {
  await withSceneFile(validScene(), async (sceneFile) => {
    const source = await createLiveSource({ sceneFile, fetchImpl: async () => { throw new Error('network') } })
    assert.deepEqual(source.frameTimes, [0, 25, 50, 60])
    assert.deepEqual(source.momentTimes, [0, 25, 50])
    assert.equal(source.durationMs, 60)
    const changed = await source.read(25, { maxRooms: 1 })
    assert.equal(changed.ok, true)
    assert.equal(changed.target.name, 'changed town')
  })
})

test('scene validation rejects unsafe shapes, times, operations, and paths', async () => {
  const invalidScenes = []
  const add = (label, change) => {
    const scene = validScene()
    change(scene)
    invalidScenes.push([label, scene])
  }
  add('schema version', scene => { scene.schemaVersion = 2 })
  add('moment count', scene => { scene.moments.pop() })
  add('first time', scene => { scene.moments[0].atMs = 1 })
  add('finite time', scene => { scene.moments[1].atMs = null })
  add('ordered time', scene => { scene.moments[2].atMs = 20 })
  add('duration', scene => { scene.durationMs = 40 })
  add('frame order', scene => { scene.frameTimes = [0, 50, 25] })
  add('operation', scene => { scene.moments[1].changes[0].op = 'delete' })
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    add(`path ${segment}`, scene => { scene.moments[1].changes[0].path = [segment, 'polluted'] })
  }
  add('missing path', scene => { scene.moments[1].changes[0].path = ['target', 'missing'] })
  add('prepend target', scene => { scene.moments[2].changes[0].path = ['target', 'name'] })

  for (const [label, scene] of invalidScenes) {
    await withSceneFile(scene, async (sceneFile) => {
      await assert.rejects(() => createLiveSource({ sceneFile }), /scene/iu, label)
    })
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('fixture keeps one raw public pass and labels only two hand-authored extensions', async () => {
  const scene = JSON.parse(await readFile(new URL('./fixtures/live-scene.json', import.meta.url), 'utf8'))
  assert.equal(scene.moments.length, 3)
  assert.deepEqual(scene.moments.map((moment) => moment.atMs), [0, 30000, 60000])
  assert.equal(scene.moments[0].metadata.provenance, 'recorded-public-pass')
  assert.deepEqual(scene.moments.slice(1).map((moment) => moment.metadata.provenance), [
    'hand-authored-extension',
    'hand-authored-extension',
  ])
  assert.equal(scene.moments[0].changes, undefined)
  assert.ok(scene.moments[0].raw.directory)
  assert.ok(scene.moments[0].raw.outline)
  assert.ok(scene.moments[0].raw.branch)
  assert.ok(scene.moments[0].raw.rooms.length > 0)
  assert.ok(scene.moments[0].raw.notes)
  assert.ok(scene.moments[0].raw.events)

  const raw = scene.moments[0].raw
  const roomIds = new Set(raw.rooms.map((room) => room.placeId))
  const residentIds = raw.presence.pages.flatMap((page) => page.residents)
    .filter((resident) => roomIds.has(resident.current_place_id))
    .map((resident) => `resident:${resident.id}`)
  const thingIds = raw.rooms.flatMap((room) => room.response.things.slice(0, 5))
    .map((thing) => `thing:${thing.id}`)
  const expectedKeys = [...new Set([
    ...[...roomIds].map((id) => `place:${id}`),
    ...residentIds,
    ...thingIds,
  ])].toSorted()
  assert.deepEqual(raw.drawings.map((entry) => entry.key).toSorted(), expectedKeys)
})

test('replay applies follow and place selection to recorded moments without networking', async () => {
  const sceneFile = new URL('./fixtures/live-scene.json', import.meta.url)
  const offline = async () => { throw new Error('replay attempted the network') }
  const followed = await createLiveSource({ sceneFile, followHandle: 'thog', fetchImpl: offline })
  const before = await followed.read(0, { maxRooms: 3 })
  const after = await followed.read(30000, { maxRooms: 3 })
  assert.equal(before.target.id, 2)
  assert.deepEqual(before.rooms.map((room) => room.id), [2, 34, 35])
  assert.equal(after.target.id, 34)
  assert.deepEqual(after.rooms.map((room) => room.id), [2, 34, 35])
  assert.equal(after.rooms.find((room) => room.id === 34).residents.some((resident) => resident.handle === 'thog'), true)

  const placed = await createLiveSource({ sceneFile, placeArg: 'the first town fair', fetchImpl: offline })
  const fair = await placed.read(0, { maxRooms: 3 })
  assert.equal(fair.target.id, 34)
  assert.deepEqual(fair.rooms.map((room) => room.id), [34])
})

test('live reads use only fixed-origin anonymous GETs and cache complete and undrawn drawings', async () => {
  const { fetchImpl, calls } = makeFetch({ transientResident: true })
  const source = await createLiveSource({ placeArg: 'first town', fetchImpl })

  const first = await source.read(0, { maxRooms: 3 })
  const second = await source.read(30000, { maxRooms: 3 })

  assert.deepEqual(first, { ok: false, error: 'drawing resident:12: HTTP 503' })
  assert.equal(second.ok, true)
  assert.deepEqual(second.rooms.map((room) => room.id), [1, 2, 3])
  assert.deepEqual(second.rooms[1].things.map((thing) => thing.id), [5, 6, 7, 8, 9])
  assert.equal(second.rooms[1].thingsCount, 7)
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, 'https://1f3d9.com')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.accept, 'application/json')
    assert.equal(init.headers.authorization, undefined)
    assert.equal(init.credentials, undefined)
  }
  const paths = calls.map(({ url }) => new URL(url).pathname)
  assert.equal(paths.filter((path) => path === '/api/drawing/place/1').length, 1, 'complete drawing cached')
  assert.equal(paths.filter((path) => path === '/api/drawing/place/2').length, 1, 'genuine undrawn cached')
  assert.equal(paths.filter((path) => path === '/api/drawing/resident/12').length, 2, 'transient drawing failure retried')
  assert.equal(paths.filter((path) => path.startsWith('/api/drawing/thing/')).length, 6, 'only five things per room, cached after first success')
})

test('follow includes the resident actual room and local scope in stable numeric boxes', async () => {
  const { fetchImpl } = makeFetch()
  const source = await createLiveSource({ followHandle: 'moss', fetchImpl })
  const result = await source.read(0, { maxRooms: 2 })

  assert.equal(result.ok, true)
  assert.equal(result.target.id, 3)
  assert.deepEqual(result.rooms.map((room) => room.id), [1, 3])
  assert.equal(result.rooms.find((room) => room.id === 3).residents.some((resident) => resident.handle === 'moss'), true)
})

test('follow keeps a town as scope when its parent is a continent', async () => {
  const base = makeFetch()
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    if (path === '/api/window?view=outline') {
      return jsonResponse({
        view: 'outline',
        places: [{ id: 99, parent_id: null, name: 'world', children: [{ id: 1, parent_id: 99, name: 'continent', children: [] }] }],
        residents: [],
      })
    }
    if (path === '/api/map?view=outline&parent_id=3&subplace_limit=200') {
      return jsonResponse({ view: 'outline', place: { id: 3, parent_id: 1, name: 'blue room' }, subplaces: [] })
    }
    if (path === '/api/window?collection=notes&within_place_id=3&limit=100') return jsonResponse({ notes: [] })
    if (path === '/api/events?within_place_id=3&limit=100') return jsonResponse({ events: [] })
    return base.fetchImpl(input, init)
  }
  const source = await createLiveSource({ followHandle: 'moss', fetchImpl })

  const result = await source.read(0, { maxRooms: 2 })

  assert.equal(result.ok, true)
  assert.equal(result.target.id, 3)
  assert.deepEqual(result.rooms.map((room) => room.id), [3])
  const paths = base.calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`)
  assert.equal(paths.some(path => path.includes('within_place_id=1')), false)
})

test('follow target uses the focused presence response over a stale paged presence row', async () => {
  const base = makeFetch()
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/residents' && url.searchParams.get('handle') === 'moss') {
      return jsonResponse({
        resident: { id: 12, handle: 'moss', current_place_id: 2, asleep: false, has_drawing: true },
      })
    }
    return base.fetchImpl(input, init)
  }
  const source = await createLiveSource({ followHandle: 'moss', fetchImpl })

  const result = await source.read(0, { maxRooms: 2 })

  assert.equal(result.ok, true)
  assert.equal(result.target.id, 2)
  assert.deepEqual(result.rooms.map((room) => room.id), [1, 2])
  assert.equal(result.rooms.find((room) => room.id === 2).residents.some((resident) => resident.handle === 'moss'), true)
})

test('a zero-room live read returns its title without room or drawing requests', async () => {
  const { fetchImpl, calls } = makeFetch()
  const source = await createLiveSource({ placeArg: 'first town', fetchImpl })

  const result = await source.read(0, { maxRooms: 0, size: { columns: 1, rows: 1 } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.target, { id: 1, name: 'first town' })
  assert.deepEqual(result.rooms, [])
  const paths = calls.map(({ url }) => new URL(url).pathname)
  assert.equal(paths.some((path) => path.startsWith('/api/place/')), false)
  assert.equal(paths.some((path) => path.startsWith('/api/drawing/')), false)
})

test('resident drawing reads follow visible capacity, use eight workers, and fetch newly shown residents later', async () => {
  const residents = Array.from({ length: 30 }, (_, index) => ({
    id: 130 - index,
    handle: `resident-${130 - index}`,
    current_place_id: 1,
    asleep: false,
    has_drawing: true,
  }))
  const base = makeFetch({ residents })
  let activeDrawings = 0
  let maxActiveDrawings = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (!url.pathname.startsWith('/api/drawing/')) return base.fetchImpl(input, init)
    activeDrawings += 1
    maxActiveDrawings = Math.max(maxActiveDrawings, activeDrawings)
    try {
      await new Promise(resolve => setTimeout(resolve, 1))
      return await base.fetchImpl(input, init)
    } finally {
      activeDrawings -= 1
    }
  }
  const source = await createLiveSource({ placeArg: 'first town', fetchImpl })

  const small = await source.read(0, { maxRooms: 1, size: { columns: 80, rows: 24 } })
  const firstResidentPaths = base.calls
    .map(({ url }) => new URL(url).pathname)
    .filter((path) => path.startsWith('/api/drawing/resident/'))
  const large = await source.read(1, { maxRooms: 1, size: { columns: 240, rows: 60 } })
  const allResidentPaths = base.calls
    .map(({ url }) => new URL(url).pathname)
    .filter((path) => path.startsWith('/api/drawing/resident/'))

  assert.equal(small.ok, true)
  assert.equal(large.ok, true)
  assert.ok(firstResidentPaths.length > 0 && firstResidentPaths.length < residents.length)
  assert.deepEqual(
    firstResidentPaths.map((path) => Number(path.split('/').at(-1))),
    residents.map((resident) => resident.id).toSorted((a, b) => a - b).slice(0, firstResidentPaths.length),
  )
  assert.equal(small.rooms[0].residents.filter((resident) => resident.drawing !== null).length, firstResidentPaths.length)
  assert.equal(large.rooms[0].residents.filter((resident) => resident.drawing !== null).length, residents.length)
  assert.equal(new Set(allResidentPaths).size, residents.length, 'residents skipped at the small size were not cached as fake undrawn')
  assert.ok(maxActiveDrawings <= 8, `drawing concurrency reached ${maxActiveDrawings}`)
})

test('a repeated public presence cursor fails instead of looping forever', async () => {
  const base = makeFetch()
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/residents' && url.searchParams.get('handle') === null) {
      return jsonResponse({ residents: [], has_more: true, next_before_id: 5 })
    }
    return base.fetchImpl(input, init)
  }
  const source = await createLiveSource({ placeArg: 'first town', fetchImpl })
  assert.deepEqual(await source.read(0, { maxRooms: 3 }), {
    ok: false,
    error: 'resident presence: invalid or repeated next_before_id',
  })
})

test('close aborts an active public read', async () => {
  let aborted = 0
  const fetchImpl = async (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted += 1
      reject(init.signal.reason)
    }, { once: true })
  })
  const source = await createLiveSource({ placeArg: 'first town', fetchImpl })
  const pending = source.read(0, { maxRooms: 3 })
  source.close()
  const result = await pending
  assert.ok(aborted > 0)
  assert.equal(result.ok, false)
})
