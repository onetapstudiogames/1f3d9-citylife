import { stepMotion } from './live-motion.mjs'
import { stepRoomEffects } from './follow-effects.mjs'
import { followActivityRows, followRoomSize } from './live-layout.mjs'
import { stepActivity } from './follow-activity.mjs'

const LEG_MS = 1000
const FRAME_MS = 125
const key = value => String(value ?? '')
const maxEvent = observation => Math.max(0, ...(observation?.events ?? []).map(event => Number(event.id) || 0))
const sameSize = (a, b) => a.columns === b.columns && a.rows === b.rows

const singleRoom = observation => ({
  ...observation,
  rooms: (observation.rooms ?? []).filter(room => key(room.id) === key(observation.focus.placeId)).slice(0, 1)
    .map(room => ({ ...room, focusResidentId: observation.focus.id })),
})

const moveChain = (state, observation) => {
  let placeId = state.observation.focus.placeId
  const chain = []
  for (const event of [...(observation.events ?? [])].sort((a, b) => Number(a.id) - Number(b.id))) {
    const detail = event.detail ?? {}
    if (Number(event.id) <= state.eventCursor || event.actor !== observation.focus.handle || event.kind !== 'action'
      || detail.action !== 'move' || detail.status !== 'applied') continue
    if (key(detail.from_place_id) !== key(placeId) || key(detail.from_place_id) === key(detail.to_place_id)) return []
    chain.push(event)
    placeId = detail.to_place_id
  }
  return key(placeId) === key(observation.focus.placeId) ? chain : []
}

const initial = (observation, size, nowMs) => {
  const motion = stepMotion(null, { observation, size: followRoomSize(size), nowMs })
  const effects = stepRoomEffects(null, { nowMs, observation, motionFrame: motion.frame })
  return {
    nowMs, size, observation, eventCursor: maxEvent(observation), motion, effects: effects.state,
    transition: null, pending: null, signature: null,
  }
}

const startTransition = (state, destination, chain, nowMs) => {
  const source = {
    ...state.observation,
    events: [chain[0]], notes: [],
    rooms: state.observation.rooms.map(room => ({
      ...room, residents: room.residents.filter(resident => key(resident.id) !== key(destination.focus.id)), notes: [],
    })),
  }
  const departure = stepMotion({ ...state.motion.state, walks: [], bubbles: [] }, {
    nowMs, size: followRoomSize(state.size), observation: source,
  })
  const newNotes = new Set(destination.events.filter(event => Number(event.id) > state.eventCursor
    && event.kind === 'note' && key(event.detail?.place_id) === key(destination.focus.placeId))
    .map(event => key(event.detail.note_id)))
  const entrySeed = stepMotion(null, {
    nowMs, size: followRoomSize(state.size), observation: {
      ...destination, events: [], notes: (destination.notes ?? []).filter(note => !newNotes.has(key(note.id))),
    },
  })
  const arrival = stepMotion(entrySeed.state, {
    nowMs, size: followRoomSize(state.size), observation: { ...destination, events: [chain.at(-1)] },
  })
  return {
    ...state,
    transition: { startMs: nowMs, endMs: nowMs + LEG_MS * 2, source, destination, departure, arrival },
    eventCursor: Math.max(state.eventCursor, maxEvent(destination)),
  }
}

const ingest = (state, observation, nowMs) => {
  if (key(state.observation.focus.placeId) === key(observation.focus.placeId)) {
    return {
      ...state, observation, eventCursor: Math.max(state.eventCursor, maxEvent(observation)),
      motion: stepMotion(state.motion.state, { nowMs, observation, size: followRoomSize(state.size) }),
    }
  }
  const chain = moveChain(state, observation)
  if (chain.length && !state.observation.rooms[0]?.quiet && !observation.rooms[0]?.quiet) {
    return startTransition(state, observation, chain, nowMs)
  }
  return initial(observation, state.size, nowMs)
}

const finishTransition = (state, nowMs) => {
  const transition = state.transition
  let next = { ...initial(transition.destination, state.size, transition.endMs), effects: state.effects }
  const bubbles = transition.arrival.state.bubbles.map(bubble => ({
    ...bubble, startMs: bubble.startMs + LEG_MS, endMs: bubble.endMs + LEG_MS,
  }))
  next = { ...next, motion: { ...next.motion, state: { ...next.motion.state, bubbles } } }
  if (state.pending) next = ingest(next, state.pending.observation, Math.max(transition.endMs, state.pending.atMs))
  if (!next.transition) next = { ...next, motion: stepMotion(next.motion.state, { nowMs, size: followRoomSize(state.size) }) }
  return next
}

const walkRecords = (state, shown) => {
  const events = state.transition?.destination.events ?? state.observation.events ?? []
  return shown.motion.state.walks
    .filter(walk => walk.startMs <= shown.motion.state.nowMs && shown.motion.state.nowMs < walk.endMs)
    .map(walk => {
      const event = events.find(row => Number(row.id) === walk.id)
      const transition = state.transition
      const spanning = transition?.departure.state.walks.some(row => row.id === walk.id)
        && transition?.arrival.state.walks.some(row => row.id === walk.id)
      const legStart = transition && !spanning && shown.observation === transition.destination
        ? transition.startMs + LEG_MS : transition?.startMs
      return {
        eventId: walk.id, actor: walk.resident.handle, residentId: walk.resident.id,
        fromRoomId: walk.fromRoomId, toRoomId: walk.toRoomId,
        startMs: legStart ?? walk.startMs,
        endMs: transition ? (spanning ? transition.endMs : legStart + LEG_MS) : walk.endMs,
        actionId: event?.detail?.action_id, thingId: event?.detail?.thing_id,
      }
    })
}

