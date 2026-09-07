// Extend the unchanged public recording with explicitly fictional action moments.
// This fixture builder never contacts the city.
import { readFile, writeFile } from 'node:fs/promises'

const destination = process.argv[2]
if (!destination) throw Error('Pass the JSON scene output path.')
const scene = JSON.parse(await readFile(new URL('../../../test/fixtures/live-scene.json', import.meta.url), 'utf8'))
const raw = scene.moments[0].raw
const fairIndex = raw.rooms.findIndex(room => room.placeId === 34)
const townIndex = raw.rooms.findIndex(room => room.placeId === 2)
const fairThings = raw.rooms[fairIndex].response.things
const carried = fairThings.find(thing => thing.id === 1431)
const made = { ...carried, id: 999999, name: 'scene-only little keepsake' }
const replace = (path, value) => ({ op: 'replace', path, value })
const thingsAt = index => ['rooms', index, 'response', 'things']
const event = (id, kind, actor, detail) => ({
  op: 'prepend', path: ['events', 'events'],
  value: { id, change_id: String(id), at: '2026-09-07T14:30:00.000Z', kind, actor, detail },
})
const add = (atMs, purpose, changes, times = [0, 250, 600, 1000]) => {
  scene.moments.push({ atMs, metadata: { provenance: 'hand-authored-extension', purpose }, changes })
  scene.frameTimes.push(...times.map(offset => atMs + offset))
}

add(70000, 'Fictional creation in the followed room; no city write occurred.', [
  replace(thingsAt(fairIndex), [made, ...fairThings.slice(0, 4)]),
  event(100200, 'thing_created', 'thog', { thing_id: made.id, place_id: 34 }),
])
add(72000, 'Fictional recorded use shows a brief glow.', [
  event(100201, 'action', 'thog', { action: 'use', status: 'noop', source_thing_id: 1431, place_id: 34 }),
])
add(74000, 'Fictional gift passes a known thing between two present residents.', [
  event(100202, 'transfer', 'thog', { mode: 'gift', asset_type: 'thing', asset_id: 1435, resident_id: 32, place_id: 34 }),
], [0, 250, 500, 1000])
add(76000, 'Fictional removal shows crumbs without claiming why the thing vanished.', [
  replace(thingsAt(fairIndex), fairThings),
  event(100203, 'thing_withdrawn', 'thog', { thing_id: made.id }),
])
add(78000, 'Fictional exact carry pair moves the followed resident and their thing together.', [
  replace(['presence', 'pages', 1, 'residents', 109, 'current_place_id'], 2),
  replace(thingsAt(fairIndex), fairThings.filter(thing => thing.id !== carried.id)),
  replace(thingsAt(townIndex), [{ ...carried, place_id: 2 }, ...raw.rooms[townIndex].response.things.slice(0, 4)]),
  event(100204, 'action', 'thog', { action: 'move', status: 'applied', mode: 'carry', action_id: 1000000, thing_id: carried.id, from_place_id: 34, to_place_id: 2 }),
  event(100205, 'thing_moved', 'thog', { mode: 'carry', action_id: 1000000, thing_id: carried.id, resident_id: 8, from_place_id: 34, place_id: 2 }),
], [0, 500, 1000, 1500, 2000, 3000])
scene.durationMs = 81000
scene.metadata.extension = 'Original three moments unchanged. Later action moments are fictional, hand-authored visual examples. They never ran in the city.'
await writeFile(destination, JSON.stringify(scene, null, 2) + '\n', 'utf8')
