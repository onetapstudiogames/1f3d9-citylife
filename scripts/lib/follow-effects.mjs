const FRAME_MS = 125
const DURATIONS = Object.freeze({ puff: 900, glow: 800, crumbs: 700, gift: 1_200, transfer: 1_200 })

const positiveId = (value) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
const keyOf = (value) => String(value ?? '')
const eventId = (row) => positiveId(row?.id)
const hasError = (detail) => detail && detail.error !== null && detail.error !== undefined
const roomKey = (value) => keyOf(value)
const residentKey = (value) => keyOf(value)
const compareEvents = (left, right) => (eventId(left) ?? 0) - (eventId(right) ?? 0)
const maxEventId = (events) => events.reduce((maximum, row) => Math.max(maximum, eventId(row) ?? 0), 0)

const roomThings = (observation) => (observation?.rooms ?? []).flatMap((room) =>
  (room.things ?? []).map((item) => ({ item, roomId: room.id })))

const capturedThings = (previous, observation) => {
  const byId = new Map((previous ?? []).map((entry) => [keyOf(entry.item?.id), entry]))
  for (const row of observation?.events ?? []) {
    const thingId = positiveId(row?.thing?.id)
    if (thingId === null) continue
    const roomId = positiveId(row?.detail?.place_id) ?? positiveId(row?.detail?.to_place_id) ?? null
    byId.set(keyOf(thingId), { item: row.thing, roomId })
  }
  for (const entry of roomThings(observation)) byId.set(keyOf(entry.item?.id), entry)
  return [...byId.values()]
}

const capturedPlacements = (previous, motionFrame) => {
  const byId = new Map((previous ?? []).map((entry) => [keyOf(entry.thingId), entry]))
  for (const plan of motionFrame?.plans ?? []) {
    for (const placement of plan.things ?? []) {
      const thingId = positiveId(placement.item?.id)
      if (thingId === null) continue
      byId.set(keyOf(thingId), {
        thingId,
        roomId: plan.roomId,
        anchor: { x: placement.x, y: placement.y, width: placement.width, height: placement.height },
      })
    }
  }
  return [...byId.values()]
}

const residents = (observation) => {
  const values = [...(observation?.residents ?? []), ...(observation?.rooms ?? []).flatMap((room) => room.residents ?? [])]
  const byId = new Map()
  for (const value of values) byId.set(residentKey(value?.id), value)
  return [...byId.values()]
}

const visibleRoom = (observation, roomId) => (observation?.rooms ?? [])
  .find((room) => roomKey(room.id) === roomKey(roomId) && room.quiet !== true)

const thingRecord = (knownThings, thingId) => knownThings.find((entry) => keyOf(entry.item?.id) === keyOf(thingId))
const placementRecord = (placements, thingId) => placements.find((entry) => keyOf(entry.thingId) === keyOf(thingId))
const poseFor = (motionFrame, residentId) => (motionFrame?.residents ?? [])
  .find((pose) => residentKey(pose.resident?.id) === residentKey(residentId))

const movingResident = (activeWalks, resident) => (activeWalks ?? []).some((walk) =>
  residentKey(walk.residentId) === residentKey(resident?.id) || keyOf(walk.actor) === keyOf(resident?.handle))

const timed = (row, type, roomId, thingId, nowMs, extra = {}) => ({
  id: eventId(row),
  type,
  roomId,
  thingId,
  startedAtMs: nowMs,
  untilMs: nowMs + DURATIONS[type],
  ...extra,
})

const effectForThing = (row, type, roomId, thingId, nowMs, knownThings, placements) => {
  const known = thingRecord(knownThings, thingId)
  const placed = placementRecord(placements, thingId)
  if (!known && !placed) return null
  return timed(row, type, roomId ?? known?.roomId ?? placed?.roomId, thingId, nowMs, {
    thing: known?.item ?? null,
    anchor: placed?.anchor ?? null,
  })
}

