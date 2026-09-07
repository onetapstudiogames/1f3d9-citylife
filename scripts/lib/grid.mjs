import { createColorEncoder } from './terminal-colors.mjs'

export const DARK = {
  bg: '#0b1714',
  room: '#101c19',
  ink: '#e9e2d0',
  line: '#8e856f',
  muted: '#8a9088',
  hi: '#f0a060',
  bubble: '#1c2a26',
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const isWideCodePoint = (codePoint) =>
  codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )

const safeText = (value) => String(value ?? '')
  .normalize('NFC')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')

const textCells = (value) => {
  const cells = []
  for (const { segment } of segmenter.segment(safeText(value))) {
    const first = segment.codePointAt(0)
    if (first === undefined || /^\p{M}+$/u.test(segment)) continue
    cells.push(segment)
    if (isWideCodePoint(first) || /[\p{Emoji_Presentation}\uFE0F\u20E3]/u.test(segment)) cells.push('')
  }
  return cells
}

export class Grid {
  constructor(width, height, background) {
    this.width = Math.max(0, Math.floor(Number(width) || 0))
    this.height = Math.max(0, Math.floor(Number(height) || 0))
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => [' ', null, background]),
    )
  }

  put(x, y, value, fg = null, bg = undefined, maxWidth = Number.POSITIVE_INFINITY) {
    const startX = Math.floor(Number(x) || 0)
    const row = Math.floor(Number(y) || 0)
    if (row < 0 || row >= this.height) return
    const sourceCells = textCells(value)
    const widthLimit = Math.max(0, Math.floor(Number(maxWidth) || 0))
    const visibleLimit = Math.min(widthLimit, Math.max(0, this.width - Math.max(0, startX)))
    const cells = sourceCells.slice(0, visibleLimit)
    if (cells.at(-1) !== '' && sourceCells[cells.length] === '') cells.pop()
    for (let index = 0; index < cells.length; index += 1) {
      const column = startX + index
      if (column < 0 || column >= this.width) continue
      if (cells[index] === '' && (index === 0 || cells[index - 1] === '' || column === 0)) continue
      const old = this.cells[row][column]
      this.cells[row][column] = [cells[index], fg, bg === undefined ? old[2] : bg]
    }
  }

  fill(x, y, width, height, bg) {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        if (column < 0 || column >= this.width || row < 0 || row >= this.height) continue
        const [character, fg] = this.cells[row][column]
        this.cells[row][column] = [character, fg, bg]
      }
    }
  }
}

/** Render a grid as plain characters, without terminal escape sequences. */
export const toPlainText = (grid) => `${grid.cells.map((row) => row.map(([character]) => character).join('')).join('\n')}\n`

/** Render a whole grid with the requested ANSI color depth. */
export const toAnsi = (grid, theme = DARK, colorMode = 'truecolor') => {
  const encoder = createColorEncoder(colorMode)
  const lines = grid.cells.map((row) => {
    let line = ''
    for (const [character, foreground, background] of row) {
      line += encoder.foreground(foreground ?? theme.ink)
      line += encoder.background(background ?? theme.bg)
      line += character
    }
    return `${line}${encoder.reset}`
  })
  return `${lines.join('\n')}\n`
}
