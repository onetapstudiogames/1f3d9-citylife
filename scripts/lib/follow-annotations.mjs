import { sanitizeBubbleText } from './bubble-text.mjs'
import { DARK, textCells } from './grid.mjs'
import { paintScrollingName } from './scrolling-name.mjs'

const sameId = (left, right) => String(left) === String(right)
const intersects = (left, right) => left.x < right.x + right.width &&
  left.x + left.width > right.x && left.y < right.y + right.height &&
  left.y + left.height > right.y

const insideRoom = (rectangle, box) => rectangle.x > box.x && rectangle.y > box.y &&
  rectangle.x + rectangle.width <= box.x + box.width - 1 &&
  rectangle.y + rectangle.height <= box.y + box.height - 1

const centeredRectangle = (anchor, box, width, y) => {
  const left = box.x + 1
  const right = box.x + box.width - width - 1
  if (width < 1 || right < left) return null
  const preferred = Math.round(anchor.x + (anchor.width / 2) - (width / 2))
  return { x: Math.max(left, Math.min(preferred, right)), y, width, height: 1 }
}

const tryPaint = (grid, rectangle, box, blockers, occupied, paint) => {
  if (!rectangle || !insideRoom(rectangle, box)) return false
  if (blockers.some((blocker) => intersects(rectangle, blocker))) return false
  if (occupied.some((blocker) => intersects(rectangle, {
    ...blocker,
    x: blocker.x - 1,
    width: blocker.width + 2,
  }))) return false
  paint(rectangle)
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
    const rectangle = centeredRectangle(current, currentState.box, textCells(mark).length, current.y - 1)
    tryPaint(grid, rectangle, currentState.box, allEntities, occupied,
      (target) => grid.put(target.x, target.y, mark, DARK.muted, undefined, target.width))
  }

  const labels = [
    ...poses.map((anchor) => ({ anchor, roomId: anchor.roomId, value: anchor.resident?.handle })),
    ...things.map((anchor) => ({ anchor, roomId: anchor.roomId, value: anchor.item?.name })),
  ]
  for (const { anchor, roomId, value } of labels) {
    const currentState = stateFor(roomId)
    const roomWidth = Math.max(0, currentState.box.width - 2)
    const safe = sanitizeBubbleText(value)
    const fullWidth = textCells(safe).length
    const largestWidth = Math.min(18, roomWidth, fullWidth)
    const widths = largestWidth >= 2
      ? Array.from({ length: Math.max(0, largestWidth - 1) }, (_, index) => largestWidth - index)
      : [largestWidth]
    for (const width of widths) {
      const rectangle = centeredRectangle(anchor, currentState.box, width, anchor.y + anchor.height)
      const painted = tryPaint(grid, rectangle, currentState.box, allEntities, occupied,
        (target) => paintScrollingName(grid, target.x, target.y, safe, DARK.muted, undefined,
          target.width, motionFrame.nameTimeMs))
      if (painted) break
    }
  }

  return occupied
}
