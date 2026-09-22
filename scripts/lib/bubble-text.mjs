import { textCells } from './grid.mjs'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const sanitizeBubbleText = (value) => String(value ?? '')
  .normalize('NFC')
  .replace(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
  .trim()

export const bubbleTextWidth = (value) => textCells(sanitizeBubbleText(value)).length

// A walk-to-read note read from afar (city decision 102) arrives with no body,
// only its public first_line and a read_in_person line. Show that first line and
// this fixed marker; never invent a body and never show the agent instruction.
export const WALK_TO_READ_MARKER = '(read in person)'

/** The safe one-line speech text for a note row, or '' when it has nothing to show. */
export const noteSpeechText = (note) => {
  if (note?.walk_to_read !== true || note.body !== undefined) return sanitizeBubbleText(note?.body)
  const firstLine = sanitizeBubbleText(note.first_line)
  return firstLine ? `${firstLine} ${WALK_TO_READ_MARKER}` : WALK_TO_READ_MARKER
}

const splitWord = (word, width) => {
  const lines = []
  let line = ''
  let lineWidth = 0

  for (const { segment } of graphemeSegmenter.segment(word)) {
    const segmentWidth = textCells(segment).length
    if (line && lineWidth + segmentWidth > width) {
      lines.push(line)
      line = ''
      lineWidth = 0
    }
    line += segment
    lineWidth += segmentWidth
  }

  if (line) lines.push(line)
  return lines
}

export const wrapBubbleText = (value, width) => {
  const safe = sanitizeBubbleText(value)
  if (!safe) return []

  const lineWidth = Math.max(2, Math.floor(Number(width) || 0))
  const lines = []
  let line = ''

  for (const word of safe.split(' ')) {
    if (bubbleTextWidth(word) > lineWidth) {
      if (line) lines.push(line)
      const pieces = splitWord(word, lineWidth)
      lines.push(...pieces.slice(0, -1))
      line = pieces.at(-1) ?? ''
      continue
    }

    const candidate = line ? `${line} ${word}` : word
    if (bubbleTextWidth(candidate) <= lineWidth) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
  }

  if (line) lines.push(line)
  return lines
}
