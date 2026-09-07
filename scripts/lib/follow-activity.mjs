import { bubbleTextWidth, sanitizeBubbleText, wrapBubbleText } from './bubble-text.mjs'

const HISTORY_LIMIT = 200

const key = (value) => String(value ?? '')
const positiveId = (value) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
const eventId = (row) => positiveId(row?.id) ?? positiveId(row?.change_id)
const maximumEventId = (rows) => (rows ?? []).reduce((maximum, row) => Math.max(maximum, eventId(row) ?? 0), 0)
const maximumNoteId = (rows) => (rows ?? []).reduce((maximum, row) => Math.max(maximum, positiveId(row?.id) ?? 0), 0)
const safeName = (value) => sanitizeBubbleText(value)
const hasError = (detail) => detail?.error !== null && detail?.error !== undefined
const currentRoom = (observation) => (observation?.rooms ?? []).find((candidate) =>
  key(candidate?.id) === key(observation?.focus?.placeId)) ?? observation?.rooms?.[0] ?? null

const mergeKnown = (previous, observation) => {
  const residents = new Map(previous?.residents ?? [])
  const things = new Map(previous?.things ?? [])
  const places = new Map(previous?.places ?? [])
  for (const resident of [...(observation?.residents ?? []), ...(observation?.rooms ?? []).flatMap((room) => room.residents ?? [])]) {
    const id = positiveId(resident?.id)
    const name = safeName(resident?.handle)
    if (id !== null && name) residents.set(key(id), name)
  }
  for (const room of observation?.rooms ?? []) {
    const roomId = positiveId(room?.id)
    const roomName = safeName(room?.name)
    if (roomId !== null && roomName) places.set(key(roomId), roomName)
    for (const thing of room?.things ?? []) {
      const thingId = positiveId(thing?.id)
      const thingName = safeName(thing?.name)
      if (thingId !== null && thingName) things.set(key(thingId), { name: thingName, roomId })
    }
  }
  for (const row of observation?.events ?? []) {
    const thingId = positiveId(row?.thing?.id)
    const thingName = safeName(row?.thing?.name ?? row?.detail?.name)
    const roomId = positiveId(row?.thing?.place_id) ?? positiveId(row?.detail?.place_id)
    if (thingId !== null && thingName) things.set(key(thingId), { name: thingName, roomId })
  }
  return { residents: [...residents], things: [...things], places: [...places] }
}

const knownValue = (entries, id) => id === null ? null : new Map(entries).get(key(id)) ?? null
const inRoom = (roomId, currentRoomId) => roomId !== null && key(roomId) === key(currentRoomId)

const matchingCarryNotice = (row, rows) => (rows ?? []).some((notice) => {
  const action = row.detail ?? {}
  const detail = notice?.detail ?? {}
  return notice?.kind === 'thing_moved' && notice.actor === row.actor && detail.mode === 'carry' && !hasError(detail) &&
    positiveId(detail.action_id) === positiveId(action.action_id) && positiveId(detail.thing_id) === positiveId(action.thing_id) &&
    positiveId(detail.from_place_id) === positiveId(action.from_place_id) && positiveId(detail.place_id) === positiveId(action.to_place_id)
})