const simpleThingEffect = (row, nowMs, observation, knownThings, placements) => {
  const detail = row?.detail ?? {}
  if (row?.kind === 'thing_created') {
    const thingId = positiveId(detail.thing_id)
    const roomId = positiveId(detail.place_id)
    if (thingId !== null && roomId !== null && visibleRoom(observation, roomId)) {
      return effectForThing(row, 'puff', roomId, thingId, nowMs, knownThings, placements)
    }
  }
  if (row?.kind === 'action' && detail.action === 'use' && ['applied', 'noop'].includes(detail.status) && !hasError(detail)) {
    const thingId = positiveId(detail.source_thing_id)
    const roomId = positiveId(detail.place_id)
    if (thingId !== null && roomId !== null && visibleRoom(observation, roomId)) {
      return effectForThing(row, 'glow', roomId, thingId, nowMs, knownThings, placements)
    }
  }
  const withdrawnId = row?.kind === 'thing_withdrawn' ? positiveId(detail.thing_id) : null
  const consumedId = row?.kind === 'action' && detail.action === 'consume' && detail.status === 'applied' &&
    positiveId(detail.place_id) !== null && !hasError(detail)
    ? positiveId(detail.source_thing_id) : null
  const thingId = withdrawnId ?? consumedId
  if (thingId !== null) {
    const placed = placementRecord(placements, thingId)
    const roomId = positiveId(detail.place_id) ?? placed?.roomId ?? thingRecord(knownThings, thingId)?.roomId
    if (roomId !== undefined && visibleRoom(observation, roomId)) {
      return effectForThing(row, 'crumbs', roomId, thingId, nowMs, knownThings, placements)
    }
  }
  return null
}

const transferEffect = (row, nowMs, observation, motionFrame, activeWalks, knownThings) => {
  if (row?.kind !== 'transfer') return null
  const detail = row.detail ?? {}
  const type = detail.mode === 'gift' ? 'gift' : detail.mode === 'effect' ? 'transfer' : null
  const thingId = type === 'gift' && detail.asset_type === 'thing'
    ? positiveId(detail.asset_id)
    : type === 'transfer' && detail.type === 'thing' ? positiveId(detail.id) : null
  const roomId = positiveId(detail.place_id)
  const recipientId = positiveId(detail.resident_id)
  if (!type || thingId === null || roomId === null || recipientId === null || !visibleRoom(observation, roomId)) return null

  const people = residents(observation)
  const giver = people.find((person) => keyOf(person.handle).trim() === keyOf(row.actor).trim())
  const recipient = people.find((person) => residentKey(person.id) === residentKey(recipientId))
  const fromPose = giver && poseFor(motionFrame, giver.id)
  const toPose = recipient && poseFor(motionFrame, recipient.id)
  if (!giver || !recipient || !fromPose || !toPose || movingResident(activeWalks, giver) || movingResident(activeWalks, recipient)) return null
  if (roomKey(fromPose.roomId) !== roomKey(roomId) || roomKey(toPose.roomId) !== roomKey(roomId)) return null
  const known = thingRecord(knownThings, thingId)
  if (!known) return null
  return timed(row, type, roomId, thingId, nowMs, {
    thing: known.item,
    fromResidentId: giver.id,
    toResidentId: recipient.id,
  })
}

const exactCarryPair = (events, walk) => {
  const actionId = positiveId(walk.actionId)
  const thingId = positiveId(walk.thingId)
  const fromId = positiveId(walk.fromRoomId)
  const toId = positiveId(walk.toRoomId)
  if ([actionId, thingId, fromId, toId].includes(null) || !keyOf(walk.actor)) return null
  const action = events.find((row) => {
    const detail = row?.detail ?? {}
    return row.kind === 'action' && row.actor === walk.actor && detail.action === 'move' && detail.status === 'applied' &&
      detail.mode === 'carry' && !hasError(detail) && positiveId(detail.action_id) === actionId &&
      positiveId(detail.thing_id) === thingId && positiveId(detail.from_place_id) === fromId && positiveId(detail.to_place_id) === toId
  })
  const notice = events.find((row) => {
    const detail = row?.detail ?? {}
    return row.kind === 'thing_moved' && row.actor === walk.actor && detail.mode === 'carry' && !hasError(detail) &&
      positiveId(detail.action_id) === actionId && positiveId(detail.thing_id) === thingId &&
      positiveId(detail.resident_id) === positiveId(walk.residentId) &&
      positiveId(detail.from_place_id) === fromId && positiveId(detail.place_id) === toId
  })
  return action && notice ? { action, notice } : null
}

