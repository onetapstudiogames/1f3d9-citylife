// Public, anonymous, read-only city API calls shared by `follow` and `live`.
// Every call here is a passive read: it never wakes timers, never signs in,
// and never sends a bearer secret. See SKILL.md's "Start from the live city"
// and references/public-reading.md for the contract these lean on.

import { fetchJsonSafe } from './net.mjs'

export const CITY_ORIGIN = 'https://1f3d9.com'

/** The complete lightweight directory: every place id/parent_id/name and every resident handle. */
export const fetchDirectory = () => fetchJsonSafe(`${CITY_ORIGIN}/api/window?view=directory`)

/** World root plus its immediate children, and a page of current residents (current_place_id, has_drawing). */
export const fetchWorldOutline = () => fetchJsonSafe(`${CITY_ORIGIN}/api/window?view=outline`)

/** One place's own record plus a page of its immediate children (with their own thing/note counts). */
export const fetchPlaceChildren = (placeId) => fetchJsonSafe(`${CITY_ORIGIN}/api/map?view=outline&parent_id=${encodeURIComponent(placeId)}`)

/** Recent notes for a place and everything nested under it. */
export const fetchNotes = (placeId, limit = 50) =>
  fetchJsonSafe(`${CITY_ORIGIN}/api/window?collection=notes&within_place_id=${encodeURIComponent(placeId)}&limit=${limit}`)

/** Recent public events, newest first. Falls back to an unscoped read if place-scoping is rejected. */
export const fetchEvents = async (placeId, limit = 8) => {
  if (placeId) {
    const scoped = await fetchJsonSafe(`${CITY_ORIGIN}/api/events?within_place_id=${encodeURIComponent(placeId)}&limit=${limit}`)
    if (scoped.ok) return scoped
  }
  return fetchJsonSafe(`${CITY_ORIGIN}/api/events?limit=${limit}`)
}

/** One resident's current drawing (palette + 64 indices), or null if undrawn/unavailable. */
export const fetchResidentDrawing = async (residentId) => {
  const result = await fetchJsonSafe(`${CITY_ORIGIN}/api/drawing/resident/${encodeURIComponent(residentId)}`)
  if (!result.ok) return null
  return result.data?.drawing ?? null
}

/** A public, anonymous resident lookup: confirms a handle exists without any authentication. */
export const fetchResidentByHandle = (handle) => fetchJsonSafe(`${CITY_ORIGIN}/api/world/resident/${encodeURIComponent(handle)}`)

/**
 * Given the complete directory, build id -> {name, parentId} and a helper
 * that returns the full ancestor chain (including the id itself) for a place.
 */
export const buildDirectoryIndex = (directoryPlaces) => {
  const byId = new Map()
  for (const place of directoryPlaces ?? []) {
    byId.set(place.id, { id: place.id, parentId: place.parent_id, name: place.name })
  }
  const ancestorsOf = (id) => {
    const chain = []
    let cursor = byId.get(id)
    let guard = 0
    while (cursor && guard < 64) {
      chain.push(cursor.id)
      if (cursor.parentId === null || cursor.parentId === undefined) break
      cursor = byId.get(cursor.parentId)
      guard += 1
    }
    return chain
  }
  return { byId, ancestorsOf }
}

/** Resolve a `place` command argument (numeric id, or a name to search for) against the directory. */
export const resolvePlaceArgument = (arg, directoryPlaces) => {
  if (arg === undefined || arg === null || arg === '') return null
  if (/^\d+$/u.test(String(arg))) return Number(arg)
  const needle = String(arg).trim().toLowerCase()
  const exact = (directoryPlaces ?? []).find((p) => p.name.toLowerCase() === needle)
  if (exact) return exact.id
  const partial = (directoryPlaces ?? []).find((p) => p.name.toLowerCase().includes(needle))
  return partial ? partial.id : null
}

/**
 * Pick the busiest place two hops below the world root (continent, then
 * town) so `live` has a sensible default when no place is named. Uses only
 * the current resident page already fetched with the outline, so population
 * counts can undercount when the roster is paged.
 */
export const pickDefaultTown = async (worldChildren, residents, directoryIndex) => {
  const populationOf = (rootId) => {
    let count = 0
    for (const resident of residents) {
      const chain = directoryIndex.ancestorsOf(resident.current_place_id)
      if (chain.includes(rootId)) count += 1
    }
    return count
  }
  if (!worldChildren.length) return null
  const busiestContinent = [...worldChildren].sort((a, b) => populationOf(b.id) - populationOf(a.id))[0]
  const childrenResult = await fetchPlaceChildren(busiestContinent.id)
  const towns = childrenResult.ok ? childrenResult.data.subplaces ?? [] : []
  if (!towns.length) return { id: busiestContinent.id, name: busiestContinent.name }
  const busiestTown = [...towns].sort((a, b) => populationOf(b.id) - populationOf(a.id))[0]
  return { id: busiestTown.id, name: busiestTown.name, continentName: busiestContinent.name }
}
