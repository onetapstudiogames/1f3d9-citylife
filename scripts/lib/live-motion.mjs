import { layoutRooms, planRoomPlacements } from './live-layout.mjs'
import { sanitizeBubbleText } from './bubble-text.mjs'

const FRAME_MS = 125
const WALK_MS = 2_000
const BUBBLE_MS = 6_000
const RESIDENT_WIDTH = 8
const RESIDENT_HEIGHT = 4

const keyOf = (value) => String(value ?? '')
const roomKey = (value) => keyOf(value)
const residentKey = (resident) => keyOf(resident?.id)
const numberId = (value) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

const stableHash = (value) => {
  let hash = 2166136261
  for (const character of keyOf(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const intersects = (left, right) => !(
  left.x + left.width <= right.x || right.x + right.width <= left.x ||
  left.y + left.height <= right.y || right.y + right.height <= left.y
)

const expanded = (rectangle) => ({
  x: rectangle.x - 1,
  y: rectangle.y - 1,
  width: rectangle.width + 2,
  height: rectangle.height + 2,
})

const sameSize = (left, right) => (
  left?.columns === right?.columns && left?.rows === right?.rows
)

const sameRectangle = (left, right) => (
  left?.x === right?.x && left?.y === right?.y &&
  left?.width === right?.width && left?.height === right?.height
)

const normalizedSize = (size) => ({
  columns: Math.max(0, Math.floor(Number(size?.columns) || 0)),
  rows: Math.max(0, Math.floor(Number(size?.rows) || 0)),
})

const makePlans = (rooms, size, { previousPlans = [], reservedByRoom = new Map() } = {}) => {
  const boxes = layoutRooms(rooms.length, size)
  const previousByRoom = planMap(previousPlans)
  return boxes.map((box, index) => {
    const room = rooms[index]
    const previous = previousByRoom.get(roomKey(room.id))
    const preferences = previous && sameRectangle(previous.box, box) ? {
      preferredResidents: previous.residents,
      reservedResidents: reservedByRoom.get(roomKey(room.id)) ?? [],
    } : {}
    return { roomId: room.id, focusResidentId: room.focusResidentId, ...planRoomPlacements(room, box, preferences) }
  })
}

const basePoses = (plans) => plans.flatMap((plan) => plan.residents.map((placement) => ({
  resident: placement.item,
  roomId: plan.roomId,
  x: placement.x,
  y: placement.y,
  width: RESIDENT_WIDTH,
  height: RESIDENT_HEIGHT,
  opacity: 1,
})))

const poseMap = (poses) => new Map(poses.map((pose) => [residentKey(pose.resident), pose]))
const handleMap = (poses) => new Map(poses.map((pose) => [keyOf(pose.resident.handle), pose]))
const planMap = (plans) => new Map(plans.map((plan) => [roomKey(plan.roomId), plan]))

const poseFits = (candidate, plan, otherPoses) => {
  if (!plan) return false
  const inner = {
    x: plan.box.x + 1,
    y: plan.box.y + 1,
    width: Math.max(0, plan.box.width - 2),
    height: Math.max(0, plan.box.height - 2 - (plan.focusResidentId != null ? 1 : 0)),
  }
  if (
    candidate.x < inner.x || candidate.y < inner.y ||
    candidate.x + candidate.width > inner.x + inner.width ||
    candidate.y + candidate.height > inner.y + inner.height ||
    intersects(candidate, plan.aisle)
  ) return false
  if (plan.things.some((thing) => intersects(expanded(candidate), thing))) return false
  if (otherPoses.some((pose) => residentKey(pose.resident) !== residentKey(candidate.resident) && intersects(expanded(candidate), pose))) return false
  return plan.residents
    .filter((placement) => residentKey(placement.item) !== residentKey(candidate.resident))
    .every((placement) => !intersects(candidate, placement.feeder))
}

const applyOffsets = (bases, offsets, plans) => {
  const byPlan = planMap(plans)
  const result = []
  const nextOffsets = new Map()
  for (let index = 0; index < bases.length; index += 1) {
    const base = bases[index]
    const offset = offsets.get(residentKey(base.resident)) ?? { x: 0, y: 0, roomId: base.roomId }
    const candidate = {
      ...base,
      x: base.x + (roomKey(offset.roomId) === roomKey(base.roomId) ? offset.x : 0),
      y: base.y + (roomKey(offset.roomId) === roomKey(base.roomId) ? offset.y : 0),
    }
    const blockers = [...result, ...bases.slice(index + 1)]
    const kept = poseFits(candidate, byPlan.get(roomKey(base.roomId)), blockers) ? candidate : base
    result.push(kept)
    nextOffsets.set(residentKey(base.resident), {
      x: kept.x - base.x,
      y: kept.y - base.y,
      roomId: base.roomId,
    })
  }
  return { poses: result, offsets: nextOffsets }
}

const maxRecordId = (records) => records.reduce((maximum, record) => {
  const id = numberId(record?.id)
  return id === null ? maximum : Math.max(maximum, id)
}, 0)

const validMove = (event, cursor) => {
  const id = numberId(event?.id)
  const from = numberId(event?.detail?.from_place_id)
  const to = numberId(event?.detail?.to_place_id)
  return id !== null && id > cursor && event.kind === 'action' &&
    ['move', 'go_home'].includes(event.detail?.action) && event.detail?.status === 'applied' &&
    typeof event.actor === 'string' && event.actor.length > 0 &&
    from !== null && to !== null && from !== to
}

const compareRecordIds = (left, right) => (numberId(left.id) ?? 0) - (numberId(right.id) ?? 0)

const integerLine = (start, end) => {
  const values = []
  const direction = Math.sign(end - start)
  for (let value = start; value !== end; value += direction) values.push(value)
  values.push(end)
  return values
}

const pathBetween = (start, end, aisleY) => {
  const points = []
  for (const y of integerLine(start.y, aisleY)) points.push({ x: start.x, y })
  for (const x of integerLine(start.x, end.x).slice(1)) points.push({ x, y: aisleY })
  for (const y of integerLine(aisleY, end.y).slice(1)) points.push({ x: end.x, y })
  return points
}

const doorAnchor = (door) => ({
  x: door.side === 'right' ? door.x - RESIDENT_WIDTH + 1 : door.x,
  y: door.y,
})

const activeDoor = (plan, side) => ({ roomId: plan.roomId, side, ...plan.doors[side] })

const feederForPose = (pose, aisle) => ({
  x: pose.x,
  y: Math.min(pose.y, aisle.y),
  width: pose.width,
  height: Math.max(pose.y + pose.height, aisle.y + aisle.height) - Math.min(pose.y, aisle.y),
})

const safeHomeFits = (pose, plan, actorKey, standingPoses = []) => {
  if (!plan || intersects(pose, plan.aisle)) return false
  const inner = {
    x: plan.box.x + 1,
    y: plan.box.y + 1,
    width: plan.box.width - 2,
    height: plan.box.height - 2,
  }
  if (
    pose.x < inner.x || pose.y < inner.y ||
    pose.x + pose.width > inner.x + inner.width ||
    pose.y + pose.height > inner.y + inner.height
  ) return false
  const plannedOccupants = plan.residents.filter((entry) => residentKey(entry.item) !== actorKey)
  const currentOccupants = standingPoses.filter((entry) => (
    roomKey(entry.roomId) === roomKey(plan.roomId) && residentKey(entry.resident) !== actorKey
  ))
  const occupants = currentOccupants.length ? currentOccupants : plannedOccupants
  const blockers = [...plan.things, ...plan.overflowDots, ...occupants]
  if (blockers.some((blocker) => intersects(expanded(pose), blocker))) return false
  const feeder = feederForPose(pose, plan.aisle)
  if (blockers.some((blocker) => intersects(feeder, blocker))) return false
  return plannedOccupants.every((occupant) => !intersects(pose, occupant.feeder))
}

const syntheticHome = (plan, resident, standingPoses = []) => {
  if (!plan) return null
  const actorKey = residentKey(resident)
  const candidates = []
  const left = plan.box.x + 2
  const right = plan.box.x + plan.box.width - RESIDENT_WIDTH - 2
  const top = plan.box.y + 2
  const bottom = plan.box.y + plan.box.height - RESIDENT_HEIGHT - 2
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const pose = { resident, roomId: plan.roomId, x, y, width: RESIDENT_WIDTH, height: RESIDENT_HEIGHT, opacity: 1 }
      if (safeHomeFits(pose, plan, actorKey, standingPoses)) candidates.push(pose)
    }
  }
  candidates.sort((leftPose, rightPose) => {
    const distance = (pose) => pose.y < plan.aisle.y
      ? plan.aisle.y - (pose.y + pose.height)
      : pose.y - (plan.aisle.y + plan.aisle.height)
    return distance(leftPose) - distance(rightPose) || leftPose.y - rightPose.y || leftPose.x - rightPose.x
  })
  if (!candidates.length) return null
  return candidates[stableHash(`${actorKey}:${roomKey(plan.roomId)}`) % candidates.length]
}

const mappedPriorHome = (pose, previousPlan, currentPlan, standingPoses) => {
  if (!pose || !previousPlan || !currentPlan) return null
  const mapped = {
    ...pose,
    roomId: currentPlan.roomId,
    x: currentPlan.box.x + (pose.x - previousPlan.box.x),
    y: currentPlan.box.y + (pose.y - previousPlan.box.y),
    opacity: 1,
  }
  return safeHomeFits(mapped, currentPlan, residentKey(pose.resident), standingPoses) ? mapped : null
}

const sideToward = (sourceIndex, destinationIndex, sourceId, destinationId) => {
  if (sourceIndex !== null && destinationIndex !== null && sourceIndex !== destinationIndex) {
    return destinationIndex > sourceIndex ? 'right' : 'left'
  }
  const sourceNumber = numberId(sourceId)
  const destinationNumber = numberId(destinationId)
  if (sourceNumber !== null && destinationNumber !== null && sourceNumber !== destinationNumber) {
    return destinationNumber > sourceNumber ? 'right' : 'left'
  }
  return stableHash(`${sourceId}:${destinationId}`) % 2 ? 'right' : 'left'
}

const routeFor = ({ event, resident, sourcePose, destinationPose, currentPlans, startMs }) => {
  const currentByRoom = planMap(currentPlans)
  const sourcePlan = currentByRoom.get(roomKey(event.detail.from_place_id))
  const destinationPlan = currentByRoom.get(roomKey(event.detail.to_place_id))
  const currentIndexes = new Map(currentPlans.map((plan, index) => [roomKey(plan.roomId), index]))
  const sourceIndex = currentIndexes.get(roomKey(event.detail.from_place_id)) ?? null
  const destinationIndex = currentIndexes.get(roomKey(event.detail.to_place_id)) ?? null
  const sourceVisible = Boolean(sourcePose && sourcePlan)
  const destinationVisible = Boolean(destinationPose && destinationPlan)
  if (!sourceVisible && !destinationVisible) return null

  const sourceSide = sideToward(sourceIndex, destinationIndex, event.detail.from_place_id, event.detail.to_place_id)
  const destinationSide = sourceSide === 'right' ? 'left' : 'right'
  const common = {
    id: numberId(event.id),
    actorKey: residentKey(resident),
    resident,
    fromRoomId: event.detail.from_place_id,
    toRoomId: event.detail.to_place_id,
    sourcePose,
    destinationPose,
    startMs,
    endMs: startMs + WALK_MS,
  }

  if (sourceVisible && destinationVisible && Math.abs(sourceIndex - destinationIndex) === 1) {
    return {
      ...common,
      mode: 'adjacent',
      path: pathBetween(sourcePose, destinationPose, sourcePlan.aisle.y),
      sourceDoor: activeDoor(sourcePlan, sourceSide),
      destinationDoor: activeDoor(destinationPlan, destinationSide),
    }
  }
  if (sourceVisible && destinationVisible) {
    const sourceDoor = activeDoor(sourcePlan, sourceSide)
    const destinationDoor = activeDoor(destinationPlan, destinationSide)
    return {
      ...common,
      mode: 'split',
      sourcePath: pathBetween(sourcePose, doorAnchor(sourceDoor), sourcePlan.aisle.y),
      destinationPath: pathBetween(doorAnchor(destinationDoor), destinationPose, destinationPlan.aisle.y),
      sourceDoor,
      destinationDoor,
    }
  }
  if (sourceVisible) {
    const sourceDoor = activeDoor(sourcePlan, sourceSide)
    return {
      ...common,
      mode: 'out',
      sourcePath: pathBetween(sourcePose, doorAnchor(sourceDoor), sourcePlan.aisle.y),
      sourceDoor,
    }
  }
  const destinationDoor = activeDoor(destinationPlan, destinationSide)
  return {
    ...common,
    mode: 'in',
    destinationPath: pathBetween(doorAnchor(destinationDoor), destinationPose, destinationPlan.aisle.y),
    destinationDoor,
  }
}

const pointOn = (path, progress) => {
  const index = Math.min(path.length - 1, Math.floor(Math.max(0, Math.min(1, progress)) * path.length))
  return path[index]
}

const walkingPose = (walk, nowMs) => {
  const elapsed = nowMs - walk.startMs
  if (elapsed < 0) return { ...walk.sourcePose, resident: walk.resident }
  if (elapsed >= WALK_MS) return null
  const makePose = (point, roomId, opacity = 1) => ({
    resident: walk.resident,
    roomId,
    x: point.x,
    y: point.y,
    width: RESIDENT_WIDTH,
    height: RESIDENT_HEIGHT,
    opacity,
  })

  if (walk.mode === 'adjacent') {
    return makePose(pointOn(walk.path, elapsed / WALK_MS), elapsed < WALK_MS / 2 ? walk.fromRoomId : walk.toRoomId)
  }
  if (walk.mode === 'out') {
    const endpoint = walk.sourcePath.at(-1)
    if (elapsed < 1_750) return makePose(pointOn(walk.sourcePath, elapsed / 1_750), walk.fromRoomId)
    return makePose(endpoint, walk.fromRoomId, elapsed < 1_875 ? 0.5 : 0.25)
  }
  if (walk.mode === 'in') {
    const endpoint = walk.destinationPath[0]
    if (elapsed < 125) return makePose(endpoint, walk.toRoomId, 0.25)
    if (elapsed < 250) return makePose(endpoint, walk.toRoomId, 0.5)
    return makePose(pointOn(walk.destinationPath, (elapsed - 250) / 1_750), walk.toRoomId)
  }
  if (elapsed < 625) return makePose(pointOn(walk.sourcePath, elapsed / 625), walk.fromRoomId)
  if (elapsed < 750) return makePose(walk.sourcePath.at(-1), walk.fromRoomId, 0.5)
  if (elapsed < 875) return makePose(walk.sourcePath.at(-1), walk.fromRoomId, 0.25)
  if (elapsed < 1_125) return null
  if (elapsed < 1_250) return makePose(walk.destinationPath[0], walk.toRoomId, 0.25)
  if (elapsed < 1_375) return makePose(walk.destinationPath[0], walk.toRoomId, 0.5)
  return makePose(pointOn(walk.destinationPath, (elapsed - 1_375) / 625), walk.toRoomId)
}

const doorsForWalk = (walk, nowMs) => {
  const elapsed = nowMs - walk.startMs
  if (elapsed < 0 || elapsed >= WALK_MS) return []
  if (walk.mode === 'adjacent') return [walk.sourceDoor, walk.destinationDoor]
  if (walk.mode === 'out') return [walk.sourceDoor]
  if (walk.mode === 'in') return [walk.destinationDoor]
  if (elapsed < 875) return [walk.sourceDoor]
  if (elapsed >= 1_125) return [walk.destinationDoor]
  return []
}

const nextBubbleEntries = (existing, records, cursor, nowMs, poses) => {
  const byHandle = handleMap(poses)
  const entries = [...existing]
  const roomEnds = new Map()
  for (const entry of entries) roomEnds.set(roomKey(entry.roomId), Math.max(roomEnds.get(roomKey(entry.roomId)) ?? nowMs, entry.endMs))
  for (const record of [...records].sort(compareRecordIds)) {
    const id = numberId(record?.id)
    if (id === null || id <= cursor || typeof record.author !== 'string') continue
    const authorPose = byHandle.get(record.author)
    if (!authorPose || roomKey(authorPose.roomId) !== roomKey(record.place_id)) continue
    const text = sanitizeBubbleText(record.body)
    if (!text) continue
    const room = roomKey(record.place_id)
    const startMs = Math.max(nowMs, roomEnds.get(room) ?? nowMs)
    const entry = {
      noteId: record.id,
      roomId: record.place_id,
      residentId: authorPose.resident.id,
      text,
      startMs,
      endMs: startMs + BUBBLE_MS,
    }
    entries.push(entry)
    roomEnds.set(room, entry.endMs)
  }
  return entries
}

const driftInterval = (seed, ordinal) => 2_000 + (stableHash(`${seed}:interval:${ordinal}`) % 2_001)

const driftOnce = (state, atMs) => {
  if (state.walks.some((walk) => atMs < walk.endMs)) return state.offsets
  const bases = basePoses(state.plans)
  const current = applyOffsets(bases, state.offsets, state.plans).poses
  const ordered = [...current].sort((left, right) => residentKey(left.resident).localeCompare(residentKey(right.resident)))
  if (!ordered.length) return state.offsets
  const start = stableHash(`${state.seed}:resident:${state.driftOrdinal}`) % ordered.length
  const candidates = [...ordered.slice(start), ...ordered.slice(0, start)]
  const directions = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]
  const plans = planMap(state.plans)
  const basesById = poseMap(bases)

  for (const candidate of candidates) {
    const id = residentKey(candidate.resident)
    const base = basesById.get(id)
    const offset = state.offsets.get(id) ?? { x: 0, y: 0, roomId: candidate.roomId }
    const directionStart = stableHash(`${state.seed}:direction:${state.driftOrdinal}:${id}`) % directions.length
    for (const direction of [...directions.slice(directionStart), ...directions.slice(0, directionStart)]) {
      const nextOffset = { x: offset.x + direction.x, y: offset.y + direction.y, roomId: candidate.roomId }
      if (Math.abs(nextOffset.x) > 2 || Math.abs(nextOffset.y) > 2) continue
      const moved = { ...candidate, x: base.x + nextOffset.x, y: base.y + nextOffset.y }
      if (!poseFits(moved, plans.get(roomKey(candidate.roomId)), current)) continue
      const offsets = new Map(state.offsets)
      offsets.set(id, nextOffset)
      return offsets
    }
  }
  return state.offsets
}

