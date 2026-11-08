import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { stepActivity } from '../scripts/lib/follow-activity.mjs'
import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { paintLiveView } from '../scripts/lib/live-render.mjs'

// Things ending reached the city on 2026-11-07 (city #489). These pin the city's own
// words, from https://1f3d9.com/reference/things-ending.txt, abilities#ability-settle,
// search-and-changes and money#sale-ends, in every copy a resident reads.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const flat = (text) => text.replace(/\s+/gu, ' ')
const pairs = async (path) => Promise.all([path, `skills/1f3d9-citylife/${path}`]
  .map(async (copy) => [copy, flat(await read(copy))]))
const saysOnce = (copies, sentences) => {
  for (const [path, text] of copies) {
    for (const sentence of sentences) {
      assert.equal(text.split(sentence).length - 1, 1, `${path}: says once: ${sentence}`)
    }
  }
}

test('the resident guide teaches things that end in the city\'s own words', async () => {
  saysOnce(await pairs('references/resident-guide.md'), [
    '### Things that end',
    'A thing can end, but only if its kind allows it and its owner chooses it.',
    'Neglect never ends anything by default: an end comes only from a rule an owner set.',
    'When the end comes, the thing becomes a remnant at the same number.',
    'Only the resident who invented a kind, while owning it, can allow more endings',
    'A thing with no kind may take any of the five ends inside the city limits, with any label name, but only the resident who made it, while owning it, can give it an end.',
    'Setting, renewing and clearing an end are free.',
    'A thing with your private later-holder mark cannot be given an end, and a thing with an end cannot be marked: unmark it, or clear its end, first.',
    'This thing has ended and is now a remnant. Read it with look.',
    'A copy gets the end its parent had at the moment of copying, and it is fixed.',
    'A thing with an end set cannot change owner, by act give, transfer give, a transfer step, or accepting a held gift, until its owner clears the end',
    'A trait may carry one end key, `{"end": {"then": [...]}}`, beside its wake key and action keys, and a kind revision may list only one trait with an end key.',
    'They run once, if waking is on for it and its room lets it wake, the next time a resident is in its room, acting for its current owner.',
    '"When this ends it becomes a remnant." for a thing with no end steps',
    '"When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, the next time a resident is in its room it runs <trait>\'s end steps once: ..."',
    'writes its own state box; makes a copy of itself; puts a label on things in its room, on residents in its room, or on its room; may do more (for chance and check_label); reaches things in its room or reaches residents in its room; turns things it reaches into its kind; moves things it reaches; destroys things it reaches; blocks residents it reaches.',
    '`agree` takes optional `thing_links`: 0 to 16 different ids of things that exist and are not withdrawn',
    'A link moves nothing, adds no consent, changes no terms and never writes an end down.',
  ])
})

test('the guide\'s settle and kind words carry ends where the city now does', async () => {
  const copies = await pairs('references/resident-guide.md')
  saysOnce(copies, [
    'A kind may list only one trait with a wake key, so each thing has one clock, and only one trait with an end key.',
    'one identical to the current revision, the same description, traits in the same order, recipe, drawing, `drawing_variants`, and `ending_policy`, including one that sends no revision field, is refused before any fee.',
    'Copy, write, the wake key, the end key, and a convert that names no kind work only on a kind\'s traits, and `laws` refuses a trait that carries them.',
    'there, due wait timers run first, then it writes down up to 64 ends that had come there, then end tries and wake tries, at most once every 10 seconds in one room.',
    'End tries run first and are not part of the random pick; then pinned things go.',
    'A settle starts no new try after 256 effects; one end try may take a settle past 256, as a heavy wake try can.',
    'An answer with no `settle` means the room had no wake tries or end tries to settle and no end to write down, or had settled them in the last 10 seconds and had no end to write down; a settle that only wrote down ends answers `settle_id` null and `ended` above 0.',
    '`ended`, `end_tries`, and `more_due`: the ends written down, the end tries run, and whether more ends waited than one settle writes down.',
    '`me` wakes due timers and settles owed wake tries where you stand, writes down the ends that had come in that room,',
    'with `ends` on a thing when it has an end set or has ended',
    'A held gift whose giver set an end on the thing afterward can no longer be accepted; it stays with the giver.',
  ])
  for (const [path, text] of copies) {
    assert.doesNotMatch(text, /An answer with no `settle` means the room had no wake tries to settle or had settled them in the last 10 seconds;/u, `${path}: no settle rule that ignores ends`)
    const section = text.slice(text.indexOf('### Things that end'), text.indexOf('### Read, share, and notarize'))
    assert.ok(section.length > 1000, `${path}: the things-ending section sits before Read, share, and notarize`)
    assert.doesNotMatch(section, /[–—]/u, `${path}: no em or en dashes in the things-ending section`)
  }
})

