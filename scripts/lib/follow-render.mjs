// Shared render logic for `follow`: one plain-text snapshot of where a
// resident is, who is around, what they said and did, and what they see.
// Every read here is public and anonymous — no sign-in, no wallet, nothing
// written back to the city.

import { fetchJsonSafe } from './net.mjs'
import { fetchEvents, fetchWorldOutline, CITY_ORIGIN } from './city.mjs'
import { eventWords } from './grid.mjs'

const fetchPresence = (handle) => fetchJsonSafe(`${CITY_ORIGIN}/api/residents?view=presence&handle=${encodeURIComponent(handle)}`)
const fetchPlace = (placeId) => fetchJsonSafe(`${CITY_ORIGIN}/api/place/${encodeURIComponent(placeId)}?view=outline&subplace_limit=1&thing_limit=1&note_limit=1`)
const fetchNote = (noteId) => fetchJsonSafe(`${CITY_ORIGIN}/api/note/${encodeURIComponent(noteId)}`)

const trim = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const renderFollowSnapshot = async (handle) => {
  const lines = []
  const now = new Date().toISOString().slice(11, 19)
  lines.push(`── ${handle} ${'─'.repeat(Math.max(1, 50 - handle.length))} ${now} UTC ──`)

  const presence = await fetchPresence(handle)
  if (!presence.ok || !presence.data?.resident) {
    lines.push(presence.status === 404 ? `No resident named "${handle}" was found.` : `Could not read ${handle}'s presence (${presence.error ?? 'unknown error'}).`)
    return lines.join('\n')
  }
  const resident = presence.data.resident
  if (resident.asleep) lines.push(`${handle} is asleep right now; their last known place is shown below.`)

  const placeResult = await fetchPlace(resident.current_place_id)
  const place = placeResult.ok ? placeResult.data.place : null
  const placeName = place?.name ?? `place #${resident.current_place_id}`
  lines.push(`Where: ${placeName} (#${resident.current_place_id})`)
  if (place?.purpose) lines.push(`   "${trim(place.purpose, 100)}"`)

  const outline = await fetchWorldOutline()
  const roster = outline.ok ? outline.data.residents ?? [] : []
  const others = roster.filter((r) => r.current_place_id === resident.current_place_id && r.handle !== handle)
  const rosterNote = outline.ok && outline.data.roster_complete === false ? ' (first page of the roster only)' : ''
  lines.push(others.length ? `Who's around: ${others.map((r) => r.handle).join(', ')}${rosterNote}` : `Who's around: nobody else, as far as this read shows${rosterNote}`)

  if (placeResult.ok) {
    lines.push(`Things here: ${placeResult.data.things_page?.total_items ?? 0}`)
    const latestNoteId = placeResult.data.notes?.[0]?.id
    const latestNoteResult = latestNoteId ? await fetchNote(latestNoteId) : null
    const latestNote = latestNoteResult?.ok ? latestNoteResult.data.note : null
    if (latestNote) {
      lines.push(`Latest note here: "${trim(latestNote.body.replace(/\s+/gu, ' '), 100)}" — ${latestNote.author}`)
    }
  }

  const eventsResult = await fetchEvents(resident.current_place_id, 20)
  const events = eventsResult.ok ? eventsResult.data.events ?? [] : []
  const placeNameById = new Map(place ? [[place.id, place.name]] : [])
  const byResident = events.filter((e) => e.actor === handle).slice(0, 5)
  lines.push('')
  lines.push(`Recent activity by ${handle}:`)
  if (byResident.length) {
    for (const event of byResident) lines.push(`  ${eventWords(event, placeNameById)}`)
  } else {
    lines.push('  (nothing in the most recent events)')
  }
  const roomEvents = events.filter((e) => e.actor !== handle).slice(0, 5)
  if (roomEvents.length) {
    lines.push('')
    lines.push('Recent activity nearby:')
    for (const event of roomEvents) lines.push(`  ${eventWords(event, placeNameById)}`)
  }

  return lines.join('\n')
}
