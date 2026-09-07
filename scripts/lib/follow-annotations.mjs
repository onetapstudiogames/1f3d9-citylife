import { sanitizeBubbleText } from './bubble-text.mjs'
import { DARK, textCells } from './grid.mjs'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const sameId = (left, right) => String(left) === String(right)
const intersects = (left, right) => left.x < right.x + right.width &&
  left.x + left.width > right.x && left.y < right.y + right.height &&
  left.y + left.height > right.y

const clippedName = (value, limit) => {
  const safe = sanitizeBubbleText(value)
  const width = textCells(safe).length
  if (!safe || limit < 1) return ''
  if (width <= limit) return safe
  if (limit === 1) return '…'

  let result = ''
  let used = 0
  for (const { segment } of segmenter.segment(safe)) {
    const segmentWidth = textCells(segment).length
    if (used + segmentWidth > limit - 1) break
    result += segment
    used += segmentWidth
  }
  return result ? `${result}…` : '…'
}

const insideRoom = (rectangle, box) => rectangle.x > box.x && rectangle.y > box.y &&
  rectangle.x + rectangle.width <= box.x + box.width - 1 &&
  rectangle.y + rectangle.height <= box.y + box.height - 1

const centeredRectangle = (anchor, box, text, y) => {
  const width = textCells(text).length
  const left = box.x + 1
  const right = box.x + box.width - width - 1
  if (width < 1 || right < left) return null
  const preferred = Math.round(anchor.x + (anchor.width / 2) - (width / 2))
  return { x: Math.max(left, Math.min(preferred, right)), y, width, height: 1 }
}

const tryPaint = (grid, text, rectangle, box, blockers, occupied) => {
  if (!rectangle || !insideRoom(rectangle, box)) return false
  if ([...blockers, ...occupied].some((blocker) => intersects(rectangle, blocker))) return false
  grid.put(rectangle.x, rectangle.y, text, DARK.muted, undefined, rectangle.width)
  occupied.push(rectangle)
  return true
}

/** Paint quiet, deterministic labels and sleep marks for a focused observation. */
export const paintAnnotations = (grid, observation, roomStates, visiblePoses, motionFrame = {}) => {
  if (!observation?.focus) return []

  const states = (roomStates ?? []).filter(({ room }) => room?.quiet !== true)
  const stateFor = (roomId) => states.find(({ room }) => sameId(room?.id, roomId))
  const poses = (visiblePoses ?? []).filter(({ roomId }) => Boolean(stateFor(roomId)))
  const carriedIds = new Set((motionFrame.effects ?? [])
    .filter(({ type }) => type === 'carry')
    .map(({ thingId }) => String(thingId)))
  const things = states.flatMap(({ room, plan }) => (plan?.things ?? [])
    .filter(({ item }) => !carriedIds.has(String(item?.id)))
    .map((placement) => ({ ...placement, roomId: room.id })))
  const allEntities = [...poses, ...things]
  const occupied = []

  for (const current of poses) {
    if (current.resident?.asleep !== true || current.walking === true) continue
    const focusedDoorWalk = sameId(current.resident?.id, observation.focus.id) &&
      (motionFrame.doors?.length ?? 0) > 0
    if (focusedDoorWalk) continue
    const currentState = stateFor(current.roomId)
    const phase = Math.max(0, Math.min(2, Math.floor(Number(motionFrame.sleepPhase) || 0)))
    const mark = ['z', 'zz', 'zzZ'][phase]
    const rectangle = centeredRectangle(current, currentState.box, mark, current.y - 1)
    tryPaint(grid, mark, rectangle, currentState.box, allEntities, occupied)
  }

  const labels = [
    ...poses.map((anchor) => ({ anchor, roomId: anchor.roomId, value: anchor.resident?.handle })),
    ...things.map((anchor) => ({ anchor, roomId: anchor.roomId, value: anchor.item?.name })),
  ]
  for (const { anchor, roomId, value } of labels) {
    const currentState = stateFor(roomId)
    const roomWidth = Math.max(0, currentState.box.width - 2)
    const text = clippedName(value, Math.min(18, roomWidth))
    const rectangle = centeredRectangle(anchor, currentState.box, text, anchor.y + anchor.height)
    tryPaint(grid, text, rectangle, currentState.box, allEntities, occupied)
  }

  return occupied
}
