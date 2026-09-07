import { DARK } from './grid.mjs'
import { createColorEncoder } from './terminal-colors.mjs'

const cursorAt = (x, y) => `\x1b[${y + 1};${x + 1}H`
const equalCell = (a, b) => a && b && a.every((value, index) => value === b[index])

/** Own the alternate screen and retain only the cells actually sent to it. */
export class TerminalScreen {
  constructor({ output, mode = 'truecolor', synchronized = false }) {
    this.output = output
    this.encoder = createColorEncoder(mode)
    this.synchronized = synchronized
    this.previous = null
    this.entered = false
  }

  enter() {
    if (this.entered) return
    this.entered = true
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[?1004h')
  }

  invalidate() {
    this.previous = null
  }

  present(grid) {
    const cells = grid.cells.map(row => row.map(([ch, fg, bg]) => [
      ch, this.encoder.foreground(fg ?? DARK.ink), this.encoder.background(bg ?? DARK.bg),
    ]))
    const sameSize = this.previous?.width === grid.width && this.previous?.height === grid.height
    const previous = sameSize ? this.previous.cells : []
    let text = ''
    let foreground = null
    let background = null
    for (let y = 0; y < grid.height; y += 1) {
      let x = 0
      while (x < grid.width) {
        if (equalCell(cells[y][x], previous[y]?.[x])) { x += 1; continue }
        text += cursorAt(x, y)
        do {
          const [ch, fg, bg] = cells[y][x]
          if (fg !== foreground) { text += fg; foreground = fg }
          if (bg !== background) { text += bg; background = bg }
          text += ch
          x += 1
        } while (x < grid.width && !equalCell(cells[y][x], previous[y]?.[x]))
      }
    }
    this.previous = { width: grid.width, height: grid.height, cells }
    if (!text) return false
    this.output.write(`${this.synchronized ? '\x1b[?2026h' : ''}${text}${this.encoder.reset}${this.synchronized ? '\x1b[?2026l' : ''}`)
    return true
  }

  restore() {
    if (!this.entered) return
    this.entered = false
    this.previous = null
    this.output.write(`${this.synchronized ? '\x1b[?2026l' : ''}\x1b[0m\x1b[?1004l\x1b[?25h\x1b[?1049l`)
  }
}