const queueObservation = (pending, incoming, atMs) => ({
  atMs,
  observation: {
    ...incoming,
    events: [...new Map([...(pending?.observation.events ?? []), ...(incoming.events ?? [])]
      .map(event => [key(event.id), event])).values()].sort((a, b) => Number(a.id) - Number(b.id)),
  },
})

const phaseFrame = (state, nowMs) => {
  const transition = state.transition
  if (!transition) return { observation: state.observation, motion: state.motion, nextAtMs: state.motion.nextAtMs }
  const departing = nowMs < transition.startMs + LEG_MS
  const elapsed = nowMs - transition.startMs - (departing ? 0 : LEG_MS)
  // Each existing two-second door leg is sampled at twice its speed. The two
  // single-room legs together last two seconds; no intermediate room is invented.
  const seed = departing ? transition.departure : transition.arrival
  const motion = stepMotion(seed.state, { nowMs: transition.startMs + elapsed * 2, size: followRoomSize(state.size) })
  return {
    observation: departing ? transition.source : transition.destination,
    motion,
    nextAtMs: Math.min(transition.endMs, nowMs + FRAME_MS),
  }
}

/** A single-room camera that follows recorded resident moves, never snapshots. */
export const stepFollowMotion = (previous, { nowMs, observation, size, reset = false } = {}) => {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError('follow time must be finite and non-negative')
  if (previous && nowMs < previous.nowMs) throw new RangeError('follow time must move forward')
  const nextSize = size ?? previous?.size
  const incoming = observation ? singleRoom(observation) : null
  const switched = incoming && key(incoming.focus.id) !== key(previous?.observation.focus.id)
  let activityState = previous?.activity ?? null
  const activityOptions = { columns: Math.max(2, nextSize.columns - 4), rows: followActivityRows(nextSize) }
  const observeArrival = transition => {
    if (!transition) return
    const atMs = transition.startMs + LEG_MS
    if (nowMs < atMs || (activityState && activityState.nowMs >= atMs)) return
    activityState = stepActivity(activityState, {
      ...activityOptions, nowMs: atMs, observation: transition.destination,
    }).state
  }
  let state
  if (!previous || reset || switched || !sameSize(nextSize, previous.size)) {
    const latest = incoming ?? previous?.pending?.observation ?? previous?.transition?.destination ?? previous?.observation
    if (!latest?.ok || !latest.focus) throw new TypeError('follow needs a successful resident observation')
    state = initial(latest, nextSize, nowMs)
  } else {
    state = { ...previous, nowMs }
    if (state.transition && incoming) state = { ...state, pending: queueObservation(state.pending, incoming, nowMs) }
    if (state.transition && nowMs >= state.transition.endMs) {
      while (state.transition && nowMs >= state.transition.endMs) {
        observeArrival(state.transition)
        state = finishTransition(state, nowMs)
      }
    }
    else if (!state.transition && incoming) state = ingest(state, incoming, nowMs)
    else if (!state.transition) state = { ...state, motion: stepMotion(state.motion.state, { nowMs, size: followRoomSize(nextSize) }) }
  }
  observeArrival(state.transition)
  const shown = phaseFrame(state, nowMs)
  const effects = stepRoomEffects(state.effects, {
    nowMs,
    observation: { ...shown.observation, events: state.transition?.destination.events ?? shown.observation.events },
    motionFrame: shown.motion.frame,
    activeWalks: walkRecords(state, shown),
    deferUntil: state.transition && shown.observation === state.transition.source
      ? { roomId: state.transition.destination.focus.placeId, atMs: state.transition.startMs + LEG_MS } : undefined,
  })
  const activity = stepActivity(activityState, {
    nowMs,
    // The departure picture borrows a future move to draw its door leg. Only
    // ingest that record when the camera reaches its real destination.
    observation: state.transition && shown.observation === state.transition.source ? undefined : shown.observation,
    ...activityOptions,
  })
  const sleeping = shown.motion.frame.residents.some(pose => pose.resident?.asleep === true)
  const frame = {
    ...shown.motion.frame, effects: effects.effects, activity: activity.lines,
    sleepPhase: sleeping ? Math.floor(nowMs / 1500) % 3 : 0,
  }
  const signature = JSON.stringify([shown.observation.target.id, frame])
  const wakes = [shown.nextAtMs, effects.nextAtMs, activity.nextAtMs, sleeping ? (Math.floor(nowMs / 1500) + 1) * 1500 : null].filter(Number.isFinite)
  return {
    state: { ...state, nowMs, signature, effects: effects.state, activity: activity.state }, observation: shown.observation, frame,
    changed: signature !== previous?.signature, nextAtMs: wakes.length ? Math.min(...wakes) : null,
  }
}
