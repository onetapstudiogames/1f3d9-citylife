import { readFile, writeFile } from 'node:fs/promises'

const baseUrl = new URL('../follow-actions-1.8.1/follow-actions-scene.json', import.meta.url)
const outputUrl = new URL('./follow-looking-scene.json', import.meta.url)
const base = JSON.parse(await readFile(baseUrl, 'utf8'))
const epoch = Date.parse(base.metadata.recordedAt)
const iso = ms => new Date(epoch + ms).toISOString()
const replace = (path, value) => ({ op: 'replace', path, value })
const clone = value => structuredClone(value)

const finalRaw = clone(base.moments[0].raw)
for (const moment of base.moments.slice(1)) {
  for (const change of moment.changes ?? []) {
    let parent = finalRaw
    for (const segment of change.path.slice(0, -1)) parent = parent[segment]
    const key = change.path.at(-1)
    if (change.op === 'replace') parent[key] = clone(change.value)
    else if (change.op === 'prepend') parent[key].unshift(clone(change.value))
  }
}

const residents = finalRaw.presence.pages.flatMap((page, pageIndex) =>
  page.residents.map((resident, residentIndex) => ({ resident, pageIndex, residentIndex })))
const named = handle => {
  const found = residents.find(entry => entry.resident.handle === handle)
  if (!found) throw new Error(`The recorded scene has no resident named ${handle}.`)
  return found
}
const thog = named('thog')
const neighbor = named('dry-run')
const residentPath = entry => ['presence', 'pages', entry.pageIndex, 'residents', entry.residentIndex]
const residentAt = (entry, values) => ({ ...entry.resident, ...values })
const signal = (placeId, startedAtMs, expiresAtMs) => ({
  place_id: placeId, started_at: iso(startedAtMs), expires_at: iso(expiresAtMs),
})
const roomIndex = finalRaw.rooms.findIndex(room => Number(room.placeId) === 2)
const placeIndex = finalRaw.directory.places.findIndex(place => Number(place.id) === 2)
if (roomIndex < 0 || placeIndex < 0) throw new Error('The recorded scene must retain public room #2.')

const appendedFrames = [264000, 266000, 269000, 271000, 274000, 331000, 332000, 333000, 336000, 337000, 340000, 343000]
const metadata = (label) => ({ label, provenance: 'hand-authored-extension', cityWriteOccurred: false })
const scene = {
  ...clone(base),
  metadata: {
    ...clone(base.metadata),
    extension: 'Every original recorded moment and raw drawing is preserved as parsed data. Moments after 262000 ms are deterministic fictional looking-presence evidence. They make no network request or city write.',
    generator: 'docs/evidence/follow-looking/make-scene.mjs',
  },
  frameTimes: [...base.frameTimes, ...appendedFrames],
  durationMs: appendedFrames.at(-1),
  moments: [...clone(base.moments),
    { atMs: 264000, metadata: metadata('fictional extension seed'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 34, looking: null })),
      replace(residentPath(neighbor), residentAt(neighbor, { current_place_id: 34, looking: null })),
    ] },
    { atMs: 266000, metadata: metadata('fictional thog look'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 34, looking: signal(34, 266000, 326000) })),
    ] },
    { atMs: 271000, metadata: metadata('fictional same-burst five-second refresh'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 34, looking: signal(34, 266000, 331000) })),
    ] },
    { atMs: 332000, metadata: metadata('fictional expired signal cleared'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 34, looking: null })),
    ] },
    { atMs: 333000, metadata: metadata('fictional other resident look'), changes: [
      replace(residentPath(neighbor), residentAt(neighbor, { current_place_id: 34, looking: signal(34, 333000, 393000) })),
    ] },
    { atMs: 337000, metadata: metadata('fictional room change'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 2, looking: null })),
    ] },
    { atMs: 340000, metadata: metadata('fictional quiet-room look suppression'), changes: [
      replace(residentPath(thog), residentAt(thog, { current_place_id: 2, looking: signal(2, 340000, 400000) })),
      replace(['directory', 'places', placeIndex, 'quiet'], true),
      replace(['rooms', roomIndex, 'response', 'place', 'quiet'], true),
    ] },
  ],
}

await writeFile(outputUrl, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