const advanceDrift = (state, nowMs) => {
  let offsets = state.offsets
  let nextDriftAt = state.nextDriftAt
  let driftOrdinal = state.driftOrdinal
  while (nextDriftAt <= nowMs) {
    const drifted = driftOnce({ ...state, offsets, driftOrdinal }, nextDriftAt)
    offsets = drifted
    driftOrdinal += 1
    nextDriftAt += driftInterval(state.seed, driftOrdinal)
  }
  return { offsets, nextDriftAt, driftOrdinal }
}

const buildFrame = (state, nowMs) => {
  const standing = applyOffsets(basePoses(state.plans), state.offsets, state.plans).poses
  const activeOrFutureByActor = new Map()
  for (const walk of state.walks) {
    if (walk.endMs <= nowMs) continue
    if (!activeOrFutureByActor.has(walk.actorKey)) activeOrFutureByActor.set(walk.actorKey, walk)
  }
  const residents = standing.filter((entry) => !activeOrFutureByActor.has(residentKey(entry.resident)))
  const activeWalks = state.walks.filter((walk) => walk.startMs <= nowMs && nowMs < walk.endMs)
  const futureWalks = state.walks.filter((walk) => nowMs < walk.startMs)
  for (const walk of activeWalks) {
    const next = walkingPose(walk, nowMs)
    if (next) residents.push(next)
  }
  for (const walk of futureWalks) {
    if (activeOrFutureByActor.get(walk.actorKey) !== walk || !walk.sourcePose) continue
    residents.push({ ...walk.sourcePose, resident: walk.resident })
  }

  const visible = poseMap(residents)
  const bubbles = state.bubbles
    .filter((entry) => entry.startMs <= nowMs && nowMs < entry.endMs)
    .filter((entry) => roomKey(visible.get(keyOf(entry.residentId))?.roomId) === roomKey(entry.roomId))
    .map(({ startMs: _startMs, endMs: _endMs, ...entry }) => entry)
  return {
    residents,
    bubbles,
    plans: state.plans,
    doors: activeWalks.flatMap((walk) => doorsForWalk(walk, nowMs)),
  }
}

