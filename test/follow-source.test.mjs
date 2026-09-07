import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createLiveSource } from '../scripts/lib/live-source.mjs'

const sceneFile = new URL('./fixtures/live-scene.json', import.meta.url)

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const drawing = (type, id) => ({
  type,
  id,
  state: 'complete',
  presentation_state: 'complete',
  description: `${type} ${id}`,
  drawing: { palette: ['#123456'], indices: Array(64).fill(0) },
  rows: Array(8).fill('0 0 0 0 0 0 0 0'),
  source: type,
})

const places = [
  { type: 'place', id: 1, parent_id: null, name: 'the world', quiet: false },
  { type: 'place', id: 10, parent_id: 1, name: 'amber room', quiet: false },
  { type: 'place', id: 20, parent_id: 1, name: 'blue room', quiet: false },
  { type: 'place', id: 30, parent_id: 1, name: 'green room', quiet: false },
  { type: 'place', id: 40, parent_id: 1, name: 'quiet house', quiet: true },
  { type: 'place', id: 41, parent_id: 40, name: 'quiet attic', quiet: false },
]

const alpha = { id: 999, handle: 'alpha', current_place_id: 10, asleep: false, has_drawing: true }
const beta = { id: 2, handle: 'beta', current_place_id: 20, asleep: false, has_drawing: true }
const quiet = { id: 3, handle: 'quiet-one', current_place_id: 41, asleep: false, has_drawing: true }
const crowd = Array.from({ length: 24 }, (_, index) => ({
  id: index + 10,
  handle: `crowd-${index + 10}`,
  current_place_id: 10,
  asleep: false,
  has_drawing: true,
}))

const room = (id, things = []) => ({
  view: 'outline',
  place: places.find((place) => place.id === id),
  things,
  notes: [],
  things_page: { total_items: things.length },
})

const makeFollowFetch = ({
  presenceReads = [[alpha, beta, quiet, ...crowd]],
  changePages = {},
  rooms = {
    10: room(10, [{ id: 501, place_id: 10, name: 'amber lamp' }]),
    20: room(20),
    30: room(30),
  },
  histories = {
    10: [{ id: 601, place_id: 10, author: 'crowd-10', body: 'already here', created_at: '2026-09-07T00:00:00Z' }],
    20: [],
    30: [],
  },
  notes = {},
  gateRoom = null,
  directoryPlaces = places,
  mapPlaces = places,
  missingDrawings = [],
} = {}) => {
  const calls = []
  let presenceIndex = 0
  let gated = false
  const roomReads = new Map()
  let releaseRoom
  let reachedRoom
  const roomGate = new Promise(resolve => { releaseRoom = resolve })
  const roomReached = new Promise(resolve => { reachedRoom = resolve })
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    calls.push({ path, init })
    if (path === '/api/window?view=directory') {
      return json({
        view: 'directory',
        places: directoryPlaces,
        residents: presenceReads[0].map(({ id, handle, has_drawing }) => ({ type: 'resident', id, handle, has_drawing })),
      })
    }
    if (path === '/api/changes') return json({ change_marker: '10' })
    if (url.pathname === '/api/changes' && url.searchParams.has('since')) {
      return json(changePages[url.searchParams.get('since')] ?? {
        change_marker: url.searchParams.get('since'), changes: [], returned_items: 0,
        unchanged: true, has_more: false, next_since: url.searchParams.get('since'),
      })
    }
    if (path === '/api/residents?view=presence&limit=200') {
      const residents = presenceReads[Math.min(presenceIndex, presenceReads.length - 1)]
      presenceIndex += 1
      return json({ residents, has_more: false, next_before_id: null })
    }
    if (url.pathname === '/api/residents' && url.searchParams.get('view') === 'presence') {
      const residents = presenceReads[Math.min(presenceIndex, presenceReads.length - 1)]
      presenceIndex += 1
      return json({ residents, has_more: false, next_before_id: null, change_marker: url.searchParams.get('after_change_marker') })
    }
    if (url.pathname === '/api/map' && url.searchParams.get('view') === 'outline') {
      return json({ place: mapPlaces.find(place => place.id === Number(url.searchParams.get('parent_id'))), subplaces: [], change_marker: url.searchParams.get('after_change_marker') })
    }
    const roomMatch = /^\/api\/place\/(\d+)\?view=outline&subplace_limit=1&thing_limit=5&note_limit=1$/u.exec(path)
    if (roomMatch) {
      const id = Number(roomMatch[1])
      roomReads.set(id, (roomReads.get(id) ?? 0) + 1)
      if (gateRoom === id && roomReads.get(id) === 2 && !gated) {
        gated = true
        reachedRoom()
        await roomGate
      }
      return json(rooms[id] ?? room(id))
    }
    if (url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes') {
      return json({ notes: histories[Number(url.searchParams.get('place_id'))] ?? [] })
    }
    const noteMatch = /^\/api\/note\/(\d+)$/u.exec(url.pathname)
    if (noteMatch) return json({ note: notes[Number(noteMatch[1])] }, notes[Number(noteMatch[1])] ? 200 : 404)
    const drawingMatch = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(url.pathname)
    if (drawingMatch) return missingDrawings.includes(Number(drawingMatch[2])) ? json({ error: 'gone' }, 404) : json(drawing(drawingMatch[1], Number(drawingMatch[2])))
    throw new Error(`unexpected public read ${path}`)
  }
  return { fetchImpl, calls, releaseRoom, roomReached }
}

