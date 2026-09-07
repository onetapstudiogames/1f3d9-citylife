import { DARK, Grid } from './grid.mjs'
import { bubbleTextWidth, sanitizeBubbleText, wrapBubbleText } from './bubble-text.mjs'
import { paintAnnotations } from './follow-annotations.mjs'
import { paintScrollingName } from './scrolling-name.mjs'
import {
  blendHex,
  cellPixels,
  compositeCell,
  drawingPixels,
  floorPixels,
  pixelsToCell,
  shrinkDrawingPixels,
  standInPixels,
  wallTone,
} from './live-drawing.mjs'
import {
  layoutRooms,
  followActivityRows,
  followRoomSize,
  planRoomPlacements,
  residentDrawingLimit,
  visibleRoomLimit,
} from './live-layout.mjs'

export { residentDrawingLimit, visibleRoomLimit }

const THING_STANDIN_PIXELS = [
  [null, DARK.muted, DARK.muted, null],
  [DARK.muted, DARK.muted, DARK.muted, DARK.muted],
  [DARK.muted, DARK.muted, DARK.muted, DARK.muted],
  [DARK.muted, null, null, DARK.muted],
]

const intersects = (left, right) => !(
  left.x + left.width <= right.x ||
  right.x + right.width <= left.x ||
  left.y + left.height <= right.y ||
  right.y + right.height <= left.y
)

const sameId = (left, right) => String(left ?? '') === String(right ?? '')

const paintFloor = (grid, room, box) => {
  const tile = floorPixels(room.drawing, DARK.room)
  for (let y = box.y + 1; y < box.y + box.height - 1; y += 1) {
    for (let x = box.x + 1; x < box.x + box.width - 1; x += 1) {
      const tileColumn = (x - box.x - 1) % 8
      const tileRow = ((y - box.y - 1) * 2) % 8
      grid.cells[y][x] = pixelsToCell(tile[tileRow][tileColumn], tile[tileRow + 1][tileColumn], DARK.room)
    }
  }
}

const drawRoomBox = (grid, room, box, color, nameTimeMs) => {
  const { x, y, width, height } = box
  grid.put(x, y, `╭${'─'.repeat(Math.max(0, width - 2))}╮`, color, DARK.room)
  for (let row = y + 1; row < y + height - 1; row += 1) {
    grid.put(x, row, '│', color, DARK.room)
    grid.put(x + width - 1, row, '│', color, DARK.room)
  }
  grid.put(x, y + height - 1, `╰${'─'.repeat(Math.max(0, width - 2))}╯`, color, DARK.room)
  if (width >= 5) {
    const nameWidth = Math.min(bubbleTextWidth(room.name), Math.max(0, width - 6))
    grid.put(x + 2, y, ' '.repeat(nameWidth + 2), color, DARK.room, width - 4)
    paintScrollingName(grid, x + 3, y, room.name, color, DARK.room, nameWidth, nameTimeMs)
  }
}

const overlayPixels = (grid, x, y, pixels, opacity = 1) => {
  const requestedAlpha = Number(opacity)
  const alpha = Number.isFinite(requestedAlpha) ? Math.max(0, Math.min(1, requestedAlpha)) : 1
  if (alpha === 0) return
  for (let row = 0; row < Math.ceil(pixels.length / 2); row += 1) {
    for (let column = 0; column < (pixels[0]?.length ?? 0); column += 1) {
      const top = pixels[row * 2]?.[column] ?? null
      const bottom = pixels[(row * 2) + 1]?.[column] ?? null
      if (top === null && bottom === null) continue
      const targetY = y + row
      const targetX = x + column
      if (targetY < 0 || targetY >= grid.height || targetX < 0 || targetX >= grid.width) continue
      const target = grid.cells[targetY][targetX]
      const [underTop, underBottom] = cellPixels(target)
      const fadedTop = top === null || alpha === 1 ? top : blendHex(top, underTop ?? DARK.bg, 1 - alpha)
      const fadedBottom = bottom === null || alpha === 1 ? bottom : blendHex(bottom, underBottom ?? DARK.bg, 1 - alpha)
      grid.cells[targetY][targetX] = compositeCell(target, fadedTop, fadedBottom)
    }
  }
}