const frameSignature = (frame) => JSON.stringify({
  residents: frame.residents.map((pose) => [residentKey(pose.resident), roomKey(pose.roomId), pose.x, pose.y, pose.opacity]),
  bubbles: frame.bubbles.map((bubble) => [bubble.noteId, bubble.roomId, bubble.residentId, bubble.text]),
  doors: frame.doors.map((door) => [door.roomId, door.side]),
  plans: frame.plans.map((plan) => [
    plan.roomId, plan.box,
    plan.things.map((entry) => [entry.item.id, entry.x, entry.y]),
    plan.residents.map((entry) => [entry.item.id, entry.x, entry.y]),
  ]),
})

const nextWake = (state, nowMs) => {
  const candidates = [state.nextDriftAt]
  for (const walk of state.walks) {
    if (walk.endMs <= nowMs) continue
    candidates.push(walk.startMs <= nowMs ? Math.min(walk.endMs, nowMs + FRAME_MS) : walk.startMs)
  }
  for (const bubble of state.bubbles) {
    if (bubble.startMs > nowMs) candidates.push(bubble.startMs)
    else if (bubble.endMs > nowMs) candidates.push(bubble.endMs)
  }
  const future = candidates.filter((value) => Number.isFinite(value) && value > nowMs)
  return future.length ? Math.max(nowMs + FRAME_MS, Math.min(...future)) : null
}

