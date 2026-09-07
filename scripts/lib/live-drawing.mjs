const HEX_COLOR = /^#[0-9a-f]{6}$/iu

const validColor = (value) => typeof value === 'string' && HEX_COLOR.test(value)
const normalizedColor = (value) => validColor(value) ? value.toLowerCase() : null
const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
const hex = (channels) => `#${channels.map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')).join('')}`

export const blendHex = (color, toward, amount) => {
  const source = normalizedColor(color)
  const target = normalizedColor(toward)
  if (!source || !target || !Number.isFinite(amount)) return null
  const ratio = Math.max(0, Math.min(1, amount))
  return hex(rgb(source).map((channel, index) => Math.round(channel + ((rgb(target)[index] - channel) * ratio))))
}

/** Convert the public 8x8 drawing shape to validated colour-or-null pixels. */
export const drawingPixels = (drawing) => {
  const palette = Array.isArray(drawing?.palette) ? drawing.palette.map(normalizedColor) : []
  const indices = Array.isArray(drawing?.indices) ? drawing.indices : []
  return Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, column) => {
      const paletteIndex = indices[(row * 8) + column]
      return Number.isInteger(paletteIndex) ? palette[paletteIndex] ?? null : null
    }))
}

export const floorPixels = (drawing, roomColor) => drawingPixels(drawing)
  .map((row) => row.map((color) => color === null ? null : blendHex(color, roomColor, 0.5)))

const lightness = (color) => {
  const [red, green, blue] = rgb(color)
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

/** Brighter of the drawing's two most-used colours, lightened toward white. */
export const wallTone = (drawing, fallback) => {
  const pixels = drawingPixels(drawing).flat()
  const counts = new Map()
  for (const color of pixels) if (color !== null) counts.set(color, (counts.get(color) ?? 0) + 1)
  const paletteOrder = [...new Set((Array.isArray(drawing?.palette) ? drawing.palette : [])
    .map(normalizedColor).filter((color) => color !== null))]
  const dominant = paletteOrder
    .map((color, order) => ({ color, count: counts.get(color) ?? 0, order }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .slice(0, 2)
  if (!dominant.length) return fallback
  const brighter = dominant.reduce((best, candidate) =>
    lightness(candidate.color) > lightness(best.color) ? candidate : best)
  return blendHex(brighter.color, '#ffffff', 0.25)
}

/** Shrink 8x8 to 4x4 using the most common nonempty colour in each 2x2 block. */
export const shrinkDrawingPixels = (drawing) => {
  const source = drawingPixels(drawing)
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => {
    const block = [
      source[row * 2][column * 2],
      source[row * 2][(column * 2) + 1],
      source[(row * 2) + 1][column * 2],
      source[(row * 2) + 1][(column * 2) + 1],
    ].filter((color) => color !== null)
    if (!block.length) return null
    const counts = new Map()
    for (const color of block) counts.set(color, (counts.get(color) ?? 0) + 1)
    let selected = block[0]
    for (const color of block) if (counts.get(color) > counts.get(selected)) selected = color
    return selected
  }))
}

export const pixelsToCell = (top, bottom, background) => {
  if (top === null && bottom === null) return [' ', null, background]
  if (top !== null && bottom === null) return ['▀', top, background]
  if (top === null && bottom !== null) return ['▄', bottom, background]
  if (top === bottom) return [' ', null, top]
  return ['▀', top, bottom]
}

export const cellPixels = ([character, foreground, background]) => {
  if (character === '▀') return [foreground ?? background, background]
  if (character === '▄') return [background, foreground ?? background]
  if (character === '█') return [foreground ?? background, foreground ?? background]
  return [background, background]
}

/** Overlay two sprite pixels while preserving each transparent floor half. */
export const compositeCell = (cell, top, bottom) => {
  if (top === null && bottom === null) return [...cell]
  const [floorTop, floorBottom] = cellPixels(cell)
  const composedTop = top ?? floorTop
  const composedBottom = bottom ?? floorBottom
  if (top !== null && bottom !== null && composedTop === composedBottom) return ['█', composedTop, cell[2]]
  if (top !== null && bottom === null) return ['▀', composedTop, floorBottom]
  if (top === null && bottom !== null) return ['▄', composedBottom, floorTop]
  return ['▀', composedTop, composedBottom]
}

const STANDIN_ROWS = ['  ▄██▄  ', '  ▀██▀  ', ' ▄████▄ ', ' ▀▀  ▀▀ ']

/** Decode the four-line grey figure into an 8x8 transparent pixel mask. */
export const standInPixels = (color) => STANDIN_ROWS.flatMap((row) => {
  const top = []
  const bottom = []
  for (const character of row) {
    top.push(character === '▀' || character === '█' ? color : null)
    bottom.push(character === '▄' || character === '█' ? color : null)
  }
  return [top, bottom]
})
