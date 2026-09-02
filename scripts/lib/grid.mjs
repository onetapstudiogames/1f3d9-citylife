// Text-grid renderer for `live`, ported from the owner-reviewed Python mock
// (scripts/lib/grid.mjs is the Node twin of mock/render.py's Grid, portrait,
// room_box, and to_ansi functions). Same characters, same layout math.

export const DARK = {
  bg: '#0b1714',
  room: '#101c19',
  ink: '#e9e2d0',
  line: '#8e856f',
  muted: '#8a9088',
  hi: '#f0a060',
  bubble: '#1c2a26',
}

export class Grid {
  constructor(width, height, background) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => [' ', null, background]),
    )
  }

  put(x, y, text, fg = null, bg = undefined) {
    for (let i = 0; i < text.length; i += 1) {
      const cx = x + i
      if (cx < 0 || cx >= this.width || y < 0 || y >= this.height) continue
      const old = this.cells[y][cx]
      this.cells[y][cx] = [text[i], fg, bg === undefined ? old[2] : bg]
    }
  }

  fill(x, y, width, height, bg) {
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        if (xx < 0 || xx >= this.width || yy < 0 || yy >= this.height) continue
        const [ch, fg] = this.cells[yy][xx]
        this.cells[yy][xx] = [ch, fg, bg]
      }
    }
  }
}

/** 8x8 pixel drawing -> 4 rows of 8 half-block cells: [char, fg, bg]. */
export const portraitRows = (drawing, bg) => {
  const palette = drawing.palette
  const indices = drawing.indices
  const px = (i) => (indices[i] === null || indices[i] === undefined ? null : palette[indices[i]])
  const rows = []
  for (let r = 0; r < 4; r += 1) {
    const row = []
    for (let c = 0; c < 8; c += 1) {
      const top = px(2 * r * 8 + c)
      const bottom = px((2 * r + 1) * 8 + c)
      if (top === null && bottom === null) row.push([' ', null, bg])
      else if (top !== null && bottom === null) row.push(['▀', top, bg])
      else if (top === null && bottom !== null) row.push(['▄', bottom, bg])
      else row.push(['▀', top, bottom])
    }
    rows.push(row)
  }
  return rows
}

export const STANDIN = ['  ▄██▄  ', '  ▀██▀  ', ' ▄████▄ ', ' ▀▀  ▀▀ ']

const BOX_W_DESKTOP = 40
const BOX_W_PHONE = 44

export const boxWidthFor = (mode) => (mode === 'phone' ? BOX_W_PHONE : BOX_W_DESKTOP)

const perRow = (boxWidth) => Math.max(1, Math.floor((boxWidth - 4) / 10))
const MAX_RESIDENTS = 6

/**
 * Draw one room as a box-drawing box: rows of cells, boxWidth wide.
 * room: { id, name, residents: [{id,handle,has_drawing}], thingsCount, notes: [{author, body}] }
 * drawingsById: Map<residentId, {palette, indices}>
 */
