const ROOM_GAP = 1
const ROOM_MARGIN = 1
const MIN_ROOM_WIDTH = 36
const ROOM_TOP = 2
const AISLE_HEIGHT = 4
const THING_WIDTH = 4
const THING_HEIGHT = 2
const RESIDENT_WIDTH = 8
const RESIDENT_HEIGHT = 4

const stableKey = (value) => String(value ?? '')
const positiveInteger = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  const text = stableKey(value)
  if (!/^[1-9]\d*$/u.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) ? number : null
}

const compareIds = (left, right) => {
  const leftNumber = positiveInteger(left.id)
  const rightNumber = positiveInteger(right.id)
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber - rightNumber
  if (leftNumber !== null && rightNumber === null) return -1
  if (leftNumber === null && rightNumber !== null) return 1
  const leftKey = stableKey(left.id)
  const rightKey = stableKey(right.id)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

const stableHash = (value) => {
  let hash = 2166136261
  for (const character of stableKey(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const intersects = (left, right) => !(
  left.x + left.width <= right.x ||
  right.x + right.width <= left.x ||
  left.y + left.height <= right.y ||
  right.y + right.height <= left.y
)

const expanded = (rectangle) => ({
  x: rectangle.x - 1,
  y: rectangle.y - 1,
  width: rectangle.width + 2,
  height: rectangle.height + 2,
})

const divideWidth = (totalWidth, count) => {
  const base = Math.floor(totalWidth / count)
  const remainder = totalWidth % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

export const visibleRoomLimit = ({ columns, rows }) => {
  const width = Math.max(0, Math.floor(Number(columns) || 0))
  const height = Math.max(0, Math.floor(Number(rows) || 0))
  const availableWidth = Math.max(0, width - (ROOM_MARGIN * 2))
  const availableHeight = Math.max(0, height - ROOM_TOP - 1)
  if (availableWidth < 4 || availableHeight < 3) return 0
  return Math.max(1, Math.floor((availableWidth + ROOM_GAP) / (MIN_ROOM_WIDTH + ROOM_GAP)))
}

/** Room boxes include their border and use top-left plus exclusive width/height. */
export const layoutRooms = (roomCount, { columns, rows }) => {
  const availableWidth = Math.max(0, Math.floor(Number(columns) || 0) - (ROOM_MARGIN * 2))
  const availableHeight = Math.max(0, Math.floor(Number(rows) || 0) - ROOM_TOP - 1)
  if (!roomCount || availableWidth < 4 || availableHeight < 3) return []
  const shownCount = Math.min(roomCount, visibleRoomLimit({ columns, rows }))
  const widths = divideWidth(availableWidth - (ROOM_GAP * (shownCount - 1)), shownCount)
  let left = ROOM_MARGIN
  return widths.map((width) => {
    const box = { x: left, y: ROOM_TOP, width, height: availableHeight }
    left += width + ROOM_GAP
    return box
  })
}

const aisleFor = (box) => ({
  x: box.x + 1,
  y: box.y + Math.floor((box.height - AISLE_HEIGHT) / 2),
  width: Math.max(0, box.width - 2),
  height: AISLE_HEIGHT,
})

const candidateOrigins = (box, width, height, aisle, nearestAisleFirst) => {
  const inner = {
    x: box.x + 1,
    y: box.y + 1,
    width: Math.max(0, box.width - 2),
    height: Math.max(0, box.height - 2),
  }
  const columns = []
  for (let x = inner.x + 1; x + width <= inner.x + inner.width - 1; x += width + 1) columns.push(x)
  const rows = []
  for (let y = inner.y + 1; y + height <= inner.y + inner.height - 1; y += height + 1) {
    const rectangle = { x: aisle.x, y, width, height }
    if (!intersects(rectangle, aisle)) rows.push(y)
  }
  if (nearestAisleFirst) rows.sort((left, right) => {
    const distance = (y) => y < aisle.y ? aisle.y - (y + height) : y - (aisle.y + aisle.height)
    return distance(left) - distance(right) || left - right
  })
  else rows.reverse()
  return rows.flatMap((y) => columns.map((x) => ({ x, y, width, height })))
}

const rotate = (items, value) => {
  if (!items.length) return items
  const offset = stableHash(value) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

const canClaim = (candidate, claims) => claims.every((claim) => !intersects(candidate, claim.margin))

const feederFor = (resident, aisle) => ({
  x: resident.x,
  y: Math.min(resident.y, aisle.y),
  width: resident.width,
  height: Math.max(resident.y + resident.height, aisle.y + aisle.height) - Math.min(resident.y, aisle.y),
})

const residentFits = (candidate, box, aisle) => (
  candidate.width === RESIDENT_WIDTH && candidate.height === RESIDENT_HEIGHT &&
  candidate.x >= box.x + 1 && candidate.y >= box.y + 1 &&
  candidate.x + candidate.width <= box.x + box.width - 1 &&
  candidate.y + candidate.height <= box.y + box.height - 1 &&
  !intersects(candidate, aisle)
)

const residentCandidatesFor = (box, aisle, id) => {
  const candidates = candidateOrigins(box, RESIDENT_WIDTH, RESIDENT_HEIGHT, aisle, true)
  const rows = [...new Set(candidates.map(({ y }) => y))]
  return rows.flatMap((y) => rotate(candidates.filter((candidate) => candidate.y === y), `${stableKey(id)}:${y}`))
}

const overflowDotsFor = (room, box) => {
  const count = Math.min(12, Math.max(0, Number(room.thingsCount) - 5))
  if (!count) return []
  const interiorLeft = box.x + 1
  const interiorWidth = Math.max(0, box.width - 2)
  const shown = Math.min(count, interiorWidth)
  const start = interiorLeft + Math.floor((interiorWidth - shown) / 2)
  return Array.from({ length: shown }, (_, index) => ({ x: start + index, y: box.y + box.height - 2, width: 1, height: 1 }))
}

/** Stable thing/resident homes with shared occupancy and a clear future walk feeder. */
export const planRoomPlacements = (room, box, { preferredResidents = [], reservedResidents = [] } = {}) => {
  const aisle = aisleFor(box)
  const doors = {
    left: { x: box.x, y: aisle.y, width: 1, height: AISLE_HEIGHT },
    right: { x: box.x + box.width - 1, y: aisle.y, width: 1, height: AISLE_HEIGHT },
  }
  const overflowDots = overflowDotsFor(room, box)
  const claims = overflowDots.map((dot) => ({ rectangle: dot, margin: expanded(dot), kind: 'dot' }))
  const actualBlockers = [...overflowDots]

  const things = []
  const thingCandidates = candidateOrigins(box, THING_WIDTH, THING_HEIGHT, aisle, false)
  for (const item of [...(room.things ?? [])].sort(compareIds).slice(0, 5)) {
    const rectangle = rotate(thingCandidates, item.id).find((candidate) => canClaim(candidate, claims))
    if (!rectangle) continue
    const placement = { item, ...rectangle }
    things.push(placement)
    claims.push({ rectangle: placement, margin: expanded(placement), kind: 'thing' })
    actualBlockers.push(placement)
  }

  const residents = []
  const reservedFeeders = []
  const claimResident = (item, rectangle, visible) => {
    if (!residentFits(rectangle, box, aisle) || !canClaim(rectangle, claims)) return false
    if (reservedFeeders.some((feeder) => intersects(rectangle, feeder))) return false
    const feeder = feederFor(rectangle, aisle)
    if (actualBlockers.some((blocker) => intersects(feeder, blocker))) return false
    const placement = { item, ...rectangle, feeder }
    if (visible) residents.push(placement)
    claims.push({ rectangle: placement, margin: expanded(placement), kind: 'resident' })
    actualBlockers.push(placement)
    reservedFeeders.push(placement.feeder)
    return true
  }

  for (const reserved of Array.isArray(reservedResidents) ? reservedResidents : []) {
    claimResident(reserved.item ?? null, {
      x: reserved.x,
      y: reserved.y,
      width: reserved.width,
      height: reserved.height,
    }, false)
  }

  const focusFirst = (left, right) => Number(stableKey(right.id) === stableKey(room.focusResidentId))
    - Number(stableKey(left.id) === stableKey(room.focusResidentId)) || compareIds(left, right)
  const orderedResidents = [...(room.residents ?? [])].sort(focusFirst)
  const residentById = new Map(orderedResidents.map((item) => [stableKey(item.id), item]))
  const retained = new Set()
  const preferredHomes = Array.isArray(preferredResidents) ? preferredResidents : []
  const focused = orderedResidents.find(item => stableKey(item.id) === stableKey(room.focusResidentId))
  if (focused && !preferredHomes.some(home => stableKey(home.item?.id) === stableKey(focused.id))) {
    const rectangle = residentCandidatesFor(box, aisle, focused.id).find(candidate => residentFits(candidate, box, aisle)
      && canClaim(candidate, claims) && !reservedFeeders.some(feeder => intersects(candidate, feeder))
      && actualBlockers.every(blocker => !intersects(feederFor(candidate, aisle), blocker)))
    if (rectangle && claimResident(focused, rectangle, true)) retained.add(stableKey(focused.id))
  }
  for (const preferred of [...preferredHomes].sort((a, b) => focusFirst(a.item ?? {}, b.item ?? {}))) {
    const item = residentById.get(stableKey(preferred.item?.id))
    if (!item || retained.has(stableKey(item.id))) continue
    if (claimResident(item, {
      x: preferred.x,
      y: preferred.y,
      width: preferred.width,
      height: preferred.height,
    }, true)) retained.add(stableKey(item.id))
  }

  for (const item of orderedResidents) {
    if (retained.has(stableKey(item.id))) continue
    const rectangle = residentCandidatesFor(box, aisle, item.id).find((candidate) => {
      if (!residentFits(candidate, box, aisle) || !canClaim(candidate, claims)) return false
      if (reservedFeeders.some((feeder) => intersects(candidate, feeder))) return false
      const feeder = feederFor(candidate, aisle)
      return actualBlockers.every((blocker) => !intersects(feeder, blocker))
    })
    if (rectangle) claimResident(item, rectangle, true)
  }

  residents.sort((left, right) => compareIds(left.item, right.item))
  return { box: { ...box }, aisle, doors, things, residents, overflowDots }
}

/** Empty-room upper bound, so the source never under-fetches a visible portrait. */
export const residentDrawingLimit = (size, roomCount) => Math.max(0,
  ...layoutRooms(roomCount, size).map((box) => candidateOrigins(box, RESIDENT_WIDTH, RESIDENT_HEIGHT, aisleFor(box), true).length),
)
