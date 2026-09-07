import { readFile } from 'node:fs/promises'

import {
  buildDirectoryIndex, comparePublicChanges, mergeDirectoryPlaces, publicMarker,
  readCityJson, readCoveredAncestry, readPublicChangeWindow, resolvePlaceArgument,
} from './city.mjs'
import { residentDrawingLimit } from './live-render.mjs'

const FRAME_TIMES = Object.freeze([0, 2000, 4000, 30000, 30250, 30500, 31000, 32000, 60000, 62000, 65999, 66000, 68000])
const DURATION_MS = 68000

const byId = (a, b) => Number(a.id) - Number(b.id)
const drawingKey = (type, id) => `${type}:${id}`

const responseError = (label, response) => `${label}: ${response?.error ?? `HTTP ${response?.status ?? 0}`}`

const readPresencePages = async (fetchImpl, afterMarker = null) => {
  const pages = []
  const seenCursors = new Set()
  let beforeId = null
  let marker = afterMarker
  do {
    const suffix = beforeId === null ? '' : `&before_id=${encodeURIComponent(beforeId)}`
    const barrier = afterMarker === null ? '' : `&after_change_marker=${encodeURIComponent(afterMarker)}`
    const result = await readCityJson(fetchImpl, `/api/residents?view=presence&limit=200${suffix}${barrier}`)
    if (!result.ok) return { ok: false, error: responseError('resident presence', result), pages }
    if (afterMarker !== null) {
      const covered = publicMarker(result.body?.change_marker)
      if (covered === null || BigInt(covered) < BigInt(marker)) return { ok: false, error: 'resident presence: invalid change_marker', pages }
      marker = covered
    }
    pages.push(result.body)
    if (!result.body?.has_more) beforeId = null
    else {
      const next = result.body.next_before_id
      if (!Number.isSafeInteger(next) || next < 1 || seenCursors.has(next)) {
        return { ok: false, error: 'resident presence: invalid or repeated next_before_id', pages }
      }
      seenCursors.add(next)
      beforeId = next
    }
  } while (beforeId !== null)
  return { ok: true, pages, marker }
}

const residentsFromPages = (pages) => pages.flatMap((page) => page?.residents ?? [])

const populationUnder = (placeId, residents, directoryIndex) => residents.reduce((count, resident) => (
  directoryIndex.ancestorsOf(resident.current_place_id).includes(placeId) ? count + 1 : count
), 0)

const defaultTarget = async (fetchImpl, outline, directoryIndex, residents) => {
  const continents = outline?.places?.[0]?.children ?? []
  if (!continents.length) return { ok: false, error: 'the public outline has no places' }
  const continent = [...continents].sort((a, b) => (
    populationUnder(b.id, residents, directoryIndex) - populationUnder(a.id, residents, directoryIndex) || byId(a, b)
  ))[0]
  const branchResult = await readCityJson(fetchImpl, `/api/map?view=outline&parent_id=${encodeURIComponent(continent.id)}&subplace_limit=200`)
  if (!branchResult.ok) return { ok: false, error: responseError('default town branch', branchResult) }
  const towns = branchResult.body?.subplaces ?? []
  if (!towns.length) return { ok: true, target: { id: continent.id, name: continent.name }, resolution: branchResult.body }
  const town = [...towns].sort((a, b) => (
    populationUnder(b.id, residents, directoryIndex) - populationUnder(a.id, residents, directoryIndex) || byId(a, b)
  ))[0]
  return { ok: true, target: { id: town.id, name: town.name }, resolution: branchResult.body }
}

const followScopeId = (target, outline, directoryIndex) => {
  const parentId = directoryIndex.byId.get(target.id)?.parentId
  const continentIds = new Set((outline?.places?.[0]?.children ?? []).map((place) => Number(place.id)))
  return parentId === null || parentId === undefined || continentIds.has(Number(parentId))
    ? Number(target.id)
    : Number(parentId)
}

const stableRoomIds = (target, scopeId, branch, maxRooms) => [...new Set([
  Number(target.id),
  Number(scopeId),
  ...(branch?.subplaces ?? []).map((place) => Number(place.id)).sort((a, b) => a - b),
])].slice(0, maxRooms).sort((a, b) => a - b)

const navigatorFor = ({ followHandle, scene, getRaw, getPlaceId, setPlaceId }) => (direction) => {
  if (!['left', 'right'].includes(direction)) {
    return { ok: false, error: 'Direction must be left or right.' }
  }
  if (followHandle) return { ok: true, changed: false }
  const raw = getRaw()
  if (!raw) return { ok: false, error: 'Read the city before changing towns.' }

  const directoryIndex = buildDirectoryIndex(raw.directory?.places ?? [])
  const continentIds = new Set((raw.outline?.places?.[0]?.children ?? []).map((place) => Number(place.id)))
  let town = directoryIndex.byId.get(Number(getPlaceId()))
  let guard = 0
  while (town && !continentIds.has(Number(town.parentId)) && guard < 64) {
    if (town.parentId === null || town.parentId === undefined) return { ok: false, error: 'The current town is unavailable.' }
    town = directoryIndex.byId.get(Number(town.parentId))
    guard += 1
  }
  if (!town || !continentIds.has(Number(town.parentId))) {
    return { ok: false, error: 'The current town is unavailable.' }
  }

  const towns = [...directoryIndex.byId.values()]
    .filter((place) => Number(place.parentId) === Number(town.parentId))
    .sort(byId)
  const currentIndex = towns.findIndex((place) => Number(place.id) === Number(town.id))
  if (currentIndex < 0 || towns.length < 2) return { ok: true, changed: false }
  const offset = direction === 'right' ? 1 : -1
  const nextTown = towns[(currentIndex + offset + towns.length) % towns.length]
  if (scene && !(raw.rooms ?? []).some((room) => Number(room.placeId) === Number(nextTown.id))) {
    return { ok: false, error: 'This scene does not include that town.' }
  }
  setPlaceId(Number(nextTown.id))
  return { ok: true, changed: true }
}