export const roomBox = (room, theme, boxWidth, followedHandle) => {
  const perRowCount = perRow(boxWidth)
  const residents = [...room.residents].sort((a, b) => {
    if (Boolean(a.has_drawing) !== Boolean(b.has_drawing)) return a.has_drawing ? -1 : 1
    return a.handle.localeCompare(b.handle)
  })
  const shown = residents.slice(0, MAX_RESIDENTS)
  const extra = residents.length - shown.length
  const rowsOfResidents = shown.length ? Math.ceil(shown.length / perRowCount) : 0
  const notes = room.notes ?? []
  const bodyHeight = 1 + (shown.length ? rowsOfResidents * 6 : 2) + (extra ? 1 : 0) + 1 + (notes.length ? 4 : 0)
  const height = bodyHeight + 2
  const grid = new Grid(boxWidth, height, theme.room)
  const followed = residents.some((r) => r.handle === followedHandle)
  const border = followed ? theme.hi : theme.line

  grid.put(0, 0, `┌${'─'.repeat(boxWidth - 2)}┐`, border)
  for (let y = 1; y < height - 1; y += 1) {
    grid.put(0, y, '│', border)
    grid.put(boxWidth - 1, y, '│', border)
  }
  grid.put(0, height - 1, `└${'─'.repeat(boxWidth - 2)}┘`, border)

  const title = ` ${room.name.slice(0, boxWidth - 16)} `
  grid.put(2, 0, title, theme.ink)
  const here = residents.length ? ` ${residents.length} here ` : ' empty '
  grid.put(boxWidth - 2 - here.length, 0, here, theme.muted)

  let y = 2
  if (shown.length) {
    shown.forEach((resident, i) => {
      const cx = 2 + (i % perRowCount) * 10
      const cy = y + Math.floor(i / perRowCount) * 6
      const drawing = resident.drawing
      if (drawing) {
        portraitRows(drawing, theme.room).forEach((row, k) => {
          row.forEach(([ch, fg, bg], j) => {
            if (cy + k < grid.height && cx + j < grid.width) grid.cells[cy + k][cx + j] = [ch, fg, bg]
          })
        })
      } else {
        STANDIN.forEach((s, k) => grid.put(cx, cy + k, s, theme.muted))
      }
      const label = resident.handle.slice(0, 9)
      grid.put(cx + Math.max(0, Math.floor((8 - label.length) / 2)), cy + 4, label, resident.handle === followedHandle ? theme.hi : theme.ink)
    })
    y += rowsOfResidents * 6
  } else {
    grid.put(2, y, 'nobody here right now', theme.muted)
    y += 2
  }
  if (extra) {
    grid.put(2, y, `+${extra} more`, theme.muted)
    y += 1
  }
  const thingsLine = `▣ ${room.thingsCount ?? 0} things`
  grid.put(2, y, thingsLine.slice(0, boxWidth - 4), theme.muted)
  y += 1
  if (notes.length) {
    const note = notes[0]
    const who = note.author
    const text = note.body.replace(/\s+/gu, ' ')
    const inner = boxWidth - 8
    grid.put(2, y, `╭ ${who} ${'─'.repeat(Math.max(0, inner - who.length - 1))}╮`, theme.line, theme.bubble)
    grid.fill(2, y + 1, inner + 4, 2, theme.bubble)
    grid.put(2, y + 1, `│ ${text.slice(0, inner).padEnd(inner)} │`, theme.ink, theme.bubble)
    const second = text.length > 2 * inner - 1 ? `${text.slice(inner, 2 * inner - 1)}…` : text.slice(inner, 2 * inner)
    grid.put(2, y + 2, `│ ${second.padEnd(inner)} │`, theme.ink, theme.bubble)
    grid.put(2, y + 3, `╰${'─'.repeat(inner + 2)}╯`, theme.line, theme.bubble)
    y += 4
  }
  return grid.cells
}

