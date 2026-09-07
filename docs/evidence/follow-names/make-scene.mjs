import { readFile, writeFile } from 'node:fs/promises'

const output = process.argv[2]
if (!output) throw Error('Pass the JSON scene output path.')
const scene = JSON.parse(await readFile(new URL('../follow-polish/follow-polish-scene.json', import.meta.url), 'utf8'))
const raw = scene.moments[0].raw
const roomIndex = raw.rooms.findIndex(room => room.placeId === 2)
const placeIndex = raw.directory.places.findIndex(place => place.id === 2)
const neighbor = raw.presence.pages.flatMap((page, pageIndex) =>
  page.residents.map((resident, residentIndex) => ({ resident, pageIndex, residentIndex })))
  .find(({ resident }) => resident.handle === 'pollux')
if (roomIndex < 0 || placeIndex < 0 || !neighbor) throw Error('Expected recorded subjects are absent.')
const name = 'the observatory above the orchard where quiet lanterns rest beside the very last apple tree'
const replace = (path, value) => ({ op: 'replace', path, value })
scene.moments.push({
  atMs: 160000,
  metadata: {
    provenance: 'hand-authored-extension', cityWriteOccurred: false,
    purpose: 'Fictional long names exercise label scrolling. Original moments, public identities and drawing responses remain unchanged; no rename was sent to the city.',
  },
  changes: [
    replace(['target', 'name'], name),
    replace(['directory', 'places', placeIndex, 'name'], name),
    replace(['rooms', roomIndex, 'response', 'place', 'name'], name),
    replace(['presence', 'pages', neighbor.pageIndex, 'residents', neighbor.residentIndex, 'handle'], 'keeper-of-the-quiet-lantern'),
    replace(['rooms', roomIndex, 'response', 'things', 0, 'name'], 'the little copper teapot with a painted moon on its lid'),
  ],
})
scene.durationMs = 200000
scene.frameTimes = [...scene.frameTimes, ...Array.from({ length: 26 }, (_, index) => 160000 + index * 1600)]
scene.metadata.extension += ' The 160000 ms moment changes only fictional displayed names for this review; all earlier moments and every drawing response are preserved.'
scene.metadata.generator = 'docs/evidence/follow-names/make-scene.mjs'
await writeFile(output, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