const paintRoomBase = (grid, room, box, placements, carriedThingIds = new Set(), nameTimeMs = 0) => {
  grid.fill(box.x, box.y, box.width, box.height, DARK.room)
  if (room.quiet === true) {
    for (let y = box.y + 1; y < box.y + box.height - 1; y += 1) {
      for (let x = box.x + 1; x < box.x + box.width - 1; x += 1) {
        grid.put(x, y, (x + y) % 2 === 0 ? '▒' : '░', DARK.muted, DARK.room)
      }
    }
    drawRoomBox(grid, room, box, DARK.muted, nameTimeMs)
    return
  }
  paintFloor(grid, room, box)
  drawRoomBox(grid, room, box, wallTone(room.drawing, DARK.muted), nameTimeMs)

  for (const placement of placements.things) {
    if (carriedThingIds.has(String(placement.item?.id))) continue
    overlayPixels(grid, placement.x, placement.y, placement.item.drawing
      ? shrinkDrawingPixels(placement.item.drawing)
      : THING_STANDIN_PIXELS)
  }
  for (const dot of placements.overflowDots) grid.put(dot.x, dot.y, '·', DARK.muted)
}

const rotatePixels = (pixels) => Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 8 }, (_, column) => pixels[7 - column]?.[row] ?? null))

const residentPixels = (resident, sleepEnabled) => {
  const pixels = resident?.drawing ? drawingPixels(resident.drawing) : standInPixels(DARK.muted)
  return sleepEnabled && resident?.asleep === true ? rotatePixels(pixels) : pixels
}

const thingPixels = (thing) => thing?.drawing ? shrinkDrawingPixels(thing.drawing) : THING_STANDIN_PIXELS

const effectAnchor = (effect, roomStates) => {
  if (effect.anchor) return effect.anchor
  const state = roomStates.find(({ room }) => sameId(room.id, effect.roomId))
  return state?.plan.things.find((placement) => sameId(placement.item?.id, effect.thingId)) ?? null
}

const residentPose = (poses, residentId) => poses.find((pose) => sameId(pose.resident?.id, residentId))

const paintSpark = (grid, anchor, character) => {
  const points = [
    [anchor.x - 1, anchor.y],
    [anchor.x + anchor.width, anchor.y],
    [anchor.x - 1, anchor.y + anchor.height - 1],
    [anchor.x + anchor.width, anchor.y + anchor.height - 1],
  ]
  for (const [x, y] of points) grid.put(x, y, character, DARK.hi)
}

const ACTIVITY_MARKS = Object.freeze({
  note: '≡',
  change: '∆', make: '✦', home: '⌂', agreement: '≈', trade: '↔', rules: '§',
  effect: '⁕', wait: '·', attempt: '?', departure: '‹', arrival: '›', action: '•',
})

const activityMarkPosition = (effect, state, poses, reserved) => {
  const anchor = effectAnchor(effect, [state]) ?? residentPose(poses, effect.residentId)
  const candidates = anchor ? [
    [anchor.x - 1, anchor.y], [anchor.x + anchor.width, anchor.y],
    [anchor.x - 1, anchor.y + anchor.height - 1], [anchor.x + anchor.width, anchor.y + anchor.height - 1],
  ] : []
  const fallback = []
  for (let y = state.box.y + state.box.height - 2; y > state.box.y; y -= 1) {
    for (let x = state.box.x + state.box.width - 2; x > state.box.x; x -= 1) fallback.push([x, y])
  }
  candidates.push(...fallback)
  const occupied = [
    ...(state.plan.things ?? []),
    ...poses.filter((pose) => sameId(pose.roomId, state.room.id)),
  ]
  return candidates.find(([x, y]) => x > state.box.x && x < state.box.x + state.box.width - 1 &&
    y > state.box.y && y < state.box.y + state.box.height - 1 &&
    !reserved.has(`${x}:${y}`) &&
    !occupied.some((rectangle) => intersects({ x, y, width: 1, height: 1 }, rectangle)))
}