// Every case below is driven only by fields the live `/api/events` feed
// actually puts in that event kind's `detail` (confirmed against a real
// page of the feed, not guessed from a schema) — never a fetch of its own.
// A kind whose detail carries no place clause (thing_edited, thing_withdrawn,
// resident_edited, register, rotate, agreement_sign, effect_resolved) never
// prints "in ?"; it just states the action with no place clause, and an
// unresolved-but-present place id (not in `placeNameById`) falls back to "?"
// exactly as before.
export const eventWords = (event, placeNameById) => {
  const detail = event.detail ?? {}
  const time = String(event.at ?? '').slice(11, 16)
  const placeOf = (id) => placeNameById.get(id) ?? '?'
  const inPlace = (id) => (id === undefined || id === null ? '' : ` in ${placeOf(id)}`)

  if (event.kind === 'action') {
    if (detail.action === 'move') return `${time} ${event.actor} walked to ${placeOf(detail.to_place_id)}`
    if (detail.action === 'go_home') return `${time} ${event.actor} went home`
    if (detail.action === 'use') return `${time} ${event.actor} used a thing${inPlace(detail.place_id)}`
    return `${time} ${event.actor} ${String(detail.action ?? 'acted').replaceAll('_', ' ')}${inPlace(detail.place_id)}`
  }
  if (event.kind === 'note') return `${time} ${event.actor} spoke in ${placeOf(detail.place_id)}`
  if (event.kind === 'thing_created') return `${time} ${event.actor} made ${detail.name ?? 'something'} in ${placeOf(detail.place_id)}`
  if (event.kind === 'thing_edited') return `${time} ${event.actor} edited a thing${inPlace(detail.place_id)}`
  if (event.kind === 'thing_withdrawn') return `${time} ${event.actor} withdrew a thing${inPlace(detail.place_id)}`
  if (event.kind === 'thing_crafted') return `${time} ${event.actor} crafted a thing${inPlace(detail.place_id)}`
  if (event.kind === 'place_edited') return `${time} ${event.actor} edited ${placeOf(detail.place_id)}`
  if (event.kind === 'place_created') return `${time} ${event.actor} founded ${detail.name ?? 'a place'}${inPlace(detail.parent_id)}`
  if (event.kind === 'home_set') return `${time} ${event.actor} set home to ${placeOf(detail.place_id)}`
  if (event.kind === 'resident_edited') return `${time} ${event.actor} updated their profile`
  if (event.kind === 'register') return `${time} ${event.actor} joined the city`
  if (event.kind === 'rotate') return `${time} ${event.actor} rotated their key`
  if (event.kind === 'agreement_sign') return `${time} ${event.actor} signed an agreement`
  if (event.kind === 'effect_scheduled') return `${time} ${event.actor} triggered an effect${inPlace(detail.place_id)}`
  if (event.kind === 'effect_resolved') return `${time} an effect resolved for ${event.actor}`
  return `${time} ${event.actor} ${String(event.kind ?? 'did something').replaceAll('_', ' ')}`
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** Render a composed grid as plain characters, no colour — for inline chat fallback where ANSI codes would just be noise. */
export const toPlainText = (grid) => `${grid.cells.map((row) => row.map(([ch]) => ch).join('')).join('\n')}\n`

/** Render a composed grid to ANSI truecolor escape sequences for a terminal. */
export const toAnsi = (grid, theme) => {
  const lines = grid.cells.map((row) => {
    let line = ''
    for (const [ch, fg, bg] of row) {
      const [fr, fg_, fb] = rgbOf(fg ?? theme.ink)
      const [br, bg_, bb] = rgbOf(bg ?? theme.bg)
      line += `\x1b[38;2;${fr};${fg_};${fb}m\x1b[48;2;${br};${bg_};${bb}m${ch}`
    }
    return `${line}\x1b[0m`
  })
  return `${lines.join('\n')}\n`
}

/** Compose the full scene: header, room columns, ticker, legend. Same layout math as render.py's compose(). */
export const composeScene = ({ rooms, theme, mode, followedHandle, followedPlaceName, totalResidents, crumb, events, placeNameById }) => {
  const boxWidth = boxWidthFor(mode)
  const columns = mode === 'phone' ? 1 : 3
  const boxes = rooms.map((room) => roomBox(room, theme, boxWidth, followedHandle))
  const totalWidth = columns * boxWidth + (columns + 1) * 2
  const cols = Array.from({ length: columns }, () => [])
  const heights = Array(columns).fill(0)
  for (const box of boxes) {
    let shortest = 0
    for (let i = 1; i < columns; i += 1) if (heights[i] < heights[shortest]) shortest = i
    cols[shortest].push(box)
    heights[shortest] += box.length + 1
  }
  const bodyHeight = Math.max(0, ...heights)
  const now = `${new Date().toISOString().slice(11, 16)} UTC`
  const headHeight = mode === 'desktop' ? 3 : 4
  const footHeight = 9
  const grid = new Grid(totalWidth, headHeight + bodyHeight + footHeight, theme.bg)
  const right = `${totalResidents} residents · ${now}`
  grid.put(2, 0, '1F3D9  LIVE', theme.ink)
  let followY
  if (mode === 'desktop') {
    grid.put(15, 0, crumb, theme.muted)
    grid.put(totalWidth - 2 - right.length, 0, right, theme.muted)
    followY = 1
  } else {
    grid.put(totalWidth - 2 - right.length, 0, right, theme.muted)
    grid.put(2, 1, crumb, theme.muted)
    followY = 2
  }
  if (followedHandle) {
    grid.put(2, followY, `following ${followedHandle} ▶ ${followedPlaceName ?? '?'}`, theme.hi)
  }
  cols.forEach((col, ci) => {
    const x = 2 + ci * (boxWidth + 2)
    let y = headHeight
    for (const box of col) {
      box.forEach((row, yy) => row.forEach((cell, xx) => {
        grid.cells[y + yy][x + xx] = cell
      }))
      y += box.length + 1
    }
  })
  const footY = headHeight + bodyHeight
  grid.put(2, footY, '─'.repeat(totalWidth - 4), theme.line)
  grid.put(2, footY + 1, 'just now', theme.ink)
  events.slice(0, 5).forEach((event, i) => {
    grid.put(2, footY + 2 + i, eventWords(event, placeNameById).slice(0, totalWidth - 4), theme.muted)
  })
  const legend = 'portrait = drawn by the resident · grey figure = no drawing yet · ▣ things · ╭╮ latest note here'
  grid.put(2, footY + 7, legend.slice(0, totalWidth - 4), theme.muted)
  if (legend.length > totalWidth - 4) grid.put(2, footY + 8, legend.slice(totalWidth - 4).trim().slice(0, totalWidth - 4), theme.muted)
  return grid
}