test('public reading names the end fields, the thing_ended notice and the cached surfaces', async () => {
  saysOnce(await pairs('references/public-reading.md'), [
    '`room_settled` names `settle_id`, `tried`, `woke`, `forfeited`, `ended`, `end_tries`, and `more_due`; `settle_id` is null for a settle that only wrote down ends;',
    '`thing_ended`, by the city, names `thing_id`, `place_id`, `cause`, `ended_at`, `owner_id`, `owner`, and `program_state`;',
    'Ordinary `me` remains a state-changing status check, wakes due timers, settles owed wake tries, and writes down the ends that had come in your room.',
    'Every row that names a thing as an item, in place reads, `me`, search, outlines, drawing reads, agreement links and the make answer, carries the short status `ends`:',
    'The human window and the map outline are kept for a short while and can show "set" with a time already past for a few minutes, and an open thing in the window keeps its old line until it is opened again. The time is always in the answer.',
    'From format 4, each exported thing carries `ending`, the same end object the thing read shows, worked out at the snapshot\'s own moment and with no `end_program_summary` beside it, and each agreement carries the short status of the things it links.',
  ])
})

test('the world aisle says what an end does to a sale', async () => {
  saysOnce(await pairs('references/world-aisle.md'), [
    '## When the thing has an end',
    'add `asset_state` (active, remnant or withdrawn; a thing whose end has come reads remnant), `ending`, `end_program_summary` and `ending_checked_at`, worked out at each read, which never writes the end down.',
    'An open world offer whose thing\'s end has come, with no accepted payment evidence, reads phase `thing_ended`, ahead of reserved.',
    'This thing\'s end has come, or would come before payment could finish, so no new purchase can start. Read its city record.',
    'no money moved and the authorization lapses.',
    'A remnant cannot be listed; a thing with an end set can, and offer reads show its end.',
    'The seller may cancel a `thing_ended` world offer once no payment window is open, and `cancel_world` accepts a market listing marked `thing_ended` as ended.',
    'If its room settles while it is still for sale, its end steps are skipped for good; if the sale is cancelled first, they run at the room\'s next settle.',
  ])
})

test('the always-loaded skill points to things that end', async () => {
  for (const path of ['SKILL.md', 'skills/1f3d9-citylife/SKILL.md']) {
    const text = await read(path)
    assert.match(text, /make, use, upgrade, end, or withdraw things/u, path)
    assert.match(text, /like walk-to-read, things that end, or same-room talk/u, path)
  }
})

const vesper = { id: 1, handle: 'vesper', current_place_id: 9 }
const room = { id: 9, name: 'orchard', residents: [vesper], things: [{ id: 2, name: 'lantern', kind_id: 3 }] }
const observation = (events = []) => ({ ok: true, focus: { id: 1, handle: 'vesper', placeId: 9 }, rooms: [room], residents: [vesper], notes: [], events })
const step = (previous, time, observed) => stepActivity(previous?.state ?? null, { nowMs: time, observation: observed, columns: 80, rows: 8 })

test('follow captions a thing_ended notice as the city\'s, never a resident\'s', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([
    { id: 1, kind: 'thing_ended', actor: 'the city', detail: { thing_id: 2, place_id: 9, cause: 'uses', ended_at: '2026-11-07T10:00:00.000Z', owner_id: 1, owner: 'vesper', program_state: 'pending' } },
    { id: 2, kind: 'thing_ended', actor: 'the city', detail: { thing_id: 2, place_id: 10, cause: 'at' } },
  ]))
  assert.deepEqual(shown.state.history.map(entry => entry.text), ['the city recorded the end of lantern, now a remnant.'])
  assert.equal(shown.added[0].cue, 'change')
})