const actionText = (row, known, roomId, rows) => {
  const detail = row?.detail ?? {}
  const actor = safeName(row?.actor)
  if (!actor || hasError(detail)) return null
  if (row.kind === 'thing_created') {
    const thing = knownValue(known.things, positiveId(detail.thing_id))
    return thing && inRoom(positiveId(detail.place_id), roomId) ? `${actor} created ${thing.name}.` : null
  }
  if (row.kind === 'thing_withdrawn') {
    const thing = knownValue(known.things, positiveId(detail.thing_id))
    return thing && inRoom(thing.roomId, roomId) ? `${actor} withdrew ${thing.name}.` : null
  }
  if (row.kind === 'transfer' && detail.mode === 'gift' && detail.asset_type === 'thing') {
    const thing = knownValue(known.things, positiveId(detail.asset_id))
    const recipient = knownValue(known.residents, positiveId(detail.resident_id))
    return thing && recipient && inRoom(positiveId(detail.place_id), roomId)
      ? `${actor} gave ${thing.name} to ${recipient}.` : null
  }
  if (row.kind === 'transfer' && detail.mode === 'effect' && detail.type === 'thing') {
    const thing = knownValue(known.things, positiveId(detail.id))
    const recipient = knownValue(known.residents, positiveId(detail.resident_id))
    return thing && recipient && inRoom(positiveId(detail.place_id), roomId)
      ? `${actor} transferred ${thing.name} to ${recipient}.` : null
  }
  if (row.kind !== 'action' || !['applied', 'noop'].includes(detail.status)) return null
  if (detail.action === 'use') {
    const thing = knownValue(known.things, positiveId(detail.source_thing_id))
    return thing && inRoom(positiveId(detail.place_id), roomId) ? `${actor} used ${thing.name}.` : null
  }
  if (detail.action === 'consume' && detail.status === 'applied') {
    const thing = knownValue(known.things, positiveId(detail.source_thing_id))
    return thing && inRoom(positiveId(detail.place_id), roomId) ? `${actor} consumed ${thing.name}.` : null
  }
  if (detail.action === 'move' && detail.status === 'applied' && inRoom(positiveId(detail.to_place_id), roomId)) {
    const place = knownValue(known.places, positiveId(detail.to_place_id))
    if (!place) return null
    if (detail.mode === 'carry' && matchingCarryNotice(row, rows)) {
      const thing = knownValue(known.things, positiveId(detail.thing_id))
      return thing ? `${actor} carried ${thing.name} to ${place}.` : null
    }
    return `${actor} moved to ${place}.`
  }
  return null
}

const noteText = (note, fallbackAuthor) => {
  const author = safeName(note?.author ?? fallbackAuthor)
  const body = safeName(note?.body)
  return author && body ? `${author}: ${body}` : null
}

const freshEntries = (state, observation, known, roomId, switchedResident, movedRoom) => {
  if (!observation || switchedResident) return []
  const notes = new Map((observation.notes ?? []).map((row) => [key(row?.id), row]))
  const rows = [...(observation.events ?? [])]
    .filter((row) => (eventId(row) ?? 0) > state.cursor)
    .sort((left, right) => (eventId(left) ?? 0) - (eventId(right) ?? 0))
  const eventNoteIds = new Set()
  const fromEvents = rows.flatMap((row) => {
    const id = eventId(row)
    if (id === null) return []
    if (row.kind === 'note') {
      const noteId = positiveId(row.detail?.note_id)
      if (state.seenNoteIds?.includes(key(noteId))) return []
      const note = notes.get(key(noteId))
      if (!note || !inRoom(positiveId(row.detail?.place_id), roomId) || !inRoom(positiveId(note.place_id), roomId)) return []
      const text = noteText(note, row.actor)
      if (text) eventNoteIds.add(key(noteId))
      return text ? [{ id: `note:${id}`, source: 'note', text }] : []
    }
    const text = actionText(row, known, roomId, rows)
    return text ? [{ id: `event:${id}`, source: 'event', text }] : []
  })
  if (movedRoom) return fromEvents
  const noteOnly = [...notes.values()]
    .filter((note) => (positiveId(note?.id) ?? 0) > state.noteCursor &&
      !eventNoteIds.has(key(note?.id)) && inRoom(positiveId(note?.place_id), roomId))
    .sort((left, right) => positiveId(left.id) - positiveId(right.id))
    .flatMap((note) => {
      const text = noteText(note)
      const noteId = positiveId(note.id)
      return text ? [{ id: `note-record:${noteId}`, source: 'note', text }] : []
    })
  return [...fromEvents, ...noteOnly]
}