test('follow-room reads one focused room, a minimal picker, baseline notes, and the focused portrait', async () => {
  const fake = makeFollowFetch()
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })

  assert.equal(fake.calls.length, 0, 'constructing a source does no I/O')
  assert.equal(source.selectResident('beta').ok, false, 'selection waits for a public census')
  assert.equal(fake.calls.length, 0, 'selection itself does no I/O')
  const result = await source.read(0, { maxRooms: 9, size: { columns: 80, rows: 24 } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.target, { id: 10, name: 'amber room' })
  assert.deepEqual(result.focus, { id: 999, handle: 'alpha', placeId: 10 })
  assert.equal(result.rooms.length, 1)
  assert.equal(result.rooms[0].focusResidentId, 999)
  assert.ok(result.rooms[0].residents.find((resident) => resident.id === 999)?.drawing, 'focus art wins even above the ordinary drawing budget')
  assert.deepEqual(result.notes.map((note) => note.id), [601], 'opening history seeds without creating a new bubble')
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.residents, [...result.residents].sort((a, b) => a.id - b.id))
  assert.ok(result.residents.every((resident) => Object.keys(resident).toSorted().join(',') === 'handle,id'))
  for (const call of fake.calls) {
    assert.equal(new URL(`https://1f3d9.com${call.path}`).origin, 'https://1f3d9.com')
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.headers.authorization, undefined)
  }
})

test('selection is synchronous, performs no I/O, and an in-flight old selection cannot win', async () => {
  const fake = makeFollowFetch({ gateRoom: 10 })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })
  assert.equal((await source.read(0, { size: { columns: 80, rows: 24 } })).focus.handle, 'alpha')
  const stale = source.read(1, { size: { columns: 80, rows: 24 } })
  await fake.roomReached
  const callsBeforeSelection = fake.calls.length

  assert.deepEqual(source.selectResident('beta'), { ok: true, changed: true })
  assert.equal(fake.calls.length, callsBeforeSelection)
  fake.releaseRoom()
  await stale
  const selected = await source.read(1, { size: { columns: 80, rows: 24 } })

  assert.equal(selected.focus.handle, 'beta')
  assert.equal(selected.target.id, 20)
  assert.equal(selected.rooms.length, 1)
  assert.deepEqual(source.selectResident('beta'), { ok: true, changed: false })
  assert.equal(source.selectResident('missing').ok, false)
})