const initialState = (observation, size, nowMs) => {
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const plans = makePlans(rooms, size)
  const seeded = applyOffsets(basePoses(plans), new Map(), plans)
  const seed = `${observation?.target?.id ?? ''}:${seeded.poses.map((pose) => residentKey(pose.resident)).join(',')}`
  return {
    nowMs,
    size,
    rooms,
    plans,
    offsets: seeded.offsets,
    eventCursor: maxRecordId(observation?.events ?? []),
    noteCursor: maxRecordId(observation?.notes ?? []),
    walks: [],
    bubbles: [],
    seed,
    driftOrdinal: 0,
    nextDriftAt: nowMs + driftInterval(seed, 0),
    signature: null,
  }
}

const ingestObservation = (previous, observation, size, nowMs) => {
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const previousFrame = buildFrame(previous, nowMs)
  const previousByHandle = handleMap(previousFrame.residents)
  const previousPlans = planMap(previous.plans)
  const events = Array.isArray(observation?.events) ? observation.events : []
  const notes = Array.isArray(observation?.notes) ? observation.notes : []
  const freshMoves = [...events].sort(compareRecordIds).filter((event) => validMove(event, previous.eventCursor))
  const reservedByRoom = new Map()
  for (const event of freshMoves) {
    const prior = previousByHandle.get(event.actor)
    if (!prior || roomKey(prior.roomId) !== roomKey(event.detail.from_place_id)) continue
    const room = roomKey(event.detail.from_place_id)
    const reserved = reservedByRoom.get(room) ?? []
    reserved.push({ item: prior.resident, x: prior.x, y: prior.y, width: prior.width, height: prior.height })
    reservedByRoom.set(room, reserved)
  }
  const plans = makePlans(rooms, size, { previousPlans: previous.plans, reservedByRoom })
  const currentPlans = planMap(plans)
  const planned = applyOffsets(basePoses(plans), previous.offsets, plans)
  const currentByHandle = handleMap(planned.poses)
  const walks = previous.walks.filter((walk) => walk.endMs > nowMs)
  let nextStart = walks.reduce((end, walk) => Math.max(end, walk.endMs), nowMs)
  const latestByHandle = new Map()

  for (const event of freshMoves) {
    const prior = previousByHandle.get(event.actor)
    const current = currentByHandle.get(event.actor)
    const resident = current?.resident ?? prior?.resident
    if (!resident) continue
    const sourcePlan = currentPlans.get(roomKey(event.detail.from_place_id))
    const destinationPlan = currentPlans.get(roomKey(event.detail.to_place_id))
    const chained = latestByHandle.get(event.actor)
    const sourcePose = roomKey(chained?.roomId) === roomKey(event.detail.from_place_id)
      ? chained
      : roomKey(prior?.roomId) === roomKey(event.detail.from_place_id)
        ? mappedPriorHome(prior, previousPlans.get(roomKey(prior.roomId)), sourcePlan, planned.poses) ?? syntheticHome(sourcePlan, resident, planned.poses)
        : syntheticHome(sourcePlan, resident, planned.poses)
    const destinationPose = roomKey(current?.roomId) === roomKey(event.detail.to_place_id)
      ? current
      : syntheticHome(destinationPlan, resident, planned.poses)
    const route = routeFor({
      event,
      resident,
      sourcePose,
      destinationPose,
      currentPlans: plans,
      startMs: nextStart,
    })
    if (!route) continue
    walks.push(route)
    nextStart = route.endMs
    if (destinationPose) latestByHandle.set(event.actor, destinationPose)
  }

  return {
    ...previous,
    nowMs,
    size,
    rooms,
    plans,
    offsets: planned.offsets,
    eventCursor: Math.max(previous.eventCursor, maxRecordId(events)),
    noteCursor: Math.max(previous.noteCursor, maxRecordId(notes)),
    walks,
    bubbles: nextBubbleEntries(previous.bubbles.filter((entry) => entry.endMs > nowMs), notes, previous.noteCursor, nowMs, planned.poses),
  }
}