const lineOffsets = (body, lines) => {
  let cursor = 0
  return lines.map((text) => {
    const found = body.indexOf(text, cursor)
    const sourceOffset = found < 0 ? cursor : found
    cursor = sourceOffset + text.length
    while (body[cursor] === ' ') cursor += 1
    return { text, sourceOffset }
  })
}

const entryParts = (entry) => {
  if (entry.source === 'note') {
    const separator = entry.text.indexOf(': ')
    if (separator > 0) return { actor: entry.text.slice(0, separator), action: '', body: entry.text.slice(separator + 2) }
  } else {
    const match = /^(\S+)\s+(\S+)\s+(.+)$/u.exec(entry.text)
    if (match) return { actor: match[1], action: match[2], body: match[3] }
  }
  return null
}

const fittingPrefix = ({ actor, action }, columns) => {
  const full = `${actor}${action ? ` ${action}` : ''}:`
  if (bubbleTextWidth(full) + 5 <= columns) return full
  const actorInitial = [...actor][0] ?? '?'
  const compact = action ? `${actorInitial} ${[...action][0] ?? '?'}:` : `${actorInitial}:`
  return bubbleTextWidth(compact) + 5 <= columns ? compact : ''
}

const wrapEntry = (entry, columns) => {
  const direct = wrapBubbleText(entry.text, columns)
  if (direct.length <= 1) return lineOffsets(entry.text, direct)
  const parts = entryParts(entry)
  if (!parts) return lineOffsets(entry.text, direct)
  const prefix = fittingPrefix(parts, columns)
  if (!prefix) return lineOffsets(parts.body, wrapBubbleText(parts.body, columns))
  const bodyWidth = columns - bubbleTextWidth(prefix) - 1
  return lineOffsets(parts.body, wrapBubbleText(parts.body, bodyWidth))
    .map((line) => ({ ...line, text: `${prefix} ${line.text}` }))
}

const flatten = (history, columns) => history.flatMap((entry) =>
  wrapEntry(entry, columns).map((line) => ({ entryId: entry.id, ...line })))

const topAnchor = (state, lines) => {
  const maximum = Math.max(0, lines.length - state.rows)
  const offset = Math.min(state.scrollOffset, maximum)
  return lines[Math.max(0, lines.length - state.rows - offset)] ?? null
}

const anchoredOffset = (anchor, lines, rows, fallback) => {
  const maximum = Math.max(0, lines.length - rows)
  if (!anchor) return Math.min(fallback, maximum)
  let index = -1
  for (let candidate = 0; candidate < lines.length; candidate += 1) {
    const line = lines[candidate]
    if (line.entryId === anchor.entryId && line.sourceOffset <= anchor.sourceOffset) index = candidate
  }
  if (index < 0) index = lines.findIndex((line) => line.entryId === anchor.entryId)
  return index < 0 ? Math.min(fallback, maximum) : Math.min(maximum, Math.max(0, lines.length - rows - index))
}

const scrollBy = (offset, maximum, rows, command) => {
  if (command === 'home') return maximum
  if (command === 'end') return 0
  if (command === 'up') return Math.min(maximum, offset + 1)
  if (command === 'down') return Math.max(0, offset - 1)
  if (command === 'pageup') return Math.min(maximum, offset + rows)
  if (command === 'pagedown') return Math.max(0, offset - rows)
  return offset
}

const result = (state) => {
  const all = state.wrappedLines
  const maxScroll = Math.max(0, all.length - state.rows)
  const scrollOffset = Math.min(state.scrollOffset, maxScroll)
  const end = all.length - scrollOffset
  return { state: { ...state, scrollOffset }, lines: state.rows ? all.slice(Math.max(0, end - state.rows), end).map(({ text }) => text) : [], nextAtMs: null, scrollOffset, maxScroll }
}