test('changes continue oldest-first across pages, keep the followed move chain, and hydrate fresh notes', async () => {
  const movedAlpha = { ...alpha, current_place_id: 30 }
  const event = (changeId, kind, actor, detail) => ({ change_id: String(changeId), kind, actor, detail, created_at: `2026-09-07T00:00:${changeId}Z` })
  const fake = makeFollowFetch({
    presenceReads: [[alpha, beta], [movedAlpha, beta], [movedAlpha, beta]],
    rooms: {
      10: room(10),
      30: room(30, [{ id: 900, place_id: 30, name: 'new parcel' }]),
    },
    notes: {
      701: { id: 701, place_id: 30, author: 'alpha', body: 'fresh full note body', created_at: '2026-09-07T00:00:14Z' },
    },
    changePages: {
      10: {
        change_marker: '20',
        changes: [
          event(11, 'action', 'alpha', { action: 'move', status: 'applied', from_place_id: 10, to_place_id: 20 }),
          event(12, 'note', 'beta', { note_id: 700, place_id: 20 }),
        ],
        returned_items: 2, unchanged: false, has_more: true, next_since: '12',
      },
      12: {
        change_marker: '21',
        changes: [
          event(13, 'action', 'alpha', { action: 'move', status: 'applied', from_place_id: 20, to_place_id: 30 }),
          event(14, 'note', 'alpha', { note_id: 701, place_id: 30 }),
          event(15, 'thing_created', 'alpha', { thing_id: 900, place_id: 30, name: 'new parcel' }),
          event(16, 'action', 'alpha', { action: 'use', status: 'noop', source_thing_id: 900, place_id: 30 }),
          event(17, 'thing_withdrawn', 'alpha', { thing_id: 900, reason: 'withdrawn' }),
          event(18, 'thing_moved', 'alpha', { mode: 'carry', action_id: 77, thing_id: 900, resident_id: 999, from_place_id: 20, place_id: 30 }),
          event(19, 'action', 'alpha', { mode: 'carry', action_id: 77, action: 'move', status: 'applied', thing_id: 900, from_place_id: 20, to_place_id: 30 }),
          event(20, 'transfer', 'alpha', { mode: 'gift', asset_type: 'thing', asset_id: 900, resident_id: 2, place_id: 30 }),
        ],
        returned_items: 8, unchanged: false, has_more: false, next_since: '20',
      },
      21: { change_marker: '21', changes: [], returned_items: 0, unchanged: true, has_more: false, next_since: '21' },
    },
  })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })
  assert.equal((await source.read(0, { size: { columns: 120, rows: 40 } })).target.id, 10)

  const changed = await source.read(30_000, { size: { columns: 120, rows: 40 } })

  assert.equal(changed.target.id, 30)
  assert.deepEqual(changed.events.filter((row) => row.kind === 'action' && row.detail.action === 'move' && row.detail.mode !== 'carry').map((row) => [row.detail.from_place_id, row.detail.to_place_id]), [[10, 20], [20, 30]])
  assert.deepEqual(changed.events.map((row) => row.id), changed.events.map((row) => row.id).toSorted((a, b) => a - b))
  assert.ok(changed.events.every((row) => typeof row.change_id === 'string' && row.at === row.created_at))
  assert.deepEqual(changed.events.map((row) => row.kind), ['action', 'action', 'note', 'thing_created', 'action', 'thing_withdrawn', 'thing_moved', 'action', 'transfer'])
  assert.deepEqual(changed.notes, [{
    id: 701,
    place_id: 30,
    author: 'alpha',
    body: 'fresh full note body',
    created_at: '2026-09-07T00:00:14Z',
  }])
  assert.equal(changed.rooms[0].things[0].id, 900)
  assert.ok(changed.rooms[0].things[0].drawing)
  assert.ok(fake.calls.some(({ path }) => path === '/api/changes?since=10&limit=200'))
  assert.ok(fake.calls.some(({ path }) => path === '/api/changes?since=12&limit=200'))
  assert.ok(fake.calls.some(({ path }) => path === '/api/note/701'))
  assert.equal(fake.calls.some(({ path }) => path.startsWith('/api/events')), false)

  const settled = await source.read(60_000, { size: { columns: 120, rows: 40 } })
  assert.deepEqual(settled.events, [])
  assert.ok(fake.calls.some(({ path }) => path === '/api/changes?since=21&limit=200'))
})