const paintEffects = (grid, effects, roomStates, poses) => {
  const activityPositions = new Set()
  for (const effect of effects ?? []) {
    if (effect.type === 'carry') {
      const carrier = residentPose(poses, effect.carrierResidentId)
      const state = carrier && roomStates.find(({ room }) => sameId(room.id, carrier.roomId))
      if (!carrier || !state || state.room.quiet === true) continue
      const x = Math.max(state.box.x + 1, Math.min(carrier.x + carrier.width - 2, state.box.x + state.box.width - 5))
      const y = Math.max(state.box.y + 1, Math.min(carrier.y + 1, state.box.y + state.box.height - 3))
      overlayPixels(grid, x, y, thingPixels(effect.thing), 0.9)
      continue
    }
    const state = roomStates.find(({ room }) => sameId(room.id, effect.roomId))
    if (!state || state.room.quiet === true) continue
    if (effect.type === 'activity') {
      const point = activityMarkPosition(effect, state, poses, activityPositions)
      if (point) {
        activityPositions.add(`${point[0]}:${point[1]}`)
        grid.put(point[0], point[1], ACTIVITY_MARKS[effect.cue] ?? ACTIVITY_MARKS.action, DARK.hi)
      }
      continue
    }
    if (effect.type === 'glow' || effect.type === 'puff' || effect.type === 'crumbs') {
      const anchor = effectAnchor(effect, roomStates)
      if (!anchor) continue
      paintSpark(grid, anchor, effect.type === 'crumbs' ? '·' : effect.type === 'puff' ? '✦' : '•')
      continue
    }
    if (effect.type !== 'gift' && effect.type !== 'transfer') continue
    const from = residentPose(poses, effect.fromResidentId)
    const to = residentPose(poses, effect.toResidentId)
    if (!from || !to || !sameId(from.roomId, state.room.id) || !sameId(to.roomId, state.room.id)) continue
    const progress = Math.max(0, Math.min(1, Number(effect.progress) || 0))
    const rawX = Math.round((from.x + (from.width / 2)) + (((to.x + (to.width / 2)) - (from.x + (from.width / 2))) * progress) - 2)
    const rawY = Math.round((from.y + 1) + ((to.y - from.y) * progress) - (Math.sin(Math.PI * progress) * 2))
    const x = Math.max(state.box.x + 1, Math.min(rawX, state.box.x + state.box.width - 5))
    const y = Math.max(state.box.y + 2, Math.min(rawY, state.box.y + state.box.height - 3))
    overlayPixels(grid, x, y, thingPixels(effect.thing), 0.9)
    if (effect.type === 'gift') grid.put(x + 1, y - 1, '♥', DARK.hi)
  }
}

const paintFocus = (grid, focus, poses, roomStates) => {
  if (!focus) return
  const pose = residentPose(poses, focus.id)
  const state = pose && roomStates.find(({ room }) => sameId(room.id, pose.roomId))
  if (!pose || !state || state.room.quiet === true) return
  const left = Math.max(state.box.x + 1, Math.min(pose.x - 1, state.box.x + state.box.width - 2))
  const right = Math.max(state.box.x + 1, Math.min(pose.x + pose.width, state.box.x + state.box.width - 2))
  const y = Math.max(state.box.y + 1, Math.min(pose.y + 1, state.box.y + state.box.height - 2))
  grid.put(left, y, '›', DARK.hi)
  grid.put(right, y, '‹', DARK.hi)
}

const openDoor = (grid, door) => {
  const sourceX = door.side === 'left' ? door.x + 1 : door.x - 1
  for (let y = door.y; y < door.y + door.height; y += 1) {
    if (y < 0 || y >= grid.height || door.x < 0 || door.x >= grid.width || sourceX < 0 || sourceX >= grid.width) continue
    grid.cells[y][door.x] = [...grid.cells[y][sourceX]]
  }
}

const nearbyValues = (start, end, preferred) => Array.from(
  { length: Math.max(0, end - start + 1) },
  (_, index) => start + index,
).sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred) || left - right)