const carryEffects = (events, activeWalks, knownThings) => (activeWalks ?? []).flatMap((walk) => {
  const pair = exactCarryPair(events, walk)
  const known = pair && thingRecord(knownThings, walk.thingId)
  if (!pair || !known) return []
  const start = Number(walk.startMs)
  const end = Number(walk.endMs)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  return [{
    id: eventId(pair.action),
    type: 'carry',
    roomId: walk.fromRoomId,
    thingId: positiveId(walk.thingId),
    thing: known.item,
    carrierResidentId: positiveId(walk.residentId),
    actor: walk.actor,
    actionId: positiveId(walk.actionId),
    fromRoomId: positiveId(walk.fromRoomId),
    toRoomId: positiveId(walk.toRoomId),
    startedAtMs: start,
    untilMs: end,
  }]
})

const frameEffects = (active, nowMs) => active
  .filter((effect) => nowMs >= effect.startedAtMs && nowMs < effect.untilMs)
  .map((effect) => ({
    ...effect,
    progress: Math.max(0, Math.min(1, (nowMs - effect.startedAtMs) / Math.max(1, effect.untilMs - effect.startedAtMs))),
  }))
  .sort((left, right) => Number(left.id) - Number(right.id) || left.type.localeCompare(right.type))

const transferStillVisible = (effect, observation, motionFrame, activeWalks) => {
  if (effect.type !== 'gift' && effect.type !== 'transfer') return true
  const people = residents(observation)
  const from = people.find((person) => residentKey(person.id) === residentKey(effect.fromResidentId))
  const to = people.find((person) => residentKey(person.id) === residentKey(effect.toResidentId))
  const fromPose = poseFor(motionFrame, effect.fromResidentId)
  const toPose = poseFor(motionFrame, effect.toResidentId)
  return Boolean(from && to && fromPose && toPose &&
    roomKey(fromPose.roomId) === roomKey(effect.roomId) && roomKey(toPose.roomId) === roomKey(effect.roomId) &&
    !movingResident(activeWalks, from) && !movingResident(activeWalks, to))
}

const carryStillActive = (effect, activeWalks) => {
  if (effect.type !== 'carry') return true
  return (activeWalks ?? []).some((walk) =>
    positiveId(walk.eventId) === positiveId(effect.id) &&
    positiveId(walk.actionId) === positiveId(effect.actionId) &&
    positiveId(walk.thingId) === positiveId(effect.thingId) &&
    positiveId(walk.residentId) === positiveId(effect.carrierResidentId) &&
    positiveId(walk.fromRoomId) === positiveId(effect.fromRoomId) &&
    positiveId(walk.toRoomId) === positiveId(effect.toRoomId) &&
    keyOf(walk.actor) === keyOf(effect.actor))
}

const deferredRoomId = (row) => {
  const detail = row?.detail ?? {}
  if (row?.kind === 'thing_created' || row?.kind === 'transfer') return positiveId(detail.place_id)
  if (row?.kind === 'action' && ['use', 'consume'].includes(detail.action)) return positiveId(detail.place_id)
  return null
}

const deferredDuration = (row) => {
  if (row?.kind === 'thing_created') return DURATIONS.puff
  if (row?.kind === 'transfer') return DURATIONS.gift
  if (row?.kind === 'action' && row.detail?.action === 'use') return DURATIONS.glow
  if (row?.kind === 'action' && row.detail?.action === 'consume') return DURATIONS.crumbs
  return 0
}

