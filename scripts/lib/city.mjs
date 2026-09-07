// Public, anonymous, read-only city API calls shared by `follow` and `live`.
// Every call here is a passive read: it never wakes timers, never signs in,
// and never sends a bearer secret. See SKILL.md's "Start from the live city"
// and references/public-reading.md for the contract these lean on.

import { fetchJsonSafe } from './net.mjs'

export const CITY_ORIGIN = 'https://1f3d9.com'

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