const bubbleCandidates = (box, author, width, height) => {
  const left = box.x + 1
  const right = box.x + box.width - width - 1
  const top = box.y + 1
  const bottom = box.y + box.height - height - 1
  if (right < left || bottom < top) return []

  const centeredX = Math.round(author.x + (author.width / 2) - (width / 2))
  const horizontal = nearbyValues(left, right, centeredX)
  const aboveY = author.y - height
  const belowY = author.y + author.height
  const candidates = []
  if (aboveY >= top) horizontal.forEach((x) => candidates.push({ x, y: aboveY, width, height, tail: 'down' }))
  if (belowY <= bottom) horizontal.forEach((x) => candidates.push({ x, y: belowY, width, height, tail: 'up' }))

  const centeredY = Math.round(author.y + (author.height / 2) - (height / 2))
  const vertical = nearbyValues(top, bottom, centeredY)
  const leftX = author.x - width
  const rightX = author.x + author.width
  if (leftX >= left) vertical.forEach((y) => candidates.push({ x: leftX, y, width, height, tail: 'right' }))
  if (rightX <= right) vertical.forEach((y) => candidates.push({ x: rightX, y, width, height, tail: 'left' }))
  return candidates
}

const drawBubble = (grid, bubble, author, box, occupied) => {
  const text = sanitizeBubbleText(bubble.text)
  const width = Math.min(Math.max(6, bubbleTextWidth(text) + 4), 52, Math.max(0, box.width - 2))
  if (width < 6) return null
  const lines = wrapBubbleText(text, width - 4)
  let candidate
  for (let rows = Math.min(3, lines.length); rows >= 1 && !candidate; rows--) {
    candidate = bubbleCandidates(box, author, width, rows + 2).find(rectangle =>
      occupied.every(blocker => !intersects(rectangle, blocker)))
  }
  if (!candidate) return null
  const shownLines = lines.slice(0, candidate.height - 2)
  if (shownLines.length < lines.length) {
    shownLines[shownLines.length - 1] = `${wrapBubbleText(shownLines.at(-1), width - 5)[0]}…`
  }

  const top = ['╭', ...Array(candidate.width - 2).fill('─'), '╮']
  const bottom = ['╰', ...Array(candidate.width - 2).fill('─'), '╯']
  const authorCenter = Math.floor(author.x + (author.width / 2))
  const tailColumn = Math.max(1, Math.min(candidate.width - 2, authorCenter - candidate.x))
  if (candidate.tail === 'down') bottom[tailColumn] = '┬'
  if (candidate.tail === 'up') top[tailColumn] = '┴'

  grid.put(candidate.x, candidate.y, top.join(''), DARK.ink, DARK.bubble, candidate.width)
  shownLines.forEach((line, index) => {
    grid.put(candidate.x, candidate.y + index + 1, `│${' '.repeat(candidate.width - 2)}│`, DARK.ink, DARK.bubble, candidate.width)
    grid.put(candidate.x + 2, candidate.y + index + 1, line, DARK.ink, DARK.bubble, candidate.width - 4)
  })
  if (candidate.tail === 'right') grid.put(candidate.x + candidate.width - 1, candidate.y + 1, '├', DARK.ink, DARK.bubble)
  if (candidate.tail === 'left') grid.put(candidate.x, candidate.y + 1, '┤', DARK.ink, DARK.bubble)
  grid.put(candidate.x, candidate.y + candidate.height - 1, bottom.join(''), DARK.ink, DARK.bubble, candidate.width)
  return candidate
}

