import { sanitizeBubbleText, wrapBubbleText } from './bubble-text.mjs'

const FIRST_LINE_MS = 3_000
const LINE_MS = 2_500
const LAST_LINE_MS = 3_000
const SHORT_MESSAGE_MS = 6_000
const COMPLETED_LIMIT = 20

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

const prepare = (entry, columns, startedAtMs) => {
  const wrapped = wrapBubbleText(entry.text, columns)
  return {
    ...entry,
    wrapped,
    lineIndex: 0,
    startedAtMs,
    nextAtMs: startedAtMs + (wrapped.length <= 1 ? SHORT_MESSAGE_MS : FIRST_LINE_MS),
  }
}

const readingDelay = (current) => {
  if (current.wrapped.length <= 1) return SHORT_MESSAGE_MS
  if (current.lineIndex === 0) return FIRST_LINE_MS
  return current.lineIndex === current.wrapped.length - 1 ? LAST_LINE_MS : LINE_MS
}

const completeCurrent = (state, atMs) => {
  const [current, ...rest] = state.queue
  const completed = [...state.completed, { id: current.id, source: current.source, text: current.text, wrapped: current.wrapped }]
    .slice(-COMPLETED_LIMIT)
  return {
    ...state,
    completed,
    queue: rest.length ? [prepare(rest[0], state.columns, atMs), ...rest.slice(1)] : [],
  }
}

const advance = (input, nowMs) => {
  let state = input
  while (state.queue[0]?.nextAtMs <= nowMs) {
    const current = state.queue[0]
    if (current.lineIndex >= current.wrapped.length - 1) {
      state = completeCurrent(state, current.nextAtMs)
      continue
    }
    const lineIndex = current.lineIndex + 1
    const finalLine = lineIndex === current.wrapped.length - 1
    const advanced = { ...current, lineIndex, nextAtMs: current.nextAtMs + (finalLine ? LAST_LINE_MS : LINE_MS) }
    state = { ...state, queue: [advanced, ...state.queue.slice(1)] }
  }
  return state
}

const reflow = (state, columns, nowMs) => ({
  ...state,
  columns,
  completed: state.completed.map((entry) => ({ ...entry, wrapped: wrapBubbleText(entry.text, columns) })),
  queue: state.queue.length
    ? [prepare(state.queue[0], columns, nowMs), ...state.queue.slice(1).map((entry) => ({ ...entry, wrapped: undefined }))]
    : [],
})

const visibleLines = (state) => {
  if (state.rows === 0) return []
  const completed = state.completed.flatMap((entry) => entry.wrapped)
  const current = state.queue[0]?.wrapped.slice(0, state.queue[0].lineIndex + 1) ?? []
  return [...completed, ...current].slice(-state.rows)
}

/** Pure, deterministic reducer for the small bottom activity log. */
export const stepActivity = (previous, { nowMs, observation, columns, rows = 3 } = {}) => {
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
      cursor: observedCursor, noteCursor: observedNoteCursor, seenNoteIds: rememberedNoteIds, known, queue: [], completed: [],
    }
    return { state, lines: [], nextAtMs: null }
  }

  const movedRoom = observation && key(roomId) !== key(previous.roomId)
  const switchedResident = observation && key(residentId) !== key(previous.residentId)
  let state = { ...previous, nowMs: time, rows: height, roomId, residentId, quiet, known }
  if (quiet || switchedResident || (previous.quiet && observation)) {
    state = {
      ...state, columns: width, cursor: Math.max(previous.cursor, observedCursor),
      noteCursor: Math.max(previous.noteCursor ?? 0, observedNoteCursor), seenNoteIds: rememberedNoteIds, queue: [], completed: [],
    }
    return { state, lines: [], nextAtMs: null }
  }
  if (movedRoom) state = { ...state, queue: [], completed: [] }
  if (width !== state.columns) state = reflow(state, width, time)
  if (height > 0 && previous.rows === 0 && state.queue[0]) {
    state = {
      ...state,
      queue: [{ ...state.queue[0], nextAtMs: time + readingDelay(state.queue[0]) }, ...state.queue.slice(1)],
    }
  }
  if (height > 0) state = advance(state, time)

  const additions = freshEntries(state, observation, known, roomId, switchedResident, movedRoom)
  if (additions.length) {
    const queued = state.queue.length ? additions : [prepare(additions[0], width, time), ...additions.slice(1)]
    state = {
      ...state,
      queue: [...state.queue, ...queued],
    }
  }
  state = {
    ...state,
    cursor: Math.max(state.cursor, observedCursor),
    noteCursor: Math.max(state.noteCursor ?? 0, observedNoteCursor),
    seenNoteIds: rememberedNoteIds,
  }
  return { state, lines: visibleLines(state), nextAtMs: height > 0 ? state.queue[0]?.nextAtMs ?? null : null }
}
