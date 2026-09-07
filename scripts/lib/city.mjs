// Public, anonymous, read-only city API calls shared by `follow` and `live`.
// Every call here is a passive read: it never wakes timers, never signs in,
// and never sends a bearer secret. See SKILL.md's "Start from the live city"
// and references/public-reading.md for the contract these lean on.

import { fetchJsonSafe } from './net.mjs'

export const CITY_ORIGIN = 'https://1f3d9.com'

export const readCityJson = async (fetchImpl, path) => {
  const result = await fetchJsonSafe(`${CITY_ORIGIN}${path}`, { fetchImpl })
  return { ...result, body: result.data ?? null }
}

export const publicMarker = (value) => {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(text)) return null
  try { return BigInt(text) <= 9_223_372_036_854_775_807n ? BigInt(text).toString() : null } catch { return null }
}

export const comparePublicChanges = (left, right) => {
  const leftId = publicMarker(left?.change_id)
  const rightId = publicMarker(right?.change_id)
  if (leftId === null || rightId === null) return 0
  return BigInt(leftId) < BigInt(rightId) ? -1 : BigInt(leftId) > BigInt(rightId) ? 1 : 0
}

const responseError = (label, response) => `${label}: ${response?.error ?? `HTTP ${response?.status ?? 0}`}`

export const readPublicChangeWindow = async (fetchImpl, since) => {
  if (since === null) {
    const result = await readCityJson(fetchImpl, '/api/changes')
    const marker = publicMarker(result.body?.change_marker)
    return result.ok && marker !== null
      ? { ok: true, marker, changes: [] }
      : { ok: false, error: result.ok ? 'changes checkpoint: invalid change_marker' : responseError('changes checkpoint', result) }
  }
  const changes = []
  const seen = new Set()
  let cursor = since
  let marker = null
  do {
    if (seen.size >= 1000 || seen.has(cursor)) return { ok: false, error: 'changes: repeated or excessive next_since' }
    seen.add(cursor)
    const result = await readCityJson(fetchImpl, `/api/changes?since=${encodeURIComponent(cursor)}&limit=200`)
    if (!result.ok) return { ok: false, error: responseError('changes', result) }
    const pageMarker = publicMarker(result.body?.change_marker)
    if (pageMarker === null || BigInt(pageMarker) < BigInt(cursor) || (marker !== null && BigInt(pageMarker) < BigInt(marker)) || !Array.isArray(result.body?.changes)) return { ok: false, error: 'changes: invalid page' }
    marker = pageMarker
    for (const change of result.body.changes) {
      const id = publicMarker(change?.change_id)
      if (id === null || BigInt(id) <= BigInt(cursor) || BigInt(id) > BigInt(marker)) return { ok: false, error: 'changes: invalid change_id' }
      changes.push({ ...change, change_id: id })
    }
    if (!result.body.has_more) break
    const next = publicMarker(result.body.next_since)
    if (next === null || BigInt(next) <= BigInt(cursor) || BigInt(next) > BigInt(marker)) return { ok: false, error: 'changes: invalid next_since' }
    cursor = next
  } while (true)
  const ordered = [...new Map(changes.sort(comparePublicChanges).map(change => [change.change_id, change])).values()]
  return { ok: true, marker: marker ?? since, changes: ordered }
}

export const readCoveredAncestry = async (fetchImpl, placeId, afterMarker) => {
  const places = []
  const seen = new Set()
  let cursor = placeId
  let marker = afterMarker
  while (cursor !== null) {
    if (places.length >= 64 || seen.has(cursor)) return { ok: false, error: 'place ancestry: repeated or excessive parent chain' }
    seen.add(cursor)
    const result = await readCityJson(fetchImpl, `/api/map?view=outline&parent_id=${encodeURIComponent(cursor)}&subplace_limit=1&after_change_marker=${encodeURIComponent(afterMarker)}`)
    const covered = publicMarker(result.body?.change_marker)
    const place = result.body?.place
    if (!result.ok || covered === null || BigInt(covered) < BigInt(marker) || Number(place?.id) !== cursor) return { ok: false, error: result.ok ? 'place ancestry: invalid covered outline' : responseError(`place ${cursor}`, result) }
    places.push(place)
    marker = covered
    cursor = place.parent_id === null ? null : Number(place.parent_id)
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) return { ok: false, error: 'place ancestry: invalid parent_id' }
  }
  return { ok: true, places, marker }
}

export const mergeDirectoryPlaces = (directory, freshPlaces) => ({
  ...directory,
  places: [...new Map([...(directory?.places ?? []), ...freshPlaces].map(place => [Number(place.id), place])).values()],
})

/** A public, anonymous resident lookup: confirms a handle exists without any authentication. */
export const fetchResidentByHandle = (handle) => fetchJsonSafe(`${CITY_ORIGIN}/api/world/resident/${encodeURIComponent(handle)}`)

/**
 * Given the complete directory, build id -> {name, parentId, quiet} and a helper
 * that returns the full ancestor chain (including the id itself) for a place.
 */
export const buildDirectoryIndex = (directoryPlaces) => {
  const byId = new Map()
  for (const place of directoryPlaces ?? []) {
    byId.set(place.id, {
      id: place.id,
      parentId: place.parent_id,
      name: place.name,
      quiet: place.quiet === true,
    })
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
