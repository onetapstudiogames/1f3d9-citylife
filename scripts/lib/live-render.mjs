import { DARK, Grid, portraitRows, STANDIN } from './grid.mjs'

const ROOM_GAP = 1
const ROOM_MARGIN = 1
const MIN_ROOM_WIDTH = 36
const ROOM_TOP = 2
const PORTRAIT_WIDTH = 8
const PORTRAIT_HEIGHT = 4
const PORTRAIT_GAP = 1
const AISLE_HEIGHT = 4

const stableKey = (value) => String(value ?? '')

const positiveInteger = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  const text = stableKey(value)
  if (!/^[1-9]\d*$/u.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) ? number : null
}

const compareResidentIds = (left, right) => {
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

const divideWidth = (totalWidth, count) => {
  const base = Math.floor(totalWidth / count)
  const remainder = totalWidth % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

/** Number of room-detail reads that can produce a visible room box. */
export const visibleRoomLimit = ({ columns, rows }) => {
  const width = Math.max(0, Math.floor(Number(columns) || 0))
  const height = Math.max(0, Math.floor(Number(rows) || 0))
  const availableWidth = Math.max(0, width - (ROOM_MARGIN * 2))
  const availableHeight = Math.max(0, height - ROOM_TOP - 1)
  if (availableWidth < 4 || availableHeight < 3) return 0
  return Math.max(1, Math.floor((availableWidth + ROOM_GAP) / (MIN_ROOM_WIDTH + ROOM_GAP)))
}

const roomLayout = (roomCount, columns, rows) => {
  const availableWidth = Math.max(0, columns - (ROOM_MARGIN * 2))
  const availableHeight = Math.max(0, rows - ROOM_TOP - 1)
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

const drawRoomBox = (grid, room, box) => {
  const { x, y, width, height } = box
  grid.fill(x, y, width, height, DARK.room)
  grid.put(x, y, `╭${'─'.repeat(Math.max(0, width - 2))}╮`, DARK.line, DARK.room)
  for (let row = y + 1; row < y + height - 1; row += 1) {
    grid.put(x, row, '│', DARK.line, DARK.room)
    grid.put(x + width - 1, row, '│', DARK.line, DARK.room)
  }
  grid.put(x, y + height - 1, `╰${'─'.repeat(Math.max(0, width - 2))}╯`, DARK.line, DARK.room)
  if (width >= 5) grid.put(x + 2, y, ` ${room.name ?? ''} `, DARK.ink, DARK.room, width - 4)
}

const portraitSlots = ({ x, y, width, height }) => {
  const columns = []
  for (let left = x + 2; left + PORTRAIT_WIDTH <= x + width - 1; left += PORTRAIT_WIDTH + PORTRAIT_GAP) {
    columns.push(left)
  }

  const allRows = []
  for (let top = y + 2; top + PORTRAIT_HEIGHT <= y + height - 1; top += PORTRAIT_HEIGHT + PORTRAIT_GAP) {
    allRows.push(top)
  }
  const aisleTop = y + Math.floor((height - AISLE_HEIGHT) / 2)
  const aisleBottom = aisleTop + AISLE_HEIGHT - 1
  const rowsOutsideAisle = allRows.filter((top) => top + PORTRAIT_HEIGHT - 1 < aisleTop || top > aisleBottom)
  const rows = rowsOutsideAisle.length ? rowsOutsideAisle : allRows

  return rows.flatMap((top) => columns.map((left) => ({ x: left, y: top })))
}

/** Bound drawing reads to residents that can fit in a displayed room. */
export const residentDrawingLimit = (size, roomCount) => Math.max(0,
  ...roomLayout(roomCount, size.columns, size.rows).map(box => portraitSlots(box).length),
)

const placeResidents = (grid, residents, box) => {
  const slots = portraitSlots(box)
  if (!slots.length) return

  const available = new Set(slots.map((_, index) => index))
  const ordered = [...residents].sort(compareResidentIds)
  for (const resident of ordered) {
    if (!available.size) break
    const firstChoice = stableHash(resident.id) % slots.length
    let slotIndex = firstChoice
    while (!available.has(slotIndex)) slotIndex = (slotIndex + 1) % slots.length
    available.delete(slotIndex)
    const slot = slots[slotIndex]

    if (resident.drawing) {
      const rows = portraitRows(resident.drawing, DARK.room)
      rows.forEach((row, rowOffset) => row.forEach((cell, columnOffset) => {
        grid.cells[slot.y + rowOffset][slot.x + columnOffset] = [...cell]
      }))
    } else {
      STANDIN.forEach((line, rowOffset) => grid.put(slot.x, slot.y + rowOffset, line, DARK.muted, DARK.room))
    }
  }
}

/** Paint one deterministic live observation into the terminal's exact cell bounds. */
export const paintLiveView = (observation, { columns, rows }) => {
  const grid = new Grid(columns, rows, DARK.bg)
  if (grid.width === 0 || grid.height === 0) return grid

  grid.put(1, 0, observation?.target?.name ?? '', DARK.ink, DARK.bg, Math.max(0, grid.width - 2))
  const rooms = Array.isArray(observation?.rooms) ? observation.rooms : []
  const boxes = roomLayout(rooms.length, grid.width, grid.height)
  boxes.forEach((box, index) => {
    const room = rooms[index]
    drawRoomBox(grid, room, box)
    placeResidents(grid, Array.isArray(room.residents) ? room.residents : [], box)
  })
  return grid
}