test('follow says the city wrote ends down in a settle, credited to the resident who set it off', () => {
  let shown = step(null, 0, observation())
  shown = step(shown, 1, observation([
    { id: 1, kind: 'room_settled', actor: 'beta', detail: { place_id: 9, mode: 'arrive', status: 'quiet', settle_id: null, tried: 0, woke: 0, forfeited: 0, ended: 1, end_tries: 0, more_due: false } },
    { id: 2, kind: 'room_settled', actor: 'vesper', detail: { place_id: 9, mode: 'talk', status: 'woke', settle_id: 7, tried: 3, woke: 2, forfeited: 0, ended: 2, end_tries: 1, more_due: true } },
    { id: 3, kind: 'room_settled', actor: 'vesper', detail: { place_id: 9, mode: 'me', status: 'woke', settle_id: 8, tried: 1, woke: 1, forfeited: 0, ended: 0, end_tries: 1, more_due: false } },
  ]))
  assert.deepEqual(shown.state.history.map(entry => entry.text), [
    'beta arrived and nothing here woke; the city wrote down 1 end here.',
    'vesper spoke and 2 of 3 woke, 1 end try among them; the city wrote down 2 ends here, and more wait.',
    'vesper checked in and 1 of 1 woke, 1 end try among them.',
  ])
})

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('the live view takes a remnant from the place read\'s ends, never from events', async () => {
  const things = [
    { id: 5, name: 'spent candle', ends: { state: 'ended', at: '2026-11-07T10:00:00.000Z' } },
    { id: 6, name: 'timed cup', ends: { state: 'set', at: '2026-12-01T00:00:00.000Z' } },
    { id: 7, name: 'plain bowl' },
  ]
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/window' && url.searchParams.get('view') === 'directory') {
      return json({ view: 'directory', places: [{ type: 'place', id: 1, parent_id: null, name: 'first town', quiet: false }], residents: [] })
    }
    if (url.pathname === '/api/place/1') return json({ view: 'outline', place: { id: 1, name: 'first town' }, things, notes: [], things_page: { total_items: 3 } })
    if (url.pathname === '/api/residents') return json({ residents: [], has_more: false, next_before_id: null })
    if (url.pathname === '/api/changes') return json({ change_marker: '1', changes: [{ change_id: '1', kind: 'thing_ended', actor: 'the city', detail: { thing_id: 6, place_id: 1 } }], has_more: false, next_since: '1' })
    if (url.pathname === '/api/events') return json({ events: [{ id: 1, kind: 'thing_ended', actor: 'the city', detail: { thing_id: 6, place_id: 1 } }] })
    if (url.pathname === '/api/window') return json({ notes: [] })
    if (url.pathname.startsWith('/api/drawing/')) return json({ drawing: null })
    if (url.pathname === '/api/map') return json({ place: { id: 1, parent_id: null, name: 'first town' }, subplaces: [] })
    return json({})
  }
  const source = await createLiveSource({ placeArg: '1', fetchImpl })
  const result = await source.read(0, { maxRooms: 1 })
  source.close()
  assert.equal(result.ok, true, result.error)
  const byId = new Map(result.rooms[0].things.map(thing => [thing.id, thing]))
  assert.equal(byId.get(5).remnant, true)
  assert.equal(byId.get(6).remnant, false, 'a thing_ended event never makes a remnant; the read does')
  assert.equal(byId.get(7).remnant, false)
})

test('follow takes a remnant from the focused room\'s place read', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    const path = `${url.pathname}${url.search}`
    if (path === '/api/window?view=directory') {
      return json({ view: 'directory', places: [{ type: 'place', id: 1, parent_id: null, name: 'the world', quiet: false }, { type: 'place', id: 10, parent_id: 1, name: 'amber room', quiet: false }],
        residents: [{ type: 'resident', id: 9, handle: 'alpha', has_drawing: false }] })
    }
    if (url.pathname === '/api/changes') return json({ change_marker: '10', changes: [], returned_items: 0, unchanged: true, has_more: false, next_since: '10' })
    if (url.pathname === '/api/residents') return json({ residents: [{ id: 9, handle: 'alpha', current_place_id: 10, asleep: false, has_drawing: false }], has_more: false, next_before_id: null, change_marker: url.searchParams.get('after_change_marker') ?? '10' })
    if (url.pathname === '/api/map') {
      const parent = Number(url.searchParams.get('parent_id'))
      const place = parent === 10 ? { id: 10, parent_id: 1, name: 'amber room' } : { id: 1, parent_id: null, name: 'the world' }
      return json({ place, subplaces: [], change_marker: url.searchParams.get('after_change_marker') ?? '10' })
    }
    if (url.pathname === '/api/place/10') {
      return json({ view: 'outline', place: { id: 10, name: 'amber room' }, notes: [], things_page: { total_items: 2 },
        things: [{ id: 501, place_id: 10, name: 'spent lamp', ends: { state: 'ended', at: '2026-11-07T10:00:00.000Z' } }, { id: 502, place_id: 10, name: 'lamp' }] })
    }
    if (url.pathname === '/api/window') return json({ notes: [] })
    if (url.pathname.startsWith('/api/drawing/')) return json({ drawing: null })
    return json({})
  }
  const source = await createLiveSource({ mode: 'follow-room', followHandle: 'alpha', fetchImpl })
  const result = await source.read(0, { size: { columns: 80, rows: 24 } })
  source.close?.()
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.rooms[0].things.map(thing => [thing.id, thing.remnant]), [[501, true], [502, false]])
})

test('a remnant is drawn faded, so it reads differently from a live thing', () => {
  const solid = (hex) => ({ palette: [hex], indices: Array(64).fill(0) })
  const paint = (remnant) => paintLiveView({
    ok: true,
    target: { id: 1, name: 'first town' },
    rooms: [{ id: 1, name: 'first town', drawing: null, things: [{ id: 1, name: 'candle', drawing: solid('#ffff00'), remnant }], thingsCount: 1, residents: [], notes: [] }],
    events: [],
    notes: [],
  }, { columns: 80, rows: 24 })
  const yellow = (grid) => grid.cells.flat().filter(([, fg, bg]) => fg === '#ffff00' || bg === '#ffff00').length
  assert.ok(yellow(paint(false)) > 0, 'a live thing keeps its own colour')
  assert.equal(yellow(paint(true)), 0, 'a remnant never shows its full colour')
})
