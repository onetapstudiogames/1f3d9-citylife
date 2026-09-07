const HEX_COLOR = /^#[0-9a-f]{6}$/u

const normalizeHex = (value) => {
  const hex = String(value).toLowerCase()
  if (!HEX_COLOR.test(hex)) throw new TypeError(`invalid hex color: ${value}`)
  return hex
}

const rgbOf = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
const distance = ([red, green, blue], [otherRed, otherGreen, otherBlue]) =>
  ((red - otherRed) ** 2) + ((green - otherGreen) ** 2) + ((blue - otherBlue) ** 2)

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255]
const BASIC_COLORS = [
  { index: 0, foreground: 30, background: 40, rgb: [0, 0, 0] },
  { index: 1, foreground: 31, background: 41, rgb: [128, 0, 0] },
  { index: 2, foreground: 32, background: 42, rgb: [0, 128, 0] },
  { index: 3, foreground: 33, background: 43, rgb: [128, 128, 0] },
  { index: 4, foreground: 34, background: 44, rgb: [0, 0, 128] },
  { index: 5, foreground: 35, background: 45, rgb: [128, 0, 128] },
  { index: 6, foreground: 36, background: 46, rgb: [0, 128, 128] },
  { index: 7, foreground: 37, background: 47, rgb: [192, 192, 192] },
  { index: 8, foreground: 90, background: 100, rgb: [128, 128, 128] },
  { index: 9, foreground: 91, background: 101, rgb: [255, 0, 0] },
  { index: 10, foreground: 92, background: 102, rgb: [0, 255, 0] },
  { index: 11, foreground: 93, background: 103, rgb: [255, 255, 0] },
  { index: 12, foreground: 94, background: 104, rgb: [0, 0, 255] },
  { index: 13, foreground: 95, background: 105, rgb: [255, 0, 255] },
  { index: 14, foreground: 96, background: 106, rgb: [0, 255, 255] },
  { index: 15, foreground: 97, background: 107, rgb: [255, 255, 255] },
]

const XTERM_COLORS = [
  ...BASIC_COLORS,
  ...Array.from({ length: 216 }, (_, index) => {
    const red = Math.floor(index / 36)
    const green = Math.floor((index % 36) / 6)
    const blue = index % 6
    return { index: 16 + index, rgb: [XTERM_LEVELS[red], XTERM_LEVELS[green], XTERM_LEVELS[blue]] }
  }),
  ...Array.from({ length: 24 }, (_, index) => {
    const level = 8 + (index * 10)
    return { index: 232 + index, rgb: [level, level, level] }
  }),
]

const xtermCache = new Map()
const basicCache = new Map()

const nearest = (rgb, colors) => colors.reduce((best, candidate) =>
  distance(rgb, candidate.rgb) < distance(rgb, best.rgb) ? candidate : best)

const xtermIndex = (hex) => {
  const normalized = normalizeHex(hex)
  if (!xtermCache.has(normalized)) xtermCache.set(normalized, nearest(rgbOf(normalized), XTERM_COLORS).index)
  return xtermCache.get(normalized)
}

const basicColor = (hex) => {
  const normalized = normalizeHex(hex)
  if (!basicCache.has(normalized)) basicCache.set(normalized, nearest(rgbOf(normalized), BASIC_COLORS))
  return basicCache.get(normalized)
}

/** Decide terminal color depth once at startup. */
export const chooseColorMode = ({ env = process.env, platform = process.platform, isTTY = process.stdout.isTTY } = {}) => {
  if (!isTTY) return '16'

  const colorTerm = String(env.COLORTERM ?? '').toLowerCase()

  // The bootstrap has already proved that this classic Windows console can
  // process ANSI. Ignore an unrelated inherited TERM=dumb and use its safe
  // 256-colour default.
  if (platform === 'win32' && env.ONEF3D9_LEGACY_CONSOLE_MODE === 'ansi') {
    return colorTerm.includes('truecolor') || colorTerm.includes('24bit') ? 'truecolor' : '256'
  }
  if (env.WT_SESSION) return 'truecolor'
  if (String(env.TERM ?? '').toLowerCase() === 'dumb') return '16'

  const termProgram = String(env.TERM_PROGRAM ?? '').toLowerCase()
  const lcTerminal = String(env.LC_TERMINAL ?? '').toLowerCase()
  if (
    colorTerm.includes('truecolor') ||
    colorTerm.includes('24bit') ||
    termProgram.includes('iterm') ||
    lcTerminal.includes('iterm')
  ) return 'truecolor'

  // The legacy Windows console and other interactive terminals get the
  // 256-color fallback unless they explicitly identify as a basic terminal.
  void platform
  return '256'
}

/** Build cached ANSI foreground/background encoders for one chosen color mode. */
export const createColorEncoder = (mode) => {
  if (!['truecolor', '256', '16'].includes(mode)) throw new TypeError(`unsupported color mode: ${mode}`)

  const foregroundCache = new Map()
  const backgroundCache = new Map()
  const encode = (hex, background) => {
    const normalized = normalizeHex(hex)
    const cache = background ? backgroundCache : foregroundCache
    if (cache.has(normalized)) return cache.get(normalized)

    let sequence
    if (mode === 'truecolor') {
      const [red, green, blue] = rgbOf(normalized)
      sequence = `\x1b[${background ? 48 : 38};2;${red};${green};${blue}m`
    } else if (mode === '256') {
      sequence = `\x1b[${background ? 48 : 38};5;${xtermIndex(normalized)}m`
    } else {
      const color = basicColor(normalized)
      sequence = `\x1b[${background ? color.background : color.foreground}m`
    }
    cache.set(normalized, sequence)
    return sequence
  }

  return Object.freeze({
    foreground: (hex) => encode(hex, false),
    background: (hex) => encode(hex, true),
    reset: '\x1b[0m',
  })
}
