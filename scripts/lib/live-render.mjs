import { DARK, Grid } from './grid.mjs'
import {
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

const overlayPixels = (grid, x, y, pixels) => {
  for (let row = 0; row < Math.ceil(pixels.length / 2); row += 1) {
    for (let column = 0; column < (pixels[0]?.length ?? 0); column += 1) {
      const top = pixels[row * 2]?.[column] ?? null
      const bottom = pixels[(row * 2) + 1]?.[column] ?? null
      if (top === null && bottom === null) continue
      const targetY = y + row
      const targetX = x + column
      if (targetY < 0 || targetY >= grid.height || targetX < 0 || targetX >= grid.width) continue
      grid.cells[targetY][targetX] = compositeCell(grid.cells[targetY][targetX], top, bottom)
    }
  }
}

const paintRoom = (grid, room, box) => {
  grid.fill(box.x, box.y, box.width, box.height, DARK.room)
  paintFloor(grid, room, box)
  drawRoomBox(grid, room, box, wallTone(room.drawing, DARK.muted))

  const placements = planRoomPlacements(room, box)
  for (const placement of placements.things) {
    overlayPixels(grid, placement.x, placement.y, placement.item.drawing
      ? shrinkDrawingPixels(placement.item.drawing)
      : THING_STANDIN_PIXELS)
  }
  for (const dot of placements.overflowDots) grid.put(dot.x, dot.y, '·', DARK.muted)
  for (const placement of placements.residents) {
    overlayPixels(grid, placement.x, placement.y, placement.item.drawing
      ? drawingPixels(placement.item.drawing)
      : standInPixels(DARK.muted))
  }
}

/** Paint one deterministic live observation into the terminal's exact cell bounds. */
export const paintLiveView = (observation, { columns, rows }) => {
  const grid = new Grid(columns, rows, DARK.bg)
  if (grid.width === 0 || grid.height === 0) return grid

  grid.put(1, 0, observation?.target?.name ?? '', DARK.ink, DARK.bg, Math.max(0, grid.width - 2))
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const boxes = layoutRooms(rooms.length, { columns: grid.width, rows: grid.height })
  boxes.forEach((box, index) => paintRoom(grid, rooms[index], box))
  return grid
}