test('changes reject decreasing, malformed, and repeated continuation markers', async () => {
  const cases = [
    { 10: { change_marker: '9', changes: [], has_more: false, next_since: '9' } },
    {
      10: { change_marker: '20', changes: [{ change_id: '11' }], has_more: true, next_since: '11' },
      11: { change_marker: '19', changes: [], has_more: false, next_since: '19' },
    },
    { 10: { change_marker: 'not-a-marker', changes: [], has_more: false } },
    {
      10: { change_marker: '20', changes: [{ change_id: '11' }], has_more: true, next_since: '11' },
      11: { change_marker: '20', changes: [], has_more: true, next_since: '11' },
    },
  ]
  for (const changePages of cases) {
    const fake = makeFollowFetch({ changePages })
    const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })
    assert.equal((await source.read(0, { size: { columns: 80, rows: 24 } })).ok, true)
    const result = await source.read(1, { size: { columns: 80, rows: 24 } })
    assert.equal(result.ok, false)
    assert.match(result.error, /changes/iu)
  }
})

test('a later withdrawal keeps the prior room thing long enough to emit its removal', async () => {
  const rooms = { 10: room(10, [{ id: 777, place_id: 10, name: 'temporary keepsake' }]) }
  const withdrawn = { change_id: '11', kind: 'thing_withdrawn', actor: 'alpha', detail: { thing_id: 777 }, created_at: '2026-09-07T00:00:11Z' }
  const repeated = { ...withdrawn, change_id: '12', created_at: '2026-09-07T00:00:12Z' }
  const fake = makeFollowFetch({
    rooms,
    changePages: {
      10: { change_marker: '11', changes: [withdrawn], has_more: false, next_since: '11' },
      11: { change_marker: '12', changes: [repeated], has_more: false, next_since: '12' },
    },
  })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })
  await source.read(0, { size: { columns: 80, rows: 24 } })
  rooms[10] = room(10)

  const removed = await source.read(1, { size: { columns: 80, rows: 24 } })
  const after = await source.read(2, { size: { columns: 80, rows: 24 } })

  assert.deepEqual(removed.events.map((event) => event.kind), ['thing_withdrawn'])
  assert.equal(removed.events[0].thing.id, 777)
  assert.ok(removed.events[0].thing.drawing)
  assert.deepEqual(after.events, [], 'membership is removed after the confirmed withdrawal')
})

test('marker-covered presence cannot consume a move before the resident reaches its room', async () => {
  const movedAlpha = { ...alpha, current_place_id: 20 }
  const move = { change_id: '11', kind: 'action', actor: 'alpha', detail: { action: 'move', status: 'applied', from_place_id: 10, to_place_id: 20 }, created_at: '2026-09-07T00:00:11Z' }
  const fake = makeFollowFetch({
    presenceReads: [[alpha, beta], [movedAlpha, beta]],
    changePages: { 10: { change_marker: '11', changes: [move], has_more: false, next_since: '11' } },
  })
  const fetchImpl = (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/residents' && !url.searchParams.has('after_change_marker')) return json({ residents: [alpha, beta], has_more: false, next_before_id: null })
    return fake.fetchImpl(input, init)
  }
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl })
  await source.read(0, { size: { columns: 80, rows: 24 } })

  const changed = await source.read(1, { size: { columns: 80, rows: 24 } })

  assert.equal(changed.target.id, 20)
  assert.deepEqual(changed.events.map(event => event.change_id), ['11'])
  assert.ok(fake.calls.some(({ path }) => path.includes('after_change_marker=11')))
})