const shouldDefer = (row, deferUntil) => {
  const roomId = deferredRoomId(row)
  return roomId !== null && roomKey(roomId) === roomKey(deferUntil?.roomId) && Number.isFinite(Number(deferUntil?.atMs))
}

/** Pure reducer for visual facts in the selected resident's current room. */
export const stepRoomEffects = (previous, { nowMs, observation, motionFrame, activeWalks = [], deferUntil = null }) => {
  const time = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0
  const events = [...(observation?.events ?? [])].sort(compareEvents)
  const people = observation ? residents(observation) : previous?.people ?? []
  const rooms = observation
    ? (observation.rooms ?? []).map((room) => ({ id: room.id, quiet: room.quiet === true }))
    : previous?.rooms ?? []
  const currentObservation = { residents: people, rooms }
  const knownThings = capturedThings(previous?.knownThings, observation)
  const placements = capturedPlacements(previous?.placements, motionFrame)
  if (!previous) {
    const state = { cursor: maxEventId(events), active: [], deferred: [], knownThings, placements, carryRows: [], people, rooms }
    return { state, effects: [], nextAtMs: null }
  }

  const fresh = events.filter((row) => (eventId(row) ?? 0) > previous.cursor)
  const active = (previous.active ?? []).filter((effect) =>
    effect.untilMs > time && transferStillVisible(effect, currentObservation, motionFrame, activeWalks) &&
    carryStillActive(effect, activeWalks))
  const deferred = [
    ...(previous.deferred ?? []),
    ...fresh.filter((row) => shouldDefer(row, deferUntil)).map((row) => ({
      row,
      roomId: deferredRoomId(row),
      atMs: Number(deferUntil.atMs),
    })),
  ]
  const due = deferred.filter((entry) => entry.atMs <= time && visibleRoom(currentObservation, entry.roomId))
  const remainingDeferred = deferred.filter((entry) =>
    !due.includes(entry) && time < entry.atMs + deferredDuration(entry.row))
  const immediate = fresh.filter((row) => !shouldDefer(row, deferUntil)).map((row) => ({ row, atMs: time }))
  for (const { row, atMs } of [...immediate, ...due]) {
    const effect = simpleThingEffect(row, atMs, currentObservation, knownThings, placements) ??
      transferEffect(row, atMs, currentObservation, motionFrame, activeWalks, knownThings)
    if (effect && effect.untilMs > time) active.push(effect)
  }
  const carryRows = [...(previous.carryRows ?? []), ...fresh]
    .filter((row) => ['action', 'thing_moved'].includes(row?.kind))
    .slice(-100)
  for (const carry of carryEffects(carryRows, activeWalks, knownThings)) {
    if (!active.some((effect) => effect.type === 'carry' && effect.id === carry.id && effect.thingId === carry.thingId)) active.push(carry)
  }

  const effects = frameEffects(active, time)
  const state = {
    cursor: Math.max(previous.cursor, maxEventId(events)),
    active,
    deferred: remainingDeferred,
    knownThings,
    placements,
    carryRows,
    people,
    rooms,
  }
  const nextExpiry = effects.reduce((minimum, effect) => Math.min(minimum, effect.untilMs), Number.POSITIVE_INFINITY)
  const nextDeferred = remainingDeferred.reduce((minimum, entry) => Math.min(minimum,
    entry.atMs > time ? entry.atMs : Math.min(time + FRAME_MS, entry.atMs + deferredDuration(entry.row))), Number.POSITIVE_INFINITY)
  const activeWake = Number.isFinite(nextExpiry) ? Math.min(time + FRAME_MS, nextExpiry) : Number.POSITIVE_INFINITY
  const nextWake = Math.min(activeWake, nextDeferred)
  const nextAtMs = Number.isFinite(nextWake) ? nextWake : null
  return { state, effects, nextAtMs }
}
