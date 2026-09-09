import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { runViewSession } from '../scripts/lib/live-view.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('condition was not reached')
}

const makeHarness = () => {
  const input = new EventEmitter()
  const output = new EventEmitter()
  const host = new EventEmitter()
  const writes = []
  const rawModes = []
  input.isTTY = true
  input.isRaw = false
  input.isPaused = () => true
  input.setRawMode = value => rawModes.push(value)
  input.resume = () => {}
  input.pause = () => {}
  output.columns = 80
  output.rows = 24
  output.write = value => { writes.push(String(value)); return true }
  return { input, output, host, writes, rawModes }
}

const makeClock = () => {
  let nowMs = 0
  let nextId = 1
  const timers = new Map()
  const clock = {
    now: () => nowMs,
    setTimeout: (callback, delay = 0) => {
      const id = nextId++
      timers.set(id, { atMs: nowMs + Math.max(0, Number(delay)), callback })
      return id
    },
    clearTimeout: id => timers.delete(id),
  }
  const advance = async (elapsedMs) => {
    const targetMs = nowMs + elapsedMs
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.atMs <= targetMs)
        .sort((left, right) => left[1].atMs - right[1].atMs || left[0] - right[0])[0]
      if (!next) break
      const [id, timer] = next
      timers.delete(id)
      nowMs = timer.atMs
      timer.callback()
      await new Promise(resolve => setImmediate(resolve))
    }
    nowMs = targetMs
    await new Promise(resolve => setImmediate(resolve))
  }
  return { clock, advance, pending: () => timers.size }
}

const resident = (roomId) => ({
  id: 7,
  handle: 'walker',
  current_place_id: roomId,
  drawing: null,
})

const city = (name, id = 1, residentRoom = 1, { events = [], notes = [] } = {}) => ({
  ok: true,
  target: { id, name },
  residents: [
    { id: 7, handle: 'walker' },
    { id: 8, handle: 'moss' },
  ],
  rooms: [1, 2].map(roomId => ({
    id: (id * 10) + roomId,
    name: `${name} room ${roomId}`,
    drawing: null,
    things: [],
    thingsCount: 0,
    residents: residentRoom === roomId ? [resident((id * 10) + roomId)] : [],
    notes: [],
  })),
  events,
  notes,
  directory: [],
})

const closeSession = async (input, closed) => {
  input.emit('keypress', undefined, { name: 'c', ctrl: true })
  await closed
}

