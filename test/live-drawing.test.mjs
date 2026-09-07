import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blendHex,
  cellPixels,
  compositeCell,
  drawingPixels,
  floorPixels,
  shrinkDrawingPixels,
  standInPixels,
  wallTone,
} from '../scripts/lib/live-drawing.mjs'

const drawing = (palette, entries) => {
  const indices = Array(64).fill(null)
  for (const [index, paletteIndex] of entries) indices[index] = paletteIndex
  return { palette, indices }
}

test('live drawing: floor colours blend exactly halfway toward the room base', () => {
  const source = drawing(['#204020'], [[0, 0], [9, 0]])
  const pixels = floorPixels(source, '#101c19')

  assert.equal(blendHex('#204020', '#101c19', 0.5), '#182e1d')
  assert.equal(pixels[0][0], '#182e1d')
  assert.equal(pixels[1][1], '#182e1d')
  assert.equal(pixels[0][1], null)
})

test('live drawing: wall tone uses the brighter of the two most-used colours', () => {
  const source = drawing(['#800000', '#00c000', '#ffffff'], [
    [0, 0], [1, 0], [2, 0],
    [3, 1], [4, 1],
    [5, 2],
  ])

  assert.equal(wallTone(source, '#8a9088'), '#40d040')
  assert.equal(wallTone(null, '#8a9088'), '#8a9088')
})

test('live drawing: 2x2 shrink ignores empty pixels and resolves colour ties from top-left order', () => {
  const source = drawing(['#ff0000', '#0000ff', '#00ff00'], [
    [0, 0], [1, 1], [8, 1], [9, 0],
    [3, 2],
  ])
  const shrunk = shrinkDrawingPixels(source)

  assert.equal(shrunk.length, 4)
  assert.ok(shrunk.every((row) => row.length === 4))
  assert.equal(shrunk[0][0], '#ff0000', 'a 2-2 tie keeps the first top-left colour')
  assert.equal(shrunk[0][1], '#00ff00', 'one nonempty pixel survives three empty pixels')
  assert.equal(shrunk[0][2], null, 'an all-empty block stays empty')
})

test('live drawing: transparent stand-in halves preserve the floor pixel below them', () => {
  const pixels = standInPixels('#8a9088')
  const [top, bottom] = [pixels[0][2], pixels[1][2]]
  const composed = compositeCell(['▀', '#112233', '#445566'], top, bottom)

  assert.equal(top, null)
  assert.equal(bottom, '#8a9088')
  assert.deepEqual(composed, ['▄', '#8a9088', '#112233'])
  assert.deepEqual(cellPixels(composed), ['#112233', '#8a9088'])
})

test('live drawing: malformed palette entries become transparent pixels', () => {
  const pixels = drawingPixels({ palette: ['red'], indices: Array(64).fill(0) })
  assert.ok(pixels.flat().every((pixel) => pixel === null))
})