/** Paint one deterministic live observation into the terminal's exact cell bounds. */
export const paintLiveView = (observation, { columns, rows }, motionFrame = undefined) => {
  const grid = new Grid(columns, rows, DARK.bg)
  if (grid.width === 0 || grid.height === 0) return grid

  const nameTimeMs = motionFrame?.nameTimeMs ?? 0
  paintScrollingName(grid, 1, 0, observation?.target?.name, DARK.ink, DARK.bg, Math.max(0, grid.width - 2), nameTimeMs)
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const viewSize = { columns: grid.width, rows: grid.height }
  const boxes = layoutRooms(rooms.length, observation?.focus ? followRoomSize(viewSize) : viewSize)
  const framed = motionFrame !== undefined && motionFrame !== null
  const framePlans = new Map((motionFrame?.plans ?? []).map((plan) => [String(plan.roomId), plan]))
  const roomStates = boxes.map((fallbackBox, index) => {
    const room = rooms[index]
    const framePlan = framePlans.get(String(room.id))
    const box = framePlan?.box ?? fallbackBox
    return { room, box, plan: framePlan ?? planRoomPlacements(room, box) }
  })

  const poses = framed
    ? (motionFrame.residents ?? [])
    : roomStates.flatMap(({ room, plan }) => plan.residents.map((placement) => ({
      resident: placement.item,
      roomId: room.id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      opacity: 1,
    })))
  const visiblePoses = poses.filter((pose) => roomStates.find(({ room }) => sameId(room.id, pose.roomId))?.room.quiet !== true)
  const carriedByRoom = new Map()
  for (const effect of motionFrame?.effects ?? []) {
    if (effect.type !== 'carry') continue
    const carrier = residentPose(visiblePoses, effect.carrierResidentId)
    if (!carrier) continue
    const room = String(carrier.roomId)
    const ids = carriedByRoom.get(room) ?? new Set()
    ids.add(String(effect.thingId))
    carriedByRoom.set(room, ids)
  }

  roomStates.forEach(({ room, box, plan }) => paintRoomBase(grid, room, box, plan, carriedByRoom.get(String(room.id)), nameTimeMs))
  for (const door of motionFrame?.doors ?? []) {
    const state = roomStates.find(({ room }) => sameId(room.id, door.roomId))
    if (state?.room.quiet !== true) openDoor(grid, door)
  }

  for (const pose of visiblePoses) {
    const walkingFocus = sameId(pose.resident?.id, observation?.focus?.id) &&
      (pose.walking === true || (motionFrame?.doors?.length ?? 0) > 0)
    const sleeping = Boolean(observation?.focus) && !walkingFocus
    overlayPixels(grid, pose.x, pose.y, residentPixels(pose.resident, sleeping), pose.opacity ?? 1)
  }

  paintEffects(grid, motionFrame?.effects, roomStates, visiblePoses)
  paintFocus(grid, observation?.focus, visiblePoses, roomStates)

  const bubbleRects = paintAnnotations(grid, observation, roomStates, visiblePoses, motionFrame ?? {})
  for (const bubble of motionFrame?.bubbles ?? []) {
    const author = visiblePoses.find((pose) => sameId(pose.roomId, bubble.roomId) && sameId(pose.resident?.id, bubble.residentId))
    const state = roomStates.find(({ room }) => sameId(room.id, bubble.roomId))
    if (!author || !state || state.room.quiet === true) continue
    const portraitRects = visiblePoses.filter((pose) => sameId(pose.roomId, bubble.roomId))
    const rectangle = drawBubble(grid, bubble, author, state.box, [...portraitRects, ...state.plan.things, ...bubbleRects])
    if (rectangle) bubbleRects.push(rectangle)
  }
  if (observation?.focus && rooms[0]?.quiet !== true) {
    const count = followActivityRows(viewSize)
    const lines = (motionFrame?.activity ?? []).slice(-count)
    if (count) {
      lines.forEach((line, index) => grid.put(2, grid.height - 1 - lines.length + index, line, DARK.muted, DARK.bg, Math.max(0, grid.width - 4)))
      const { offset = 0, maximum = 0 } = motionFrame?.activityScroll ?? {}
      if (maximum > 0) {
        const x = grid.width - 2
        const top = grid.height - 1 - count
        if (count === 1) grid.put(x, top, offset === 0 ? '↑' : offset >= maximum ? '↓' : '↕', DARK.muted, DARK.bg, 1)
        else {
          for (let row = 0; row < count; row++) grid.put(x, top + row, '│', DARK.muted, DARK.bg, 1)
          const thumb = Math.round((1 - Math.min(1, offset / maximum)) * (count - 1))
          grid.put(x, top + thumb, '▪', DARK.ink, DARK.bg, 1)
        }
      }
    }
  }
  return grid
}
