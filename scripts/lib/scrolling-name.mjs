import { sanitizeBubbleText } from './bubble-text.mjs'
import { textCells } from './grid.mjs'

export const NAME_STEP_MS = 400
const END_PAUSE_MS = 1_600
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const normalizedColumns = (value) => Math.max(0, Math.floor(Number(value) || 0))

const nameOffset = (width, columns, nowMs) => {
  const lastOffset = width - columns
  const travelMs = Math.max(0, lastOffset - 1) * NAME_STEP_MS
  const cycleMs = END_PAUSE_MS + travelMs + END_PAUSE_MS
  const elapsed = Math.max(0, Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0) % cycleMs
  if (elapsed < END_PAUSE_MS) return 0
  if (elapsed >= END_PAUSE_MS + travelMs) return lastOffset
  return Math.min(lastOffset, Math.floor((elapsed - END_PAUSE_MS) / NAME_STEP_MS) + 1)
}

const graphemes = (safe) => {
  const result = []
  let column = 0
  for (const { segment } of segmenter.segment(safe)) {
    const width = textCells(segment).length
    if (width < 1) continue
    result.push({ segment, start: column, end: column + width })
    column += width
  }
  return result
}

/** Return a deterministic, cell-safe viewport over a sanitized name. */
export const scrollingName = (value, columns, nowMs = 0) => {
  const slotWidth = normalizedColumns(columns)
  if (slotWidth < 1) return ''
  const safe = sanitizeBubbleText(value)
  const fullWidth = textCells(safe).length
  if (fullWidth <= slotWidth) return safe

  const offset = nameOffset(fullWidth, slotWidth, nowMs)
  const limit = offset + slotWidth
  let result = ''
  let used = 0
  for (const grapheme of graphemes(safe)) {
    if (grapheme.end <= offset || grapheme.start >= limit) continue
    if (grapheme.start < offset || grapheme.end > limit) continue
    const gap = grapheme.start - offset - used
    if (gap > 0) result += ' '.repeat(gap)
    result += grapheme.segment
    used = grapheme.end - offset
  }
  return `${result}${' '.repeat(Math.max(0, slotWidth - used))}`
}

/** Paint a name and schedule another frame only while its visible slot scrolls. */
export const paintScrollingName = (grid, x, y, value, fg, bg, columns, nowMs = 0) => {
  const slotWidth = normalizedColumns(columns)
  const safe = sanitizeBubbleText(value)
  grid.put(x, y, scrollingName(safe, slotWidth, nowMs), fg, bg, slotWidth)
  if (slotWidth > 0 && textCells(safe).length > slotWidth) {
    const clock = Number.isFinite(Number(nowMs)) ? Math.max(0, Number(nowMs)) : 0
    const nextNameAtMs = (Math.floor(clock / NAME_STEP_MS) + 1) * NAME_STEP_MS
    const existing = Number.isFinite(grid.nextNameAtMs) ? grid.nextNameAtMs : Number.POSITIVE_INFINITY
    grid.nextNameAtMs = Math.min(existing, nextNameAtMs)
  }
}