/**
 * Pure fake-clock motion reducer. Supply an observation only when a city read
 * completes; calls between reads advance animation from `nowMs` alone.
 */
export const stepMotion = (previous, { nowMs, observation, size, reset = false } = {}) => {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError('motion nowMs must be a finite non-negative number')
  if (previous && nowMs < previous.nowMs) throw new RangeError('motion time must not move backwards')
  const nextSize = normalizedSize(size ?? previous?.size)
  if (!previous || reset) {
    if (!observation?.ok) throw new TypeError('motion initialization needs a successful observation')
    const state = initialState(observation, nextSize, nowMs)
    const frame = buildFrame(state, nowMs)
    const signature = frameSignature(frame)
    const complete = { ...state, signature }
    return { state: complete, frame, changed: true, nextAtMs: nextWake(complete, nowMs) }
  }

  const drift = advanceDrift(previous, nowMs)
  let state = {
    ...previous,
    ...drift,
    nowMs,
    walks: previous.walks.filter((walk) => walk.endMs > nowMs),
    bubbles: previous.bubbles.filter((entry) => entry.endMs > nowMs),
  }
  const resized = !sameSize(nextSize, previous.size)
  if (resized) state = { ...state, walks: [] }
  if (observation?.ok) state = ingestObservation(state, observation, nextSize, nowMs)
  else if (resized) {
    const plans = makePlans(previous.rooms, nextSize)
    const planned = applyOffsets(basePoses(plans), state.offsets, plans)
    state = { ...state, size: nextSize, plans, offsets: planned.offsets }
  }
  const frame = buildFrame(state, nowMs)
  const signature = frameSignature(frame)
  const changed = signature !== previous.signature
  const complete = { ...state, signature }
  return { state: complete, frame, changed, nextAtMs: nextWake(complete, nowMs) }
}