/** Pure, deterministic reducer for the small bottom activity log. */
export const stepActivity = (previous, { nowMs, observation, columns, rows = 3, scroll } = {}) => {
  const time = Number(nowMs)
  if (!Number.isFinite(time) || time < 0) throw new TypeError('activity time must be finite and non-negative')
  if (previous && time < previous.nowMs) throw new RangeError('activity time must move forward')
  const width = Math.max(2, Math.floor(Number(columns ?? previous?.columns) || 0))
  const height = Math.max(0, Math.floor(Number(rows)))
  const roomValue = observation ? currentRoom(observation) : null
  const roomId = positiveId(observation?.focus?.placeId) ?? previous?.roomId ?? null
  const residentId = positiveId(observation?.focus?.id) ?? previous?.residentId ?? null
  const quiet = observation ? roomValue?.quiet === true : previous?.quiet === true
  const known = mergeKnown(previous?.known, observation)
  const observedCursor = maximumEventId(observation?.events)
  const observedNoteCursor = maximumNoteId(observation?.notes)
  const observedNoteIds = (observation?.notes ?? []).flatMap(note =>
    positiveId(note?.id) !== null && inRoom(positiveId(note?.place_id), roomId) ? [key(note.id)] : [])
  const rememberedNoteIds = [...new Set([...(previous?.seenNoteIds ?? []), ...observedNoteIds])]

  if (!previous) {
    const state = {
      nowMs: time, columns: width, rows: height, roomId, residentId, quiet,
      cursor: observedCursor, noteCursor: observedNoteCursor, seenNoteIds: rememberedNoteIds, known,
      history: [], wrappedLines: [], scrollOffset: 0,
    }
    return result(state)
  }

  const movedRoom = observation && key(roomId) !== key(previous.roomId)
  const switchedResident = observation && key(residentId) !== key(previous.residentId)
  const previousLines = previous.wrappedLines ?? flatten(previous.history, previous.columns)
  const anchor = previous.scrollOffset > 0 || width !== previous.columns || height !== previous.rows
    ? topAnchor(previous, previousLines) : null
  let state = { ...previous, wrappedLines: previousLines, nowMs: time, columns: width, rows: height, roomId, residentId, quiet, known }
  if (quiet || switchedResident || (previous.quiet && observation)) {
    state = {
      ...state, columns: width, cursor: Math.max(previous.cursor, observedCursor),
      noteCursor: Math.max(previous.noteCursor ?? 0, observedNoteCursor), seenNoteIds: rememberedNoteIds,
      history: [], wrappedLines: [], scrollOffset: 0,
    }
    return result(state)
  }

  const additions = freshEntries(state, observation, known, roomId, switchedResident, movedRoom)
  let enriched = []
  if (additions.length) {
    const roomName = safeName(roomValue?.name) || knownValue(known.places, roomId)
    enriched = additions.map((entry) => ({ ...entry, roomId, roomName }))
    state = { ...state, history: [...state.history, ...enriched].slice(-HISTORY_LIMIT) }
  }
  if (width !== previous.columns) {
    state = { ...state, wrappedLines: flatten(state.history, width) }
  } else if (enriched.length) {
    const retainedIds = new Set(state.history.map((entry) => entry.id))
    const retainedLines = state.wrappedLines.filter((line) => retainedIds.has(line.entryId))
    const appendedEntries = enriched.filter((entry) => retainedIds.has(entry.id))
    state = { ...state, wrappedLines: [...retainedLines, ...flatten(appendedEntries, width)] }
  }
  state = { ...state, scrollOffset: anchoredOffset(anchor, state.wrappedLines, height, previous.scrollOffset) }
  const maximum = Math.max(0, state.wrappedLines.length - height)
  state = { ...state, scrollOffset: scrollBy(state.scrollOffset, maximum, height, scroll) }
  state = {
    ...state,
    cursor: Math.max(state.cursor, observedCursor),
    noteCursor: Math.max(state.noteCursor ?? 0, observedNoteCursor),
    seenNoteIds: rememberedNoteIds,
  }
  return result(state)
}
