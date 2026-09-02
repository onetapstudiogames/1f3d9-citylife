// Shared data-fetching and composition for `live`. Ports mock/render.py's
// look to Node, driven by the real public city API instead of the mock's
// window.json/drawings.json fixtures. Every read is public and anonymous.

import {
  buildDirectoryIndex,
  fetchDirectory,
  fetchEvents,
  fetchNotes,
  fetchPlaceChildren,
  fetchResidentDrawing,
  fetchWorldOutline,
  pickDefaultTown,
  resolvePlaceArgument,
} from './city.mjs'
import { composeScene, DARK } from './grid.mjs'

const MAX_ROOMS = { desktop: 9, phone: 6 }
const MAX_DRAWING_FETCHES = 24

const buildCrumb = (targetId, directoryIndex) => {
  const chain = directoryIndex.ancestorsOf(targetId).slice().reverse()
  return chain.map((id) => directoryIndex.byId.get(id)?.name ?? `#${id}`).join(' › ')
}

/**
 * Resolve which place's children to display, given an optional argument.
 * Returns { id, name } or null when nothing could be resolved.
 */
export const resolveTarget = async (placeArg, { directory, outline, directoryIndex }) => {
  const explicitId = resolvePlaceArgument(placeArg, directory)
  if (explicitId !== null) {
    const known = directoryIndex.byId.get(explicitId)
    return known ? { id: explicitId, name: known.name } : { id: explicitId, name: `place #${explicitId}` }
  }
  if (placeArg) return null // an explicit place was named but not found
  const worldChildren = outline.places?.[0]?.children ?? []
  return pickDefaultTown(worldChildren, outline.residents ?? [], directoryIndex)
}

export const buildLiveScene = async (placeArg, mode) => {
  const [directoryResult, outlineResult] = await Promise.all([fetchDirectory(), fetchWorldOutline()])
  if (!directoryResult.ok || !outlineResult.ok) {
    return { ok: false, error: directoryResult.error ?? outlineResult.error ?? 'unknown error' }
  }
  const directory = directoryResult.data.places ?? []
  const outline = outlineResult.data
  const directoryIndex = buildDirectoryIndex(directory)

  const target = await resolveTarget(placeArg, { directory, outline, directoryIndex })
  if (!target) return { ok: false, error: `no place matching "${placeArg}" was found` }

  const childrenResult = await fetchPlaceChildren(target.id)
  const subplaces = childrenResult.ok ? childrenResult.data.subplaces ?? [] : []
  const roomSource = subplaces.length ? subplaces : [{ id: target.id, name: target.name, things: 0, notes: 0 }]
  const maxRooms = MAX_ROOMS[mode] ?? MAX_ROOMS.desktop
  const roomDefs = [...roomSource]
    .sort((a, b) => (b.things + b.notes) - (a.things + a.notes))
    .slice(0, maxRooms)

  const roster = outline.residents ?? []
  const residentsByRoom = new Map(roomDefs.map((r) => [r.id, roster.filter((res) => res.current_place_id === r.id)]))

  const [notesResult, eventsResult] = await Promise.all([fetchNotes(target.id, 100), fetchEvents(target.id, 8)])
  const notesByPlace = new Map()
  if (notesResult.ok) {
    for (const note of notesResult.data.notes ?? []) {
      if (!notesByPlace.has(note.place_id)) notesByPlace.set(note.place_id, [])
      notesByPlace.get(note.place_id).push(note)
    }
  }

  const drawingTargets = []
  for (const residents of residentsByRoom.values()) {
    for (const resident of residents) {
      if (resident.has_drawing && drawingTargets.length < MAX_DRAWING_FETCHES) drawingTargets.push(resident)
    }
  }
  const drawings = await Promise.all(drawingTargets.map((r) => fetchResidentDrawing(r.id)))
  const drawingById = new Map(drawingTargets.map((r, i) => [r.id, drawings[i]]))

  const rooms = roomDefs.map((room) => ({
    id: room.id,
    name: room.name,
    thingsCount: room.things ?? 0,
    residents: (residentsByRoom.get(room.id) ?? []).map((r) => ({ ...r, drawing: drawingById.get(r.id) ?? null })),
    notes: (notesByPlace.get(room.id) ?? []).slice(0, 1),
  }))

  const placeNameById = new Map(directory.map((p) => [p.id, p.name]))
  const events = eventsResult.ok ? eventsResult.data.events ?? [] : []

  const scene = composeScene({
    rooms,
    theme: DARK,
    mode,
    followedHandle: null,
    followedPlaceName: null,
    totalResidents: outlineResult.data.totals?.residents ?? roster.length,
    crumb: buildCrumb(target.id, directoryIndex),
    events,
    placeNameById,
  })

  return { ok: true, scene, target, roomCount: rooms.length }
}