const visibleRows = (writes, width = 80, height = 24) => {
  const rows = Array.from({ length: height }, () => Array(width).fill(' '))
  const text = writes.join('')
  let x = 0
  let y = 0
  for (let index = 0; index < text.length;) {
    if (text[index] === '\x1b' && text[index + 1] === '[') {
      const match = /^\x1b\[([?\d;]*)([ -/]*)([@-~])/u.exec(text.slice(index))
      if (match) {
        if (match[3] === 'H' || match[3] === 'f') {
          const [row = '1', column = '1'] = match[1].split(';')
          y = Math.max(0, Number(row) - 1)
          x = Math.max(0, Number(column) - 1)
        }
        index += match[0].length
        continue
      }
    }
    const [character] = Array.from(text.slice(index))
    index += character.length
    if (character === '\n') { y += 1; x = 0; continue }
    if (character === '\r') { x = 0; continue }
    if (y >= 0 && y < height && x >= 0 && x < width) rows[y][x] = character
    x += 1
  }
  return rows.map(row => row.join(''))
}

const cursorRows = text => [...text.matchAll(/\x1b\[(\d+);\d+H/gu)].map(match => Number(match[1]))

test('an initial read failure stays open on one quiet line and retries', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const reads = []
  const replies = [
    { ok: false, error: 'SECRET stack trace: counts=99' },
    city('recovered town'),
  ]
  const source = {
    read: async (...args) => { reads.push(args); return replies.shift() },
    close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, {
    ...harness, env: {}, platform: 'win32', clock: fake.clock,
  })

  try {
    await waitFor(() => reads.length === 1 && harness.writes.join('').includes('Could not read the city.'))
    const failed = visibleRows(harness.writes)
    assert.ok(failed.slice(0, -1).every(row => row.trim() === ''))
    assert.equal(failed.at(-1).trim(), 'Could not read the city.')
    assert.doesNotMatch(harness.writes.join(''), /SECRET|stack trace|counts=99/u)
    assert.doesNotMatch(harness.writes.join(''), /\x1b\[\?1049l/u, 'the alternate screen stays open')

    await fake.advance(29_999)
    assert.equal(reads.length, 1)
    await fake.advance(1)
    await waitFor(() => reads.length === 2 && harness.writes.join('').includes('recovered town'))
    assert.equal(visibleRows(harness.writes).at(-1).trim(), '')
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('a failed refresh freezes the picture until a success clears the quiet line', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const replies = [city('steady town'), { ok: false, error: 'raw failure 42 counts' }, city('steady town')]
  let reads = 0
  const source = { read: async () => { reads += 1; return replies.shift() }, close: () => {} }
  const closed = runViewSession(source, { color: '16' }, {
    ...harness, env: {}, platform: 'win32', clock: fake.clock,
  })

  try {
    await waitFor(() => reads === 1 && harness.writes.join('').includes('steady town'))
    const before = visibleRows(harness.writes)
    const failureStart = harness.writes.length
    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 2)
    await fake.advance(125)
    await waitFor(() => harness.writes.join('').includes('Could not read the city.'))

    const failed = visibleRows(harness.writes)
    assert.deepEqual(failed.slice(0, -1), before.slice(0, -1))
    assert.equal(failed.at(-1).trim(), 'Could not read the city.')
    assert.deepEqual([...new Set(cursorRows(harness.writes.slice(failureStart).join('')))], [24])
    assert.doesNotMatch(harness.writes.join(''), /raw failure|42 counts/u)

    const frozenBytes = harness.writes.join('').length
    await fake.advance(10_000)
    assert.equal(harness.writes.join('').length, frozenBytes, 'failed state has no animation')

    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 3 && visibleRows(harness.writes).at(-1).trim() === '')
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('a failed follow read expires only its looking cue and recovery seeds an unseen burst', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const look = (startedAt, startedAtMs, expiresAtMs) => ({
    place_id: 1, started_at: startedAt, expires_at: `expiry-${expiresAtMs}`, startedAtMs, expiresAtMs,
  })
  const follow = (signal = null) => ({
    ok: true, target: { id: 1, name: 'painted room' }, focus: { id: 7, handle: 'walker', placeId: 1 },
    residents: [{ id: 7, handle: 'walker' }], events: [], notes: [],
    rooms: [{ id: 1, name: 'painted room', drawing: null, things: [], thingsCount: 0, notes: [], focusResidentId: 7,
      residents: [{ ...resident(1), asleep: true, looking: signal }] }],
  })
  const replies = [
    follow(),
    follow(look('burst-one', 0, 60_000)),
    { ok: false, error: 'private failure' },
    { ok: false, error: 'private failure' },
    follow(look('burst-two', 60_000, 120_000)),
  ]
  let reads = 0
  const source = { read: async () => { reads += 1; return replies.shift() }, close: () => {} }
  const closed = runViewSession(source, { color: '16' }, { ...harness, env: {}, platform: 'win32', clock: fake.clock })
  try {
    await waitFor(() => reads === 1 && visibleRows(harness.writes).join('\n').includes('painted room'))
    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 2)
    await fake.advance(125)
    assert.match(harness.writes.join(''), /o o|- -/u)
    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 3)
    await fake.advance(125)
    await waitFor(() => visibleRows(harness.writes).at(-1).trim() === 'Could not read the city.')
    assert.match(visibleRows(harness.writes).join('\n'), /o o|- -/u)

    await fake.advance(2_875)
    const expired = visibleRows(harness.writes).join('\n')
    assert.doesNotMatch(expired, /o o|- -/u)
    assert.doesNotMatch(expired, /\bz\b/u, 'active looking still overrides the coarse asleep mark after its short cue')
    assert.match(expired, /painted room/u)
    assert.equal(visibleRows(harness.writes).at(-1).trim(), 'Could not read the city.')

    await fake.advance(56_875)
    const asleepAgain = visibleRows(harness.writes).join('\n')
    assert.match(asleepAgain, /\bz\b/u, 'the asleep mark returns when the underlying looking signal expires offline')
    assert.equal(visibleRows(harness.writes).at(-1).trim(), 'Could not read the city.')

    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 5)
    await fake.advance(125)
    await waitFor(() => visibleRows(harness.writes).at(-1).trim() === '')
    const recovered = visibleRows(harness.writes).join('\n')
    assert.doesNotMatch(recovered, /o o|- -/u)
    assert.equal(recovered.match(/walker is looking around\./gu)?.length, 1, 'recovery does not backfill the second burst')
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('r coalesces repeated requests while one public read is pending', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const pending = deferred()
  let reads = 0
  const source = {
    read: async () => {
      reads += 1
      if (reads === 1) return city('refresh town')
      if (reads === 2) return pending.promise
      return city('refresh town')
    },
    close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, {
    ...harness, env: {}, platform: 'win32', clock: fake.clock,
  })

  try {
    await waitFor(() => reads === 1)
    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 2)
    for (let count = 0; count < 4; count += 1) harness.input.emit('keypress', 'r', { name: 'r' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 2)
    pending.resolve(city('refresh town'))
    await waitFor(() => reads === 3)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 3, 'many pending refresh keys become one follow-up read')
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('successful polls and r, Return, or terminal focus fully repaint a stale terminal', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  let reads = 0
  const source = { read: async () => { reads += 1; return city('recovery town') }, close: () => {} }
  const closed = runViewSession(source, { color: '16' }, {
    ...harness, env: {}, platform: 'win32', clock: fake.clock,
  })

  const expectFullRepaint = async (action, expectedReads) => {
    const start = harness.writes.length
    await action()
    await waitFor(() => reads === expectedReads)
    await fake.advance(125)
    const repaint = harness.writes.slice(start).join('')
    assert.match(repaint, /recovery town/u)
    assert.ok(new Set(cursorRows(repaint)).size > 1, 'repaint writes more than the quiet status row')
  }

  try {
    await waitFor(() => reads === 1 && harness.writes.join('').includes('recovery town'))
    await expectFullRepaint(async () => harness.input.emit('keypress', 'r', { name: 'r' }), 2)
    await expectFullRepaint(async () => harness.input.emit('keypress', '\r', { name: 'return' }), 3)
    await expectFullRepaint(async () => harness.input.emit('keypress', undefined, { sequence: '\x1b[I', code: '[I' }), 4)
    await expectFullRepaint(async () => fake.advance(30_000), 5)
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('the resident picker selects a new follow target and discards an older pending read', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const stale = deferred()
  const oldTown = city('old town', 1, 1)
  const newTown = city('moss room', 2, 2)
  let reads = 0
  let closes = 0
  const selections = []
  let navigationCalls = 0
  const source = {
    read: async () => {
      reads += 1
      if (reads === 1) return oldTown
      if (reads === 2) return stale.promise
      return newTown
    },
    navigate: () => { navigationCalls += 1; return { ok: true, changed: true } },
    selectResident: handle => {
      selections.push(handle)
      return { ok: true, changed: true }
    },
    close: () => { closes += 1 },
  }
  const closed = runViewSession(source, { color: '16' }, {
    ...harness, env: {}, platform: 'win32', clock: fake.clock,
  })

  try {
    await waitFor(() => reads === 1 && harness.writes.join('').includes('old town'))
    harness.input.emit('keypress', undefined, { name: 'left' })
    harness.input.emit('keypress', undefined, { name: 'right' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(navigationCalls, 0, 'arrows outside the picker do not navigate towns')
    assert.equal(reads, 1)

    harness.input.emit('keypress', 'f', { name: 'f' })
    await fake.advance(125)
    assert.ok(visibleRows(harness.writes).some(row => row.includes('Follow a resident')))
    harness.input.emit('keypress', undefined, { name: 'escape' })
    await fake.advance(125)
    assert.equal(closes, 0, 'Escape inside the picker cancels without closing the view')
    assert.ok(visibleRows(harness.writes).every(row => !row.includes('Follow a resident')))

    harness.input.emit('keypress', 'r', { name: 'r' })
    await waitFor(() => reads === 2)
    harness.input.emit('keypress', 'f', { name: 'f' })
    harness.input.emit('keypress', 'm', { name: 'm' })
    harness.input.emit('keypress', '\r', { name: 'return' })
    assert.deepEqual(selections, ['moss'])

    stale.resolve(city('ZZZZZZZZZZZZ', 99))
    await waitFor(() => reads === 3)
    await fake.advance(125)
    await waitFor(() => visibleRows(harness.writes).some(row => row.includes('moss room')))

    assert.doesNotMatch(harness.writes.join(''), /ZZZZ/u)
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('q, Escape, and Ctrl+C each restore input, screen, listeners, and timers', async (t) => {
  for (const [name, key] of [
    ['q', { name: 'q' }],
    ['Escape', { name: 'escape' }],
    ['Ctrl+C', { name: 'c', ctrl: true }],
  ]) {
    await t.test(name, async () => {
      const harness = makeHarness()
      const fake = makeClock()
      let closes = 0
      let reads = 0
      const source = { read: async () => { reads += 1; return city('closing town') }, close: () => { closes += 1 } }
      const closed = runViewSession(source, { color: '16' }, {
        ...harness, env: {}, platform: 'win32', clock: fake.clock,
      })
      await waitFor(() => reads === 1)
      harness.input.emit('keypress', undefined, key)

      assert.deepEqual(await closed, { ok: true })
      assert.equal(closes, 1)
      assert.deepEqual(harness.rawModes, [true, false])
      assert.equal(fake.pending(), 0)
      assert.equal(harness.input.listenerCount('keypress'), 0)
      assert.equal(harness.output.listenerCount('resize'), 0)
      assert.equal(harness.host.listenerCount('SIGINT'), 0)
      assert.match(harness.writes.join(''), /\x1b\[\?25h\x1b\[\?1049l/u)
    })
  }
})

test('chat keys browse only witnessed activity, hold older lines on refresh, and End returns to newest', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const observed = notes => ({
    ok: true, target: { id: 1, name: 'chat room' }, focus: { id: 7, handle: 'walker', placeId: 1 },
    residents: [resident(1)], rooms: [{ id: 1, name: 'chat room', residents: [resident(1)], things: [] }],
    notes, events: notes.map(note => ({ id: note.id, actor: 'walker', kind: 'note', detail: { note_id: note.id, place_id: 1 } })),
  })
  let notes = [{ id: 1, place_id: 1, author: 'walker', body: 'old opening history' }]
  let failed = false
  let reads = 0
  const source = { read: async () => { reads++; return failed ? { ok: false } : observed(notes) }, close: () => {} }
  const closed = runViewSession(source, { color: '16' }, { ...harness, env: {}, platform: 'win32', clock: fake.clock })
  const log = () => visibleRows(harness.writes).slice(-4, -1).join('\n')
  const key = async name => {
    harness.input.emit('keypress', undefined, { name })
    await fake.advance(125)
  }
  try {
    await waitFor(() => reads === 1 && harness.writes.join('').includes('chat room'))
    notes = [...notes, ...Array.from({ length: 8 }, (_, i) => ({ id: i + 2, place_id: 1, author: 'walker', body: `message ${i + 1}` }))]
    await key('r')
    assert.match(log(), /message 8/)
    assert.doesNotMatch(log(), /old opening history/)
    const lastRead = reads
    await key('home')
    assert.match(log(), /message 1/)
    await key('down')
    assert.doesNotMatch(log(), /message 1\b/)
    await key('pageup')
    assert.match(log(), /message 1/)
    const oldLines = log()
    notes = [...notes, { id: 10, place_id: 1, author: 'walker', body: 'latest arrival' }]
    await key('r')
    assert.equal(log(), oldLines, 'a new observation does not pull the reader away')
    await key('pagedown')
    assert.notEqual(log(), oldLines)
    await key('up')
    await key('end')
    assert.match(log(), /latest arrival/)
    assert.equal(reads, lastRead + 1, 'scroll keys do not call the city')
    failed = true
    await key('r')
    const frozenRoom = visibleRows(harness.writes).slice(0, -4)
    await key('home')
    assert.match(log(), /message 1/)
    assert.deepEqual(visibleRows(harness.writes).slice(0, -4), frozenRoom, 'offline scrolling leaves the room frozen')
    assert.equal(visibleRows(harness.writes).at(-1).trim(), 'Could not read the city.')
    await key('end')
    await key('f')
    await key('up')
    assert.match(visibleRows(harness.writes).join('\n'), /Follow a resident/)
    await key('escape')
    assert.match(log(), /latest arrival/, 'picker arrows leave chat position alone')
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('selecting another resident clears witnessed history even if the new read fails', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  const pending = deferred()
  let reads = 0
  let selected = 'walker'
  const observed = notes => ({
    ok: true, target: { id: 1, name: 'former room' }, focus: { id: 7, handle: 'walker', placeId: 1 },
    residents: [{ id: 7, handle: 'walker' }, { id: 8, handle: 'moss' }],
    rooms: [{ id: 1, name: 'former room', residents: [resident(1)], things: [] }],
    notes, events: notes.map(note => ({ id: note.id, actor: 'walker', kind: 'note', detail: { note_id: note.id, place_id: 1 } })),
  })
  const source = {
    read: async () => {
      reads++
      if (selected === 'moss') return pending.promise
      return observed(reads === 1 ? [] : [{ id: 1, place_id: 1, author: 'walker', body: 'witnessed before switching' }])
    },
    selectResident: handle => { selected = handle; return { ok: true, changed: true } },
    close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, { ...harness, env: {}, platform: 'win32', clock: fake.clock })
  try {
    await waitFor(() => reads === 1 && harness.writes.join('').includes('former room'))
    harness.input.emit('keypress', undefined, { name: 'r' })
    await fake.advance(125)
    assert.match(visibleRows(harness.writes).join('\n'), /witnessed before switching/)
    harness.input.emit('keypress', 'f', { name: 'f' })
    harness.input.emit('keypress', 'm', { name: 'm' })
    harness.input.emit('keypress', '\r', { name: 'return' })
    await fake.advance(125)
    assert.equal(reads, 3)
    assert.doesNotMatch(visibleRows(harness.writes).join('\n'), /witnessed before switching|former room/)
    pending.resolve({ ok: false })
    await fake.advance(125)
    assert.equal(visibleRows(harness.writes).at(-1).trim(), 'Could not read the city.')
    assert.doesNotMatch(visibleRows(harness.writes).join('\n'), /witnessed before switching|former room/)
    harness.input.emit('keypress', undefined, { name: 'home' })
    await fake.advance(125)
    assert.doesNotMatch(visibleRows(harness.writes).join('\n'), /witnessed before switching/)
    harness.input.emit('keypress', 'f', { name: 'f' })
    await fake.advance(125)
    assert.match(visibleRows(harness.writes).join('\n'), /walker/)
    assert.match(visibleRows(harness.writes).join('\n'), /moss/)
    harness.input.emit('keypress', 'w', { name: 'w' })
    harness.input.emit('keypress', '\r', { name: 'return' })
    await fake.advance(250)
    assert.equal(selected, 'walker')
    assert.equal(reads, 4)
    assert.match(visibleRows(harness.writes).join('\n'), /former room/)
    assert.doesNotMatch(visibleRows(harness.writes).join('\n'), /witnessed before switching/)
  } finally {
    await closeSession(harness.input, closed)
  }
})

test('long names keep scrolling between reads and the picker scrolls independently', async () => {
  const harness = makeHarness()
  const fake = makeClock()
  harness.output.columns = 38
  harness.output.rows = 18
  const longName = 'the observatory above the orchard where the lanterns sleep'
  const longHandle = 'keeper-of-the-orchard-and-the-quiet-lantern'
  let reads = 0
  let fail = false
  const source = {
    read: async () => {
      reads++
      if (fail) return { ok: false }
      return {
        ok: true, target: { id: 1, name: longName }, focus: { id: 7, handle: 'walker', placeId: 1 },
        residents: [{ id: 7, handle: longHandle }], events: [], notes: [],
        rooms: [{ id: 1, name: longName, residents: [], things: [] }],
      }
    }, close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, { ...harness, env: {}, platform: 'win32', clock: fake.clock })
  const rows = () => visibleRows(harness.writes, 38, 18)
  try {
    await waitFor(() => reads === 1 && rows()[0].includes('the observatory'))
    const opening = rows()[0]
    await fake.advance(2400)
    assert.notEqual(rows()[0], opening)
    assert.equal(reads, 1, 'name animation does not read the city')
    harness.input.emit('keypress', 'f', { name: 'f' })
    await fake.advance(125)
    const initialPicker = rows().find(row => row.includes('›'))
    await fake.advance(2400)
    assert.notEqual(rows().find(row => row.includes('›')), initialPicker)
    harness.input.emit('keypress', undefined, { name: 'escape' })
    await fake.advance(125)
    fail = true
    harness.input.emit('keypress', undefined, { name: 'r' })
    await new Promise(resolve => setImmediate(resolve))
    await fake.advance(250)
    assert.equal(rows().at(-1).trim(), 'Could not read the city.')
    const frozen = rows()
    await fake.advance(2400)
    assert.deepEqual(rows(), frozen, 'a read error still freezes the picture')
  } finally {
    await closeSession(harness.input, closed)
  }
})
