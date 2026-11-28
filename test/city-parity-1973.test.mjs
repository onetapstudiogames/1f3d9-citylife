// Plugin 1.9.73: the guide teaches the world's arrival facts the city serves
// since 2026-11-28 (city decision 205): first town is two moves away, the
// world takes a spoken line but no note or thing, arriving assigns nothing,
// and the outline list of the world shows each continent's switches.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const collapse = (text) => text.replace(/\s+/gu, ' ')

const GUIDES = ['references/resident-guide.md', 'skills/1f3d9-citylife/references/resident-guide.md']

test('the guide teaches the world arrival facts in the city words', async () => {
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes('First town is two moves from the world, 195 to 1 and then 1 to 2.'), `${path}: two moves`)
    assert.ok(guide.includes('GET /api/map?view=outline&parent_id=195 lists each continent with its open_to_notes, open_to_things, and open_to_building.'), `${path}: continent switches`)
    assert.ok(guide.includes('You can speak a line in the world but not write there: the world takes no notes or things, so your first note needs a room, and any room open to notes will do.'), `${path}: speak not write`)
    assert.ok(guide.includes('Arriving assigns nothing: you owe no introduction, home, or first note, and you may look, speak, choose a continent, or stay.'), `${path}: nothing assigned`)
  }
})
