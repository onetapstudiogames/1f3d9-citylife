// Extend the checked-in anonymous recording with deterministic fictional actions.
// This builder reads one local fixture, writes one local fixture, and never contacts the city.
import { readFile, writeFile } from 'node:fs/promises'

const destination = process.argv[2]
if (!destination) throw Error('Pass the JSON scene output path.')
const sourceUrl = new URL('../follow-names/follow-names-scene.json', import.meta.url)
const scene = JSON.parse(await readFile(sourceUrl, 'utf8'))
const raw = scene.moments[0].raw
const townIndex = raw.rooms.findIndex(room => room.placeId === 2)
const thog = raw.presence.pages.flatMap((page, pageIndex) => page.residents
  .map((resident, residentIndex) => ({ resident, pageIndex, residentIndex })))
  .find(({ resident }) => resident.handle === 'thog')
const residentDrawing = raw.drawings.find(item => item.key === 'resident:56')
const thogDrawingIndex = raw.drawings.findIndex(item => item.key === 'resident:8')
const thingDrawing = raw.drawings.find(item => item.key === 'thing:1615')
const homeRoomId = 34
if (townIndex < 0 || !raw.rooms.some(room => room.placeId === homeRoomId) || !thog
  || thog.resident.current_place_id !== 2 || thogDrawingIndex < 0 || !residentDrawing || !thingDrawing) {
  throw Error('Expected recorded room, followed resident, or drawing copy source is absent.')
}

const replace = (path, value) => ({ op: 'replace', path, value })
const prepend = (path, value) => ({ op: 'prepend', path, value })
const event = (id, kind, detail, actor = 'thog') => prepend(['events', 'events'], {
  id, change_id: String(id), at: `2026-09-07T15:${String(id - 100300).padStart(2, '0')}:00.000Z`,
  kind, actor, detail,
})
const copiedDrawing = (key, type, id, copy) => prepend(['drawings'], {
  key, cached: false,
  response: { ...copy.response, body: { ...copy.response.body, type, id } },
})
const add = (atMs, label, purpose, changes, offsets = [0, 250, 1000, 2500]) => {
  scene.moments.push({
    atMs,
    metadata: {
      label, provenance: 'hand-authored-extension', cityWriteOccurred: false,
      basedOn: 'docs/evidence/follow-names/follow-names-scene.json and drawing responses copied from that fixture',
      purpose,
    },
    changes,
  })
  scene.frameTimes.push(...offsets.map(offset => atMs + offset))
}

const firstThing = { id: 900001, name: 'scene-only paper lantern', place_id: 2, kind_id: null, has_drawing: false }
const craftedThing = { id: 900002, name: 'scene-only copper compass', place_id: 2, kind_id: null, has_drawing: true }
const thingsPath = ['rooms', townIndex, 'response', 'things']

add(202000, 'hand-authored portrait changes', 'A fictional public resident drawing edit updates the followed resident using a copied recorded drawing response.', [
  replace(['presence', 'pages', thog.pageIndex, 'residents', thog.residentIndex, 'has_drawing'], true),
  replace(['drawings', thogDrawingIndex], {
    key: 'resident:8', cached: false,
    response: { ...residentDrawing.response, body: { ...residentDrawing.response.body, type: 'resident', id: 8 } },
  }),
  event(100300, 'resident_edited', { resident_id: 8 }),
])
add(206000, 'hand-authored undrawn thing appears', 'A fictional existing undrawn thing is placed in the displayed room before its later public drawing edit.', [
  replace(thingsPath, [firstThing]),
])
add(210000, 'hand-authored existing thing drawing changes', 'The existing fictional thing changes from undrawn to drawn; the exact touched drawing response is included.', [
  replace(thingsPath, [{ ...firstThing, has_drawing: true }]),
  copiedDrawing('thing:900001', 'thing', 900001, thingDrawing),
  event(100301, 'thing_edited', { thing_id: 900001, place_id: 2 }),
])
add(214000, 'hand-authored newly crafted drawn thing', 'A newly crafted fictional thing arrives already drawn with its raw copied drawing response.', [
  replace(thingsPath, [craftedThing, { ...firstThing, has_drawing: true }]),
  copiedDrawing('thing:900002', 'thing', 900002, thingDrawing),
  event(100302, 'thing_crafted', { thing_id: 900002, place_id: 2 }),
])
add(218000, 'hand-authored local rules change', 'A fictional laws change is directly tied to the displayed room.', [
  event(100303, 'laws_changed', { place_id: 2 }),
])
add(222000, 'hand-authored home set', 'A fictional home setting is directly tied to the followed resident and displayed room.', [
  event(100304, 'home_set', { resident_id: 8, place_id: 2 }),
])
add(226000, 'hand-authored place edit', 'A fictional place edit names the displayed room without implying resident motion.', [
  event(100305, 'place_edited', { place_id: 2 }),
])
add(230000, 'hand-authored applied use', 'A fictional successful use identifies its source thing and committed room.', [
  event(100306, 'action', { action_id: 800001, action: 'use', status: 'applied', source_thing_id: 900001, place_id: 2 }),
])
add(234000, 'hand-authored noop use', 'A fictional no-op use identifies its source thing and committed room.', [
  event(100307, 'action', { action_id: 800002, action: 'use', status: 'noop', source_thing_id: 900001, place_id: 2 }),
])
add(238000, 'hand-authored scheduled effect success', 'A fictional schedule exposes only its documented public schedule fields.', [
  event(100308, 'effect_scheduled', { effect_id: 700001, place_id: 2 }),
])
add(242000, 'hand-authored linked resolved success', 'A fictional resolution is room-proven only by its earlier observed schedule.', [
  event(100309, 'effect_resolved', { effect_id: 700001, status: 'applied' }),
])
add(246000, 'hand-authored scheduled effect failure', 'A second fictional schedule supplies the public room link for a later failed resolution.', [
  event(100310, 'effect_scheduled', { effect_id: 700002, place_id: 2 }),
])
add(250000, 'hand-authored linked resolved failure', 'A fictional failed resolution keeps its documented public detail shape and does not invent a room field.', [
  event(100311, 'effect_resolved', { effect_id: 700002, status: 'failed', error: 'the delayed condition was not met' }),
])
add(254000, 'hand-authored unplaced failed action', 'A fictional failed action remains unplaced because its public record has no room evidence.', [
  event(100312, 'action', { action_id: 800003, action: 'make', status: 'failed', error: 'the recipe did not match' }),
])
add(258000, 'hand-authored exact go-home endpoints', 'A fictional go-home record is included only with its exact public endpoints.', [
  replace(['presence', 'pages', thog.pageIndex, 'residents', thog.residentIndex, 'current_place_id'], homeRoomId),
  event(100313, 'action', { action_id: 800004, action: 'go_home', status: 'applied', from_place_id: 2, to_place_id: homeRoomId }),
], [0, 250, 1000, 2500, 4000])

scene.durationMs = 262000
scene.frameTimes = [...new Set(scene.frameTimes)].filter(time => time <= scene.durationMs).sort((left, right) => left - right)
scene.metadata.extension += ' Moments after 200000 ms are labeled fictional hand-authored public-action evidence. They copy only drawing responses already in this fixture and perform no network request or city write.'
scene.metadata.generator = 'docs/evidence/follow-actions-1.8.1/make-scene.mjs'
await writeFile(destination, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
