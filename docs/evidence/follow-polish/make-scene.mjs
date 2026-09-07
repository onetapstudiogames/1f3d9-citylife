// Build deterministic review evidence from the unchanged public recording.
// Every moment after zero is a hand-authored extension; this script does no I/O
// beyond reading the checked-in recording and writing the requested JSON file.
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
const sleepingResident = raw.presence.pages
  .flatMap((page, pageIndex) => page.residents.map((resident, residentIndex) => ({ resident, pageIndex, residentIndex })))
  .find(({ resident }) => resident.id === 226 && resident.current_place_id === 2)
if (!carried || !sleepingResident) throw Error('The recorded evidence no longer has the expected review subjects.')

const replace = (path, value) => ({ op: 'replace', path, value })
const thingsAt = index => ['rooms', index, 'response', 'things']
const event = (id, kind, actor, detail, at = '2026-09-07T14:30:00.000Z') => ({
  op: 'prepend', path: ['events', 'events'],
  value: { id, change_id: String(id), at, kind, actor, detail },
})
const add = (atMs, purpose, changes, times = [0, 250, 600, 1000]) => {
  scene.moments.push({
    atMs,
    metadata: {
      provenance: 'hand-authored-extension',
      basedOn: 'test/fixtures/live-scene.json plus the earlier hand-authored moments in this generator',
      cityWriteOccurred: false,
      purpose,
    },
    changes,
  })
  scene.frameTimes.push(...times.map(offset => atMs + offset))
}

// Keep the established action evidence moments and their recorded drawings.
add(70000, 'Fictional creation in the followed room; no city write occurred.', [
  replace(thingsAt(fairIndex), [made, ...fairThings.slice(0, 4)]),
  event(100200, 'thing_created', 'thog', { thing_id: made.id, place_id: 34 }),
])
add(72000, 'Fictional recorded use shows a brief glow and a factual activity label.', [
  event(100201, 'action', 'thog', { action: 'use', status: 'noop', source_thing_id: 1431, place_id: 34 }),
])
add(74000, 'Fictional gift passes a known thing between two present residents.', [
  event(100202, 'transfer', 'thog', { mode: 'gift', asset_type: 'thing', asset_id: 1435, resident_id: 32, place_id: 34 }),
], [0, 250, 500, 1000])
add(76000, 'Fictional removal shows crumbs and a factual withdrawal label.', [
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

const longBody = 'I followed the lantern home through the first town, keeping every recorded name and every careful detail in view. The narrow window may take longer to read, but it must keep the whole message, continue at a calm pace, and leave these final words visible: THE LANTERN IS HOME.'
add(84000, 'Fictional long note and matching public note event exercise the complete timed activity scroll; dpl is explicitly marked asleep for label evidence.', [
  replace(['presence', 'pages', sleepingResident.pageIndex, 'residents', sleepingResident.residentIndex, 'asleep'], true),
  {
    op: 'prepend', path: ['notes', 'notes'],
    value: {
      id: 9007199254740001,
      place_id: 2,
      author: 'thog',
      body: longBody,
      created_at: '2026-09-07T14:30:14.000Z',
      moderated: false,
    },
  },
  event(100206, 'note', 'thog', { note_id: 9007199254740001, place_id: 2 }, '2026-09-07T14:30:14.000Z'),
], [0, 250, 500, 1000, 3000, 5500, 8000, 10500, 13000, 15500, 18000, 20500, 23000, 25500, 28000, 31000, 36000, 42000, 50000, 60000, 66000])

scene.durationMs = 150000
scene.frameTimes = [...new Set(scene.frameTimes)].filter(time => time <= scene.durationMs).sort((left, right) => left - right)
scene.metadata.extension = 'Original recorded moments and drawings are unchanged. Moments from 70000 onward are deterministic, fictional hand-authored review evidence. No city write or live read occurred.'
scene.metadata.generator = 'docs/evidence/follow-polish/make-scene.mjs'
await writeFile(destination, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