test('a thing created and withdrawn between polls does not require its deleted drawing', async () => {
  const created = { change_id: '11', kind: 'thing_created', actor: 'alpha', detail: { thing_id: 888, place_id: 10 }, created_at: '2026-09-07T00:00:11Z' }
  const withdrawn = { change_id: '12', kind: 'thing_withdrawn', actor: 'alpha', detail: { thing_id: 888 }, created_at: '2026-09-07T00:00:12Z' }
  const fake = makeFollowFetch({
    missingDrawings: [888],
    changePages: { 10: { change_marker: '12', changes: [created, withdrawn], has_more: false, next_since: '12' } },
  })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })
  await source.read(0, { size: { columns: 80, rows: 24 } })

  const changed = await source.read(1, { size: { columns: 80, rows: 24 } })

  assert.equal(changed.ok, true)
  assert.deepEqual(changed.events.map(event => event.kind), ['thing_created', 'thing_withdrawn'])
  assert.ok(changed.events.every(event => event.thing.drawing === null))
})

test('a current room quiet flag hides content even when its covered ancestry was open', async () => {
  const secretRoom = {
    ...room(10, [{ id: 501, place_id: 10, name: 'hidden lamp' }]),
    place: { ...places.find(place => place.id === 10), quiet: true },
  }
  const fake = makeFollowFetch({ rooms: { 10: secretRoom } })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl: fake.fetchImpl })

  const result = await source.read(0, { size: { columns: 80, rows: 24 } })

  assert.equal(result.rooms[0].quiet, true)
  assert.deepEqual(result.rooms[0].things, [])
  assert.deepEqual(result.rooms[0].residents, [])
  assert.deepEqual(result.notes, [])
  assert.deepEqual(result.events, [])
})

test('a quiet ancestor returns only the named room shell and picker', async () => {
  const fake = makeFollowFetch({
    presenceReads: [[quiet, alpha]],
    directoryPlaces: places.map(place => ({ ...place, quiet: false })),
  })
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'quiet-one', fetchImpl: fake.fetchImpl })

  const result = await source.read(0, { size: { columns: 80, rows: 24 } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.focus, { id: 3, handle: 'quiet-one', placeId: 41 })
  assert.deepEqual(result.rooms, [{
    id: 41,
    name: 'quiet attic',
    drawing: null,
    things: [],
    thingsCount: 0,
    residents: [],
    notes: [],
    focusResidentId: 3,
    quiet: true,
  }])
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.notes, [])
  assert.equal(fake.calls.some(({ path }) => path.startsWith('/api/place/41')), false)
  assert.equal(fake.calls.some(({ path }) => path.includes('collection=notes')), false)
  assert.equal(fake.calls.some(({ path }) => path.startsWith('/api/drawing/')), false)
})

test('follow-room replay is immutable and offline, tracks the selected room, and quietly refuses an unrecorded room', async () => {
  const before = await readFile(sceneFile, 'utf8')
  let networkCalls = 0
  const source = await createLiveSource({
    mode: 'follow-room',
    sceneFile,
    followHandle: 'thog',
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('offline scene attempted network')
    },
  })

  const first = await source.read(0, { size: { columns: 80, rows: 24 } })
  const moved = await source.read(30_000, { size: { columns: 80, rows: 24 } })
  assert.equal(first.rooms.length, 1)
  assert.equal(first.target.id, 2)
  assert.equal(first.focus.handle, 'thog')
  assert.equal(first.rooms[0].focusResidentId, first.focus.id)
  assert.equal(moved.rooms.length, 1)
  assert.equal(moved.target.id, 34)
  assert.ok(moved.residents.some((resident) => resident.handle === 'hermes-agent'))

  assert.deepEqual(source.selectResident('hermes-agent'), { ok: true, changed: true })
  const missingRoom = await source.read(60_000, { size: { columns: 80, rows: 24 } })
  assert.equal(missingRoom.ok, false)
  assert.match(missingRoom.error, /room was not recorded in this scene/iu)
  assert.equal(networkCalls, 0)
  assert.equal(await readFile(sceneFile, 'utf8'), before)
})
