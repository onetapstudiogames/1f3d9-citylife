import { DARK, Grid } from './grid.mjs'
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

const bubbleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

const drawRoomBox = (grid, room, box, color) => {
  const { x, y, width, height } = box
  grid.put(x, y, `╭${'─'.repeat(Math.max(0, width - 2))}╮`, color, DARK.room)
  for (let row = y + 1; row < y + height - 1; row += 1) {
    grid.put(x, row, '│', color, DARK.room)
    grid.put(x + width - 1, row, '│', color, DARK.room)
  }
  grid.put(x, y + height - 1, `╰${'─'.repeat(Math.max(0, width - 2))}╯`, color, DARK.room)
  if (width >= 5) grid.put(x + 2, y, ` ${room.name ?? ''} `, color, DARK.room, width - 4)
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

const paintRoomBase = (grid, room, box, placements) => {
  grid.fill(box.x, box.y, box.width, box.height, DARK.room)
  paintFloor(grid, room, box)
  drawRoomBox(grid, room, box, wallTone(room.drawing, DARK.muted))

  for (const placement of placements.things) {
    overlayPixels(grid, placement.x, placement.y, placement.item.drawing
      ? shrinkDrawingPixels(placement.item.drawing)
      : THING_STANDIN_PIXELS)
  }
  for (const dot of placements.overflowDots) grid.put(dot.x, dot.y, '·', DARK.muted)
}

const residentPixels = (resident) => resident?.drawing
  ? drawingPixels(resident.drawing)
  : standInPixels(DARK.muted)

const openDoor = (grid, door) => {
  const sourceX = door.side === 'left' ? door.x + 1 : door.x - 1
  for (let y = door.y; y < door.y + door.height; y += 1) {
    if (y < 0 || y >= grid.height || door.x < 0 || door.x >= grid.width || sourceX < 0 || sourceX >= grid.width) continue
    grid.cells[y][door.x] = [...grid.cells[y][sourceX]]
  }
}

const safeBubbleText = (value) => {
  const safe = String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
  return Array.from(bubbleSegmenter.segment(safe), ({ segment }) => segment).slice(0, 24).join('')
}

const textCellWidth = (value) => {
  const measure = new Grid(64, 1, DARK.bg)
  measure.put(0, 0, value, DARK.ink)
  let width = 0
  measure.cells[0].forEach(([, foreground], index) => {
    if (foreground === DARK.ink) width = index + 1
  })
  return width
}

const nearbyValues = (start, end, preferred) => Array.from(
  { length: Math.max(0, end - start + 1) },
  (_, index) => start + index,
).sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred) || left - right)

const bubbleCandidates = (box, author, width) => {
  const height = 3
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
  const text = safeBubbleText(bubble.text)
  const width = Math.min(Math.max(6, textCellWidth(text) + 4), Math.max(0, box.width - 2))
  const candidate = bubbleCandidates(box, author, width).find((rectangle) =>
    occupied.every((blocker) => !intersects(rectangle, blocker)),
  )
  if (!candidate) return null

  const top = ['╭', ...Array(candidate.width - 2).fill('─'), '╮']
  const bottom = ['╰', ...Array(candidate.width - 2).fill('─'), '╯']
  const authorCenter = Math.floor(author.x + (author.width / 2))
  const tailColumn = Math.max(1, Math.min(candidate.width - 2, authorCenter - candidate.x))
  if (candidate.tail === 'down') bottom[tailColumn] = '┬'
  if (candidate.tail === 'up') top[tailColumn] = '┴'

  grid.put(candidate.x, candidate.y, top.join(''), DARK.ink, DARK.bubble, candidate.width)
  grid.put(candidate.x, candidate.y + 1, `│${' '.repeat(candidate.width - 2)}│`, DARK.ink, DARK.bubble, candidate.width)
  grid.put(candidate.x + 2, candidate.y + 1, text, DARK.ink, DARK.bubble, candidate.width - 4)
  if (candidate.tail === 'right') grid.put(candidate.x + candidate.width - 1, candidate.y + 1, '├', DARK.ink, DARK.bubble)
  if (candidate.tail === 'left') grid.put(candidate.x, candidate.y + 1, '┤', DARK.ink, DARK.bubble)
  grid.put(candidate.x, candidate.y + 2, bottom.join(''), DARK.ink, DARK.bubble, candidate.width)
  return candidate
}

/** Paint one deterministic live observation into the terminal's exact cell bounds. */
export const paintLiveView = (observation, { columns, rows }, motionFrame = undefined) => {
  const grid = new Grid(columns, rows, DARK.bg)
  if (grid.width === 0 || grid.height === 0) return grid

  grid.put(1, 0, observation?.target?.name ?? '', DARK.ink, DARK.bg, Math.max(0, grid.width - 2))
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const boxes = layoutRooms(rooms.length, { columns: grid.width, rows: grid.height })
  const framed = motionFrame !== undefined && motionFrame !== null
  const framePlans = new Map((motionFrame?.plans ?? []).map((plan) => [String(plan.roomId), plan]))
  const roomStates = boxes.map((fallbackBox, index) => {
    const room = rooms[index]
    const framePlan = framePlans.get(String(room.id))
    const box = framePlan?.box ?? fallbackBox
    return { room, box, plan: framePlan ?? planRoomPlacements(room, box) }
  })

  roomStates.forEach(({ room, box, plan }) => paintRoomBase(grid, room, box, plan))
  for (const door of motionFrame?.doors ?? []) openDoor(grid, door)

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
  for (const pose of poses) overlayPixels(grid, pose.x, pose.y, residentPixels(pose.resident), pose.opacity ?? 1)

  const bubbleRects = []
  for (const bubble of motionFrame?.bubbles ?? []) {
    const author = poses.find((pose) => sameId(pose.roomId, bubble.roomId) && sameId(pose.resident?.id, bubble.residentId))
    const state = roomStates.find(({ room }) => sameId(room.id, bubble.roomId))
    if (!author || !state) continue
    const portraitRects = poses.filter((pose) => sameId(pose.roomId, bubble.roomId))
    const rectangle = drawBubble(grid, bubble, author, state.box, [...portraitRects, ...state.plan.things, ...bubbleRects])
    if (rectangle) bubbleRects.push(rectangle)
  }
  return grid
}