const cachedDrawing = async (fetchImpl, cache, type, id) => {
  const key = drawingKey(type, id)
  if (cache.has(key)) return { key, response: cache.get(key), cached: true }
  const result = await readCityJson(fetchImpl, `/api/drawing/${type}/${encodeURIComponent(id)}`)
  const response = { status: result.status, body: result.body, error: result.error ?? null }
  if (result.ok) cache.set(key, response)
  return { key, response, cached: false }
}
const eventDrawing = async (fetchImpl, cache, id) => {
  const result = await cachedDrawing(fetchImpl, cache, 'thing', id)
  return result.response.status === 404 ? { ...result, response: { status: 200, body: { drawing: null }, error: null } } : result
}

const readRoomResponses = async (fetchImpl, roomIds) => Promise.all(roomIds.map(async (placeId) => {
  const result = await readCityJson(fetchImpl, `/api/place/${encodeURIComponent(placeId)}?view=outline&subplace_limit=1&thing_limit=5&note_limit=1`)
  return { placeId, result }
}))

const mapWithConcurrency = async (items, limit, read) => {
  const results = Array(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await read(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const buildDrawingResponses = async (fetchImpl, cache, roomResponses, residents, residentLimit, focusResidentId = null) => {
  const requests = []
  for (const { placeId, result } of roomResponses) {
    requests.push(['place', placeId])
    for (const thing of [...(result.body?.things ?? [])].sort(byId).slice(0, 5)) requests.push(['thing', thing.id])
    const roomResidents = residents
      .filter((value) => Number(value.current_place_id) === Number(placeId))
      .sort((left, right) => (
        (Number(right.id) === Number(focusResidentId) ? 1 : 0)
        - (Number(left.id) === Number(focusResidentId) ? 1 : 0)
        || byId(left, right)
      ))
      .slice(0, residentLimit)
    for (const resident of roomResidents) {
      requests.push(['resident', resident.id])
    }
  }
  const unique = [...new Map(requests.map(([type, id]) => [drawingKey(type, id), [type, id]])).values()]
  return mapWithConcurrency(unique, 8, ([type, id]) => cachedDrawing(fetchImpl, cache, type, id))
}

const collectPublicRaw = async ({ placeArg, followHandle, fetchImpl, drawingCache, maxRooms, size }) => {
  const [directoryResult, outlineResult, presenceResult] = await Promise.all([
    readCityJson(fetchImpl, '/api/window?view=directory'),
    readCityJson(fetchImpl, '/api/window?view=outline'),
    readPresencePages(fetchImpl),
  ])
  if (!directoryResult.ok) return { ok: false, error: responseError('directory', directoryResult) }
  if (!outlineResult.ok) return { ok: false, error: responseError('outline', outlineResult) }
  if (!presenceResult.ok) return { ok: false, error: presenceResult.error }

  const directory = directoryResult.body
  const outline = outlineResult.body
  const directoryIndex = buildDirectoryIndex(directory.places ?? [])
  let residents = residentsFromPages(presenceResult.pages)
  let target
  let scopeTarget
  let branchResult
  let focusedPresence = null
  let resolution = null

  if (followHandle) {
    const focusResult = await readCityJson(fetchImpl, `/api/residents?view=presence&handle=${encodeURIComponent(followHandle)}`)
    if (!focusResult.ok || !focusResult.body?.resident) return { ok: false, error: responseError(`resident ${followHandle}`, focusResult) }
    focusedPresence = focusResult.body
    const resident = focusResult.body.resident
    residents = [...residents.filter((value) => Number(value.id) !== Number(resident.id)), resident]
    const known = directoryIndex.byId.get(resident.current_place_id)
    target = { id: resident.current_place_id, name: known?.name ?? `place #${resident.current_place_id}` }
    const scopeId = followScopeId(target, outline, directoryIndex)
    const scope = directoryIndex.byId.get(scopeId)
    scopeTarget = { id: scopeId, name: scope?.name ?? `place #${scopeId}` }
    branchResult = await readCityJson(fetchImpl, `/api/map?view=outline&parent_id=${encodeURIComponent(scopeId)}&subplace_limit=200`)
  } else {
    const targetId = resolvePlaceArgument(placeArg, directory.places ?? [])
    const known = targetId === null ? null : directoryIndex.byId.get(targetId)
    target = targetId === null ? null : { id: targetId, name: known?.name ?? `place #${targetId}` }
    if (!target && placeArg) return { ok: false, error: `no place matching "${placeArg}" was found` }
    if (!target) {
      const selected = await defaultTarget(fetchImpl, outline, directoryIndex, residents)
      if (!selected.ok) return selected
      target = selected.target
      resolution = selected.resolution
    }
    scopeTarget = target
    branchResult = await readCityJson(fetchImpl, `/api/map?view=outline&parent_id=${encodeURIComponent(target.id)}&subplace_limit=200`)
  }
  if (!branchResult.ok) return { ok: false, error: responseError('place branch', branchResult) }

  const roomIds = stableRoomIds(target, scopeTarget.id, branchResult.body, maxRooms)
  const roomResponses = await readRoomResponses(fetchImpl, roomIds)
  const failedRoom = roomResponses.find(({ result }) => !result.ok)
  if (failedRoom) return { ok: false, error: responseError(`room ${failedRoom.placeId}`, failedRoom.result) }

  const [notesResult, eventsResult] = await Promise.all([
    readCityJson(fetchImpl, `/api/window?collection=notes&within_place_id=${encodeURIComponent(scopeTarget.id)}&limit=100`),
    readCityJson(fetchImpl, `/api/events?within_place_id=${encodeURIComponent(scopeTarget.id)}&limit=100`),
  ])
  if (!notesResult.ok) return { ok: false, error: responseError('notes', notesResult) }
  if (!eventsResult.ok) return { ok: false, error: responseError('events', eventsResult) }

  const residentLimit = size && typeof size === 'object'
    ? residentDrawingLimit(size, roomIds.length)
    : Number.MAX_SAFE_INTEGER
  const drawings = await buildDrawingResponses(fetchImpl, drawingCache, roomResponses, residents, residentLimit)
  const failedDrawing = drawings.find((entry) => entry.response.status < 200 || entry.response.status >= 300)
  if (failedDrawing) return { ok: false, error: `drawing ${failedDrawing.key}: ${failedDrawing.response.error ?? `HTTP ${failedDrawing.response.status}`}` }
  return {
    ok: true,
    raw: {
      target: scopeTarget,
      directory,
      outline,
      presence: { pages: presenceResult.pages, focused: focusedPresence },
      resolution,
      branch: branchResult.body,
      rooms: roomResponses.map(({ placeId, result }) => ({ placeId, response: result.body })),
      notes: notesResult.body,
      events: eventsResult.body,
      drawings,
      followHandle: followHandle ?? null,
    },
  }
}

const drawingMapFromRaw = (raw) => new Map((raw.drawings ?? [])
  .filter((entry) => entry.response?.status >= 200 && entry.response?.status < 300)
  .map((entry) => [entry.key, entry.response.body?.drawing ?? null]))

const selectReplayTarget = (raw, { placeArg, followHandle }) => {
  const directoryIndex = buildDirectoryIndex(raw.directory?.places ?? [])
  const selectedHandle = followHandle ?? raw.followHandle
  if (selectedHandle) {
    const focused = raw.presence?.focused?.resident
    const resident = focused?.handle === selectedHandle
      ? focused
      : residentsFromPages(raw.presence?.pages ?? []).find((value) => value.handle === selectedHandle)
    if (!resident) return null
    const known = directoryIndex.byId.get(resident.current_place_id)
    return { id: resident.current_place_id, name: known?.name ?? `place #${resident.current_place_id}`, nearby: true }
  }
  if (placeArg !== undefined && placeArg !== null && placeArg !== '') {
    const id = resolvePlaceArgument(placeArg, raw.directory?.places ?? [])
    if (id === null) return null
    const known = directoryIndex.byId.get(id)
    return { id, name: known?.name ?? `place #${id}`, nearby: false }
  }
  return { ...raw.target, nearby: false }
}

const normalizeRaw = (raw, maxRooms, selection = {}) => {
  const drawings = drawingMapFromRaw(raw)
  const presenceResidents = residentsFromPages(raw.presence?.pages ?? [])
  const focused = raw.presence?.focused?.resident
  const residents = focused
    ? [...presenceResidents.filter((resident) => Number(resident.id) !== Number(focused.id)), focused]
    : presenceResidents
  const selected = selectReplayTarget(raw, selection)
  if (!selected) return { ok: false, error: selection.followHandle ? `resident ${selection.followHandle} was not recorded in this scene` : `the selected place was not recorded in this scene` }
  const directoryIndex = buildDirectoryIndex(raw.directory?.places ?? [])
  const availableIds = new Set((raw.rooms ?? []).map((room) => Number(room.placeId)))
  if (maxRooms > 0 && !availableIds.has(Number(selected.id))) {
    return { ok: false, error: `place #${selected.id} was not recorded in this scene` }
  }
  const roomOrder = selected.nearby
    ? [...new Set([
      Number(selected.id),
      Number(raw.target?.id),
      ...[...availableIds].sort((a, b) => a - b),
    ])].filter((id) => availableIds.has(id)).slice(0, maxRooms).sort((a, b) => a - b)
    : [
      Number(selected.id),
      ...[...availableIds]
        .filter((id) => id !== Number(selected.id) && directoryIndex.byId.get(id)?.parentId === Number(selected.id))
        .sort((a, b) => a - b),
    ].slice(0, maxRooms)
  const roomById = new Map((raw.rooms ?? []).map((entry) => [Number(entry.placeId), entry.response]))
  const notes = [...(raw.notes?.notes ?? [])].sort(byId)
  const rooms = roomOrder.map((id) => {
    const response = roomById.get(Number(id)) ?? {}
    const place = response.place ?? directoryIndex.byId.get(Number(id)) ?? { id, name: `place #${id}` }
    const things = [...(response.things ?? [])].sort(byId).slice(0, 5).map((thing) => ({
      ...thing,
      drawing: drawings.get(drawingKey('thing', thing.id)) ?? null,
    }))
    return {
      id: place.id,
      name: place.name,
      drawing: drawings.get(drawingKey('place', place.id)) ?? null,
      things,
      thingsCount: response.things_page?.total_items ?? things.length,
      residents: residents.filter((resident) => Number(resident.current_place_id) === Number(place.id)).sort(byId).map((resident) => ({
        ...resident,
        drawing: drawings.get(drawingKey('resident', resident.id)) ?? null,
      })),
      notes: notes.filter((note) => Number(note.place_id) === Number(place.id)),
    }
  })
  return {
    ok: true,
    target: { id: selected.id, name: selected.name },
    rooms,
    events: [...(raw.events?.events ?? [])].sort(byId),
    notes,
    directory: raw.directory,
  }
}
const pickerFromResidents = (residents) => [...new Map((residents ?? [])
  .filter((resident) => Number.isSafeInteger(Number(resident?.id)) && Number(resident.id) > 0 && typeof resident.handle === 'string' && resident.handle.trim())
  .map((resident) => [Number(resident.id), { id: Number(resident.id), handle: resident.handle.trim() }])).values()].sort(byId)
const residentForHandle = (residents, handle) => {
  const wanted = typeof handle === 'string' ? handle.trim() : ''
  return wanted ? residents.find((resident) => resident.handle === wanted) ?? null : residents[0] ?? null
}
const quietAncestor = (placeId, directoryIndex) => directoryIndex.ancestorsOf(placeId)
  .some((id) => directoryIndex.byId.get(id)?.quiet === true)
const normalizedFollowRoom = ({ raw, selectedHandle, knownThingIds = [] }) => {
  const drawings = drawingMapFromRaw(raw)
  const residents = residentsFromPages(raw.presence?.pages ?? [])
  const picker = pickerFromResidents(residents)
  const focus = residentForHandle(residents, selectedHandle)
  if (!focus) return { ok: false, error: selectedHandle ? `resident ${selectedHandle} was not found in the public resident list` : 'the public resident list is empty' }
  if (!Number.isSafeInteger(Number(focus.current_place_id)) || Number(focus.current_place_id) < 1) return { ok: false, error: `resident ${focus.handle} has no public current room` }
  const placeId = Number(focus.current_place_id)
  const directoryIndex = buildDirectoryIndex(raw.directory?.places ?? [])
  const known = directoryIndex.byId.get(placeId)
  const target = { id: placeId, name: known?.name ?? `place #${placeId}` }
  const hidden = quietAncestor(placeId, directoryIndex)
  const roomEntry = (raw.rooms ?? []).find((entry) => Number(entry.placeId) === placeId)
  if (!hidden && !roomEntry) return { ok: false, error: `resident ${focus.handle}'s room was not recorded in this scene` }
  const response = roomEntry?.response ?? {}
  const things = hidden ? [] : [...(response.things ?? [])].sort(byId).slice(0, 5).map((thing) => ({
    ...thing,
    drawing: drawings.get(drawingKey('thing', thing.id)) ?? null,
  }))
  const notes = hidden ? [] : [...(raw.notes?.notes ?? [])]
    .filter((note) => Number(note.place_id) === placeId)
    .sort(byId)
  const thingIds = new Set([...knownThingIds, ...things.map((thing) => Number(thing.id))])
  const relevant = hidden ? [] : relevantChanges([...(raw.events?.events ?? [])].sort(byId), focus, placeId, thingIds).events
    .map((event) => {
      const thingId = eventThingId(event)
      if (thingId === null) return event
      const named = things.find((thing) => Number(thing.id) === thingId)
      return { ...event, thing: { id: thingId, name: named?.name ?? null, drawing: drawings.get(drawingKey('thing', thingId)) ?? null } }
    })
  const displayedEvents = new Map(relevant.map(event => [String(event.id), event]))
  const contextEvents = hidden ? [] : [...(raw.contextEvents?.events ?? raw.events?.events ?? [])].sort(byId)
    .map(event => displayedEvents.get(String(event.id)) ?? event)
  const roomResidents = hidden ? [] : residents
    .filter((resident) => Number(resident.current_place_id) === placeId)
    .sort(byId)
    .map((resident) => ({ ...resident, drawing: drawings.get(drawingKey('resident', resident.id)) ?? null }))
  return {
    ok: true,
    target,
    focus: { id: Number(focus.id), handle: focus.handle, placeId },
    residents: picker,
    rooms: [{
      id: placeId,
      name: response.place?.name ?? target.name,
      drawing: hidden ? null : drawings.get(drawingKey('place', placeId)) ?? null,
      things,
      thingsCount: hidden ? 0 : response.things_page?.total_items ?? things.length,
      residents: roomResidents,
      notes,
      focusResidentId: Number(focus.id),
      quiet: hidden,
    }],
    events: relevant,
    contextEvents,
    notes,
    directory: raw.directory,
  }
}
const eventThingId = (event) => {
  const detail = event?.detail ?? {}
  const value = Number.isSafeInteger(Number(detail.thing_id)) ? Number(detail.thing_id)
    : event?.kind === 'transfer' && detail.asset_type === 'thing' && Number.isSafeInteger(Number(detail.asset_id)) ? Number(detail.asset_id)
      : event?.kind === 'transfer' && detail.type === 'thing' && Number.isSafeInteger(Number(detail.id)) ? Number(detail.id)
        : Number.isSafeInteger(Number(detail.source_thing_id)) ? Number(detail.source_thing_id) : null
  return value !== null && value > 0 ? value : null
}
function eventRelevantToFollow(event, focus, placeId, thingIds) {
  const detail = event?.detail ?? {}
  const endpointMove = event?.actor === focus.handle && event?.kind === 'action'
    && ['move', 'go_home'].includes(detail.action)
    && Number.isSafeInteger(Number(detail.from_place_id)) && Number.isSafeInteger(Number(detail.to_place_id))
  if (endpointMove) return true
  if ([detail.place_id, detail.from_place_id, detail.to_place_id, detail.parent_id].some((id) => Number(id) === placeId)) return true
  const thingId = eventThingId(event)
  return thingId !== null && thingIds.has(thingId)
}
const relevantChanges = (changes, focus, placeId, knownThingIds) => {
  const thingIds = new Set(knownThingIds)
  const result = []
  for (const change of changes) {
    const thingId = eventThingId(change)
    if (thingId !== null && ['thing_created', 'thing_moved'].includes(change.kind) && Number(change.detail?.place_id) === placeId) thingIds.add(thingId)
    if (eventRelevantToFollow(change, focus, placeId, thingIds)) result.push(change)
    if (thingId !== null && (change.kind === 'thing_withdrawn' || (change.kind === 'thing_moved' && Number(change.detail?.from_place_id) === placeId && Number(change.detail?.place_id) !== placeId))) thingIds.delete(thingId)
  }
  return { events: result, thingIds }
}
const noteBodiesFor = async (fetchImpl, events, placeId) => {
  const ids = [...new Set(events.filter((event) => event.kind === 'note' && Number(event.detail?.place_id) === placeId)
    .map((event) => Number(event.detail?.note_id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  const reads = await mapWithConcurrency(ids, 8, async (id) => {
    const result = await readCityJson(fetchImpl, `/api/note/${encodeURIComponent(id)}`)
    return { id, result }
  })
  const failed = reads.find(({ result }) => !result.ok || !result.body?.note)
  if (failed) return { ok: false, error: responseError(`note ${failed.id}`, failed.result) }
  return { ok: true, notes: reads.map(({ result }) => result.body.note) }
}
const mergeNotes = (...groups) => [...new Map(groups.flat().filter((note) => Number.isSafeInteger(Number(note?.id)))
  .map((note) => [Number(note.id), note])).values()].sort(byId)
const clone = (value) => structuredClone(value)

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

const sceneError = (message) => new Error(`scene file ${message}`)

const changeTarget = (target, change) => {
  if (!change || typeof change !== 'object' || !['replace', 'prepend'].includes(change.op)) {
    throw sceneError('contains an unsupported change operation')
  }
  if (!Array.isArray(change.path) || change.path.length === 0) {
    throw sceneError('change paths must be non-empty arrays')
  }
  let parent = target
  for (const segment of change.path.slice(0, -1)) {
    if (
      (typeof segment !== 'string' && !Number.isSafeInteger(segment))
      || FORBIDDEN_PATH_SEGMENTS.has(segment)
      || !parent
      || typeof parent !== 'object'
      || !Object.hasOwn(parent, segment)
    ) {
      throw sceneError('change paths must name safe existing own properties')
    }
    parent = parent[segment]
  }
  const key = change.path.at(-1)
  if (
    (typeof key !== 'string' && !Number.isSafeInteger(key))
    || FORBIDDEN_PATH_SEGMENTS.has(key)
    || !parent
    || typeof parent !== 'object'
    || !Object.hasOwn(parent, key)
  ) {
    throw sceneError('change paths must name safe existing own properties')
  }
  if (change.op === 'prepend' && !Array.isArray(parent[key])) {
    throw sceneError('prepend changes must target an existing array')
  }
  return { parent, key }
}

const applyChange = (target, change) => {
  const { parent, key } = changeTarget(target, change)
  if (change.op === 'replace') parent[key] = clone(change.value)
  else if (change.op === 'prepend') parent[key].unshift(clone(change.value))
}

const rawForMoment = (scene, selectedIndex) => {
  const raw = clone(scene.moments[0].raw)
  for (let index = 1; index <= selectedIndex; index += 1) {
    for (const change of scene.moments[index].changes ?? []) applyChange(raw, change)
  }
  return raw
}

const readScene = async (sceneFile) => {
  const text = await readFile(sceneFile, 'utf8')
  const scene = JSON.parse(text)
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) || scene.schemaVersion !== 1) {
    throw sceneError('must use schemaVersion 1')
  }
  if (!Number.isFinite(scene.durationMs) || scene.durationMs < 0) {
    throw sceneError('durationMs must be a finite non-negative number')
  }
  if (
    !Array.isArray(scene.frameTimes)
    || scene.frameTimes.length === 0
    || scene.frameTimes[0] !== 0
    || scene.frameTimes.some((time, index) => (
      !Number.isFinite(time)
      || time < 0
      || time > scene.durationMs
      || (index > 0 && time <= scene.frameTimes[index - 1])
    ))
  ) {
    throw sceneError('frameTimes must be finite, strictly ordered from zero, and within durationMs')
  }
  if (!Array.isArray(scene.moments) || scene.moments.length < 3) {
    throw sceneError('must contain at least three moments')
  }
  if (scene.moments.some((moment, index) => (
    !moment
    || typeof moment !== 'object'
    || !Number.isFinite(moment.atMs)
    || moment.atMs < 0
    || moment.atMs > scene.durationMs
    || (index === 0 ? moment.atMs !== 0 : moment.atMs <= scene.moments[index - 1].atMs)
  ))) {
    throw sceneError('moment times must be finite, strictly ordered from zero, and within durationMs')
  }
  if (!scene.moments[0].raw || typeof scene.moments[0].raw !== 'object' || Array.isArray(scene.moments[0].raw)) {
    throw sceneError('first moment must contain a raw recorded baseline')
  }
  const validationRaw = clone(scene.moments[0].raw)
  for (const moment of scene.moments.slice(1)) {
    if (!Array.isArray(moment.changes)) throw sceneError('later moments must contain change arrays')
    for (const change of moment.changes) applyChange(validationRaw, change)
  }
  return scene
}

const createFollowRoomSource = async ({ followHandle, sceneFile, failAt, fetchImpl }) => {
  let selectedHandle = followHandle ?? null
  let latestResidents = null
  let generation = 0
  const selectResident = (handle) => {
    if (!latestResidents) return { ok: false, error: 'Read the city before choosing a resident.' }
    const resident = residentForHandle(latestResidents, handle)
    if (!resident || resident.handle !== String(handle ?? '').trim()) return { ok: false, error: `Resident "${String(handle ?? '')}" is not in the public resident list.` }
    if (selectedHandle === resident.handle) return { ok: true, changed: false }
    selectedHandle = resident.handle
    generation += 1
    return { ok: true, changed: true }
  }
  const navigate = () => ({ ok: true, changed: false })
  if (sceneFile) {
    const scene = await readScene(sceneFile)
    if (failAt !== undefined && (!Number.isFinite(failAt) || failAt < 0 || !scene.moments.some((moment) => moment.atMs === failAt))) {
      throw new TypeError('scene failAt must be a finite non-negative exact scene moment')
    }
    return {
      frameTimes: [...scene.frameTimes], momentTimes: scene.moments.map((moment) => moment.atMs), durationMs: scene.durationMs,
      selectResident, navigate, close: () => {},
      read: async (nowMs) => {
        const readGeneration = generation
        const index = Math.max(0, scene.moments.findLastIndex((moment) => moment.atMs <= nowMs))
        if (failAt !== undefined && scene.moments[index].atMs === failAt) return { ok: false, error: 'Injected scene read failure.' }
        const raw = rawForMoment(scene, index)
        const residents = residentsFromPages(raw.presence?.pages ?? [])
        const result = normalizedFollowRoom({ raw, selectedHandle })
        if (readGeneration === generation) {
          latestResidents = residents
          if (result.ok && selectedHandle === null) selectedHandle = result.focus.handle
        }
        return result
      },
    }
  }
  if (failAt !== undefined) throw new TypeError('failAt requires --scene')
  if (typeof fetchImpl !== 'function') throw new TypeError('live source requires a fetch implementation')
  const controller = new AbortController()
  const sourceFetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) })
  const eventIds = new Map()
  const noteCache = new Map()
  const knownThings = new Map()
  let nextEventId = 1
  let marker = null
  let lastRoomId = null
  const eventId = (changeId) => {
    if (!eventIds.has(changeId)) { eventIds.set(changeId, nextEventId); nextEventId += 1 }
    return eventIds.get(changeId)
  }
  return {
    selectResident, navigate, close: () => controller.abort(),
    read: async (_nowMs, { size } = {}) => {
      const readGeneration = generation
      const readHandle = selectedHandle
      const baseline = marker === null
      const [directoryResult, firstChanges] = await Promise.all([
        readCityJson(sourceFetch, '/api/window?view=directory'), readPublicChangeWindow(sourceFetch, marker),
      ])
      if (!directoryResult.ok) return { ok: false, error: responseError('directory', directoryResult) }
      if (!firstChanges.ok) return firstChanges
      let changeMarker = firstChanges.marker
      let publicChanges = [...firstChanges.changes]
      let presenceResult
      let residents
      let focus
      let ancestry
      for (let attempt = 0; attempt < 4; attempt += 1) {
        presenceResult = await readPresencePages(sourceFetch, changeMarker)
        if (!presenceResult.ok) return { ok: false, error: presenceResult.error }
        residents = residentsFromPages(presenceResult.pages)
        focus = residentForHandle(residents, readHandle)
        if (!focus) {
          if (readGeneration === generation) latestResidents = residents
          return { ok: false, error: readHandle ? `resident ${readHandle} was not found in the public resident list` : 'the public resident list is empty' }
        }
        const placeId = Number(focus.current_place_id)
        if (!Number.isSafeInteger(placeId) || placeId < 1) return { ok: false, error: `resident ${focus.handle} has no public current room` }
        ancestry = await readCoveredAncestry(sourceFetch, placeId, changeMarker)
        if (!ancestry.ok) return ancestry
        const covered = BigInt(presenceResult.marker) > BigInt(ancestry.marker) ? presenceResult.marker : ancestry.marker
        if (covered === changeMarker) break
        if (attempt === 3) return { ok: false, error: 'city changed during the covered follow read; retry' }
        if (baseline) changeMarker = covered
        else {
          const more = await readPublicChangeWindow(sourceFetch, changeMarker)
          if (!more.ok || BigInt(more.marker) < BigInt(covered)) return more.ok ? { ok: false, error: 'changes did not cover the resident snapshot' } : more
          publicChanges.push(...more.changes)
          changeMarker = more.marker
        }
      }
      const placeId = Number(focus.current_place_id)
      let directory = mergeDirectoryPlaces(directoryResult.body, ancestry.places)
      const directoryIndex = buildDirectoryIndex(directory.places)
      let hidden = ancestry.places.some(place => place.quiet === true)
      let roomResponse = { place: { id: placeId, name: directoryIndex.byId.get(placeId).name }, things: [], things_page: { total_items: 0 } }
      let history = []
      if (!hidden) {
        const reads = [readCityJson(sourceFetch, `/api/place/${encodeURIComponent(placeId)}?view=outline&subplace_limit=1&thing_limit=5&note_limit=1`)]
        if (lastRoomId !== placeId || !noteCache.has(placeId)) reads.push(readCityJson(sourceFetch, `/api/window?collection=notes&place_id=${encodeURIComponent(placeId)}&limit=100`))
        const [roomResult, historyResult] = await Promise.all(reads)
        if (!roomResult.ok) return { ok: false, error: responseError(`room ${placeId}`, roomResult) }
        if (historyResult && !historyResult.ok) return { ok: false, error: responseError('notes', historyResult) }
        roomResponse = roomResult.body
        history = historyResult?.body?.notes ?? noteCache.get(placeId) ?? []
        if (roomResponse.place?.quiet === true) {
          hidden = true
          history = []
          directory = mergeDirectoryPlaces(directory, [roomResponse.place])
        }
      }
      const roomThingIds = new Set((roomResponse.things ?? []).map((thing) => Number(thing.id)))
      const priorThingIds = new Set([...(knownThings.get(placeId) ?? []), ...roomThingIds])
      const orderedChanges = [...new Map(publicChanges.sort(comparePublicChanges).map(change => [change.change_id, change])).values()]
      const contextEvents = hidden ? [] : orderedChanges.map((change) => ({ ...change, id: eventId(change.change_id), at: change.created_at }))
      const changeWindow = hidden ? { events: [], thingIds: new Set() } : relevantChanges(orderedChanges, focus, placeId, priorThingIds)
      const changes = changeWindow.events
      const events = changes.map((change) => ({ ...change, id: eventId(change.change_id), at: change.created_at }))
      const freshNotes = hidden ? { ok: true, notes: [] } : await noteBodiesFor(sourceFetch, events, placeId)
      if (!freshNotes.ok) return freshNotes
      const notes = hidden ? [] : mergeNotes(history, freshNotes.notes)
      const residentLimit = size ? residentDrawingLimit(size, 1) : Number.MAX_SAFE_INTEGER
      const roomRows = hidden ? [] : [{ placeId, result: { body: roomResponse } }]
      const drawingCache = new Map()
      const drawings = await buildDrawingResponses(sourceFetch, drawingCache, roomRows, residents, residentLimit, focus.id)
      const extraThingIds = hidden ? [] : [...new Set(events.map(eventThingId).filter((id) => id !== null && !roomThingIds.has(id)))]
      drawings.push(...await mapWithConcurrency(extraThingIds, 8, (id) => eventDrawing(sourceFetch, drawingCache, id)))
      const failedDrawing = drawings.find((entry) => entry.response.status < 200 || entry.response.status >= 300)
      if (failedDrawing) return { ok: false, error: `drawing ${failedDrawing.key}: ${failedDrawing.response.error ?? `HTTP ${failedDrawing.response.status}`}` }
      const raw = { directory, presence: { pages: presenceResult.pages }, rooms: hidden ? [] : [{ placeId, response: roomResponse }], notes: { notes }, events: { events }, contextEvents: { events: contextEvents }, drawings }
      const result = normalizedFollowRoom({ raw, selectedHandle: readHandle, knownThingIds: priorThingIds })
      if (readGeneration === generation && result.ok) {
        latestResidents = residents
        selectedHandle = focus.handle
        marker = changeMarker
        lastRoomId = placeId
        noteCache.set(placeId, notes)
        knownThings.set(placeId, changeWindow.thingIds)
      }
      return result
    },
  }
}

export async function createLiveSource({ mode, placeArg, followHandle, sceneFile, failAt, fetchImpl = globalThis.fetch } = {}) {
  if (mode === 'follow-room') return createFollowRoomSource({ followHandle, sceneFile, failAt, fetchImpl })
  if (failAt !== undefined && !sceneFile) throw new TypeError('failAt requires --scene')
  let selectedPlace = placeArg
  let lastSuccessfulRaw = null
  let selectionGeneration = 0
  if (sceneFile) {
    const scene = await readScene(sceneFile)
    if (failAt !== undefined && (!Number.isFinite(failAt) || failAt < 0)) {
      throw new TypeError('scene failAt must be a finite non-negative number')
    }
    if (failAt !== undefined && !scene.moments.some((moment) => moment.atMs === failAt)) {
      throw new TypeError('scene failAt must match an exact scene moment')
    }
    const navigate = navigatorFor({
      followHandle,
      scene: true,
      getRaw: () => lastSuccessfulRaw,
      getPlaceId: () => selectedPlace ?? lastSuccessfulRaw?.target?.id,
      setPlaceId: id => {
        selectedPlace = id
        selectionGeneration += 1
      },
    })
    return {
      frameTimes: [...scene.frameTimes],
      momentTimes: scene.moments.map((moment) => moment.atMs),
      durationMs: scene.durationMs,
      navigate,
      close: () => {},
      read: async (nowMs, { maxRooms = Number.MAX_SAFE_INTEGER } = {}) => {
        const readGeneration = selectionGeneration
        const selectedIndex = scene.moments.findLastIndex((moment) => moment.atMs <= nowMs)
        const momentIndex = Math.max(0, selectedIndex)
        if (failAt !== undefined && scene.moments[momentIndex].atMs === failAt) {
          return { ok: false, error: 'Injected scene read failure.' }
        }
        const raw = rawForMoment(scene, momentIndex)
        const result = normalizeRaw(raw, maxRooms, { placeArg: selectedPlace, followHandle })
        if (result.ok && readGeneration === selectionGeneration) {
          lastSuccessfulRaw = raw
          if (!followHandle) selectedPlace = result.target.id
        }
        return result
      },
    }
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('live source requires a fetch implementation')
  const controller = new AbortController()
  const sourceFetch = (url, init) => fetchImpl(url, {
    ...init,
    signal: AbortSignal.any([init.signal, controller.signal]),
  })
  const navigate = navigatorFor({
    followHandle,
    scene: false,
    getRaw: () => lastSuccessfulRaw,
    getPlaceId: () => selectedPlace ?? lastSuccessfulRaw?.target?.id,
    setPlaceId: id => {
      selectedPlace = id
      selectionGeneration += 1
    },
  })
  return {
    navigate,
    close: () => controller.abort(),
    read: async (_nowMs, { maxRooms = 9, size } = {}) => {
      const readGeneration = selectionGeneration
      const readPlace = selectedPlace
      const collected = await collectPublicRaw({ placeArg: readPlace, followHandle, fetchImpl: sourceFetch, drawingCache: new Map(), maxRooms, size })
      if (!collected.ok) return collected
      const result = normalizeRaw(collected.raw, maxRooms)
      if (result.ok && readGeneration === selectionGeneration) {
        lastSuccessfulRaw = collected.raw
        if (!followHandle) selectedPlace = result.target.id
      }
      return result
    },
  }
}

export async function recordPublicScene({ placeArg = 'first town', followHandle, fetchImpl = globalThis.fetch, maxRooms = 9 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('scene recorder requires a fetch implementation')
  const collected = await collectPublicRaw({ placeArg, followHandle, fetchImpl, drawingCache: new Map(), maxRooms })
  if (!collected.ok) throw new Error(collected.error)
  return {
    schemaVersion: 1,
    metadata: {
      recordedAt: new Date().toISOString(),
      origin: CITY_ORIGIN,
      requestMode: followHandle ? 'follow' : 'live',
      placeArg: followHandle ? null : placeArg,
      followHandle: followHandle ?? null,
      baseline: 'One real anonymous public GET pass. Raw response bodies are preserved below.',
      extension: 'Moments after zero must be labeled hand-authored-extension and contain only explicit response changes.',
    },
    frameTimes: [...FRAME_TIMES],
    durationMs: DURATION_MS,
    moments: [{
      atMs: 0,
      metadata: { provenance: 'recorded-public-pass' },
      raw: collected.raw,
    }],
  }
}
