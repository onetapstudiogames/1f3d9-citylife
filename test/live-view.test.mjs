import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { toPlainText } from '../scripts/lib/grid.mjs'
import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { createReplay, dumpReplay, parseViewArgs, runViewSession } from '../scripts/lib/live-view.mjs'

const observation = { ok: true, target: { id: 1, name: 'home' }, rooms: [] }
const sceneFile = new URL('./fixtures/live-scene.json', import.meta.url)
const execFileAsync = promisify(execFile)

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition was not reached')
}

const makeSessionHarness = ({ isTTY = true } = {}) => {
  const input = new EventEmitter()
  const output = new EventEmitter()
  const host = new EventEmitter()
  const writes = []
  const rawModes = []
  input.isTTY = isTTY
  input.isRaw = false
  input.isPaused = () => true
  input.setRawMode = value => rawModes.push(value)
  input.resume = () => {}
  input.pause = () => {}
  output.columns = 80
  output.rows = 24
  output.write = text => { writes.push(String(text)); return true }
  return { input, output, host, writes, rawModes }
}

const makeFakeClock = (startMs = 0) => {
  let nowMs = startMs
  let nextId = 1
  const timers = new Map()
  const fired = []
  const clock = {
    now: () => nowMs,
    setTimeout: (callback, delay = 0) => {
      const id = nextId
      nextId += 1
      timers.set(id, { atMs: nowMs + Math.max(0, Number(delay)), callback, delay: Number(delay) })
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
      fired.push({ atMs: nowMs, delay: timer.delay })
      timer.callback()
      await new Promise(resolve => setImmediate(resolve))
    }
    nowMs = targetMs
    await new Promise(resolve => setImmediate(resolve))
  }
  return { clock, advance, fired, pending: () => timers.size }
}

const frameFromDump = (text, timeMs) => {
  const marker = `frame ${String(timeMs).padStart(6, '0')} ms | `
  const start = text.indexOf(marker)
  if (start < 0) return null
  const next = text.indexOf('\nframe ', start + marker.length)
  return text.slice(start, next < 0 ? undefined : next)
}

const roomObservation = (count) => ({
  ok: true,
  target: { id: 1, name: 'first town' },
  rooms: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `room ${String.fromCharCode(97 + index)}`,
    residents: [],
  })),
})

const walkingObservation = (roomId, events = []) => ({
  ok: true,
  target: { id: 1, name: 'first town' },
  rooms: [1, 2].map(id => ({
    id,
    name: `room ${id}`,
    things: [],
    thingsCount: 0,
    notes: [],
    residents: id === roomId
      ? [{ id: 7, handle: 'walker', current_place_id: roomId, drawing: null }]
      : [],
  })),
  events,
  notes: [],
})

test('view arguments keep scene, size, and color explicit and reject typos', () => {
  assert.equal(parseViewArgs(['--scene', 'scene.json', '--fail-at', '30000']).failAt, 30000)
  assert.throws(() => parseViewArgs(['--fail-at', '30000']), /scene/u)
  assert.deepEqual(parseViewArgs(['first town', '--scene', 'scene.json', '--size', '80x24', '--color', '256']), {
    placeArg: 'first town', sceneFile: 'scene.json', columns: 80, rows: 24, color: '256',
  })
  assert.equal(parseViewArgs(['dpl', '--scene', 'scene.json'], 'follow').followHandle, 'dpl')
  assert.deepEqual(parseViewArgs(['--once', '--scene', 'scene.json', '--at', '30000']), {
    once: true, sceneFile: 'scene.json', at: 30000,
  })
  for (const args of [['--unknown'], ['--scene'], ['--size', '0x24'], ['--color', '8'], ['--at', '1'], ['one', 'two']]) {
    assert.throws(() => parseViewArgs(args), /view|scene|size|color|argument/u)
  }
  assert.throws(() => parseViewArgs([], 'follow'), /resident handle/u)
})

test('the real fixture produces byte-identical plain and ANSI dumps without networking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-view-replay-'))
  let networkCalls = 0
  const source = await createLiveSource({
    sceneFile,
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('offline dump attempted the network')
    },
  })
  try {
    await dumpReplay(source, { columns: 80, rows: 24, dump: join(directory, 'one.txt') })
    await dumpReplay(source, { columns: 80, rows: 24, dump: join(directory, 'two.txt') })
    assert.deepEqual(await readFile(join(directory, 'one.txt')), await readFile(join(directory, 'two.txt')))
    assert.deepEqual(await readFile(join(directory, 'one.txt.ansi')), await readFile(join(directory, 'two.txt.ansi')))
    const plain = await readFile(join(directory, 'one.txt'), 'utf8')
    const ansi = await readFile(join(directory, 'one.txt.ansi'), 'utf8')
    assert.match(plain, /frame 030000 ms \| 80x24/u)
    assert.match(plain, /first town/u)
    assert.doesNotMatch(plain, /\x1b/u)
    assert.match(ansi, /\x1b\[38;2;/u)
    assert.equal(networkCalls, 0)
  } finally {
    source.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('--at replays earlier polls before rendering an animation frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'city-view-at-'))
  const sources = []
  try {
    const dump = async (name, at) => {
      const source = await createLiveSource({ sceneFile, fetchImpl: async () => { throw new Error('network') } })
      sources.push(source)
      const path = join(directory, `${name}.txt`)
      await dumpReplay(source, { columns: 120, rows: 40, dump: path, ...(at === undefined ? {} : { at }) })
      return readFile(path, 'utf8')
    }
    const full = await dump('full')
    const at30500 = await dump('at-30500', 30500)
    const at32000 = await dump('at-32000', 32000)

    assert.equal(frameFromDump(at30500, 30500), frameFromDump(full, 30500))
    assert.notEqual(frameFromDump(at30500, 30500)?.split('\n').slice(1).join('\n'), frameFromDump(at32000, 32000)?.split('\n').slice(1).join('\n'))
  } finally {
    for (const source of sources) source.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('replay reads source moments only and expires a note bubble after six seconds', async () => {
  const source = await createLiveSource({ sceneFile, fetchImpl: async () => { throw new Error('network') } })
  const reads = []
  const originalRead = source.read.bind(source)
  source.read = async (timeMs, options) => {
    reads.push(timeMs)
    return originalRead(timeMs, options)
  }
  try {
    const replay = createReplay(source, { columns: 120, rows: 40 })
    const at0 = await replay.at(0)
    const at30000 = await replay.at(30000)
    const at60000 = await replay.at(60000)
    const at65999 = await replay.at(65999)
    const at66000 = await replay.at(66000)

    assert.deepEqual(reads, [0, 30000, 60000])
    assert.doesNotMatch(toPlainText(at0.frame), /The fair grass remembers/u)
    assert.doesNotMatch(toPlainText(at30000.frame), /The fair grass remembers/u)
    assert.match(toPlainText(at60000.frame), /The fair grass remembers/u)
    assert.doesNotMatch(toPlainText(at60000.frame), /every small arrival/u)
    assert.match(toPlainText(at65999.frame), /The fair grass remembers/u)
    assert.doesNotMatch(toPlainText(at66000.frame), /The fair grass remembers/u)
    await assert.rejects(() => replay.at(source.durationMs + 1), /duration|scene time/iu)
  } finally {
    source.close()
  }
})

test('--once CLI renders the real fixture as plain text offline', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../scripts/live.mjs', import.meta.url)),
    '--once', '--scene', fileURLToPath(sceneFile), '--size', '80x24', '--at', '30000',
  ], { timeout: 5000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /first town/u)
  assert.doesNotMatch(stdout, /\x1b/u)
  assert.equal(stderr, '')
})

test('the reviewed 120x40 note frame matches its plain text snapshot', async () => {
  const source = await createLiveSource({ sceneFile })
  try {
    const result = await createReplay(source, { columns: 120, rows: 40 }).at(62000)
    assert.equal(toPlainText(result.frame), await readFile(new URL('./fixtures/live-frame-120x40.txt', import.meta.url), 'utf8'))
  } finally { source.close() }
})

test('replay failure freezes the picture, recovers at the next moment, and ignores requested frame cadence', async () => {
  const fixture = await createLiveSource({ sceneFile })
  const source = {
    ...fixture,
    read: async (time, request) => time === 30000 ? { ok: false, error: 'raw stack must stay private' } : fixture.read(time, request),
  }
  const size = { columns: 80, rows: 24 }
  const paced = createReplay(source, size)
  await paced.at(0)
  await paced.at(4000)
  const failed = await paced.at(30000)
  assert.match(toPlainText(failed.frame).split('\n').at(-2), /Could not read the city\./u)
  assert.doesNotMatch(toPlainText(failed.frame), /raw stack/u)
  assert.equal(toPlainText((await paced.at(32000)).frame), toPlainText(failed.frame))
  assert.equal(toPlainText((await createReplay(source, size).at(30000)).frame), toPlainText(failed.frame))
  const recovered = await paced.at(60000)
  assert.doesNotMatch(toPlainText(recovered.frame), /Could not read the city/u)
  assert.equal(toPlainText(recovered.frame).split('\n').at(-2).trim(), '')
  source.close()
})

test('q during a pending read restores the terminal and aborts the source', async () => {
  const { input, output, host, writes, rawModes } = makeSessionHarness()
  let aborted = false
  const source = { read: () => new Promise(() => {}), close: () => { aborted = true } }
  const closed = runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })
  input.emit('keypress', 'q', { name: 'q' })
  await closed
  assert.equal(aborted, true)
  assert.deepEqual(rawModes, [true, false])
  assert.equal(host.listenerCount('SIGINT'), 0)
  assert.match(writes.join(''), /\x1b\[\?25h\x1b\[\?1049l/u)
  assert.match(writes.at(-1), /View closed\./u)
})

test('interactive timing separates public reads from bounded unchanged paints and q clears timers', async () => {
  const { input, output, host, writes } = makeSessionHarness()
  const fake = makeFakeClock(10_000)
  const reads = []
  const source = {
    read: async (timeMs) => {
      reads.push({ atMs: fake.clock.now(), timeMs })
      return reads.length === 1
        ? walkingObservation(1)
        : walkingObservation(2, [{
          id: 1,
          kind: 'action',
          actor: 'walker',
          detail: { action: 'move', status: 'applied', from_place_id: 1, to_place_id: 2 },
        }])
    },
    close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, {
    input, output, host, env: {}, platform: 'win32', clock: fake.clock,
  })
  await waitFor(() => reads.length === 1)
  await new Promise(resolve => setImmediate(resolve))
  const unchangedBytes = writes.join('').length

  await fake.advance(1_000)
  assert.equal(reads.length, 1, 'animation ticks do not read public state')
  assert.equal(writes.join('').length, unchangedBytes, 'an unchanged frame writes no terminal bytes')
  const animationFirings = fake.fired.filter(timer => timer.delay < 30_000)
  assert.ok(animationFirings.length <= 8, `animation painted ${animationFirings.length} times in one second`)

  await fake.advance(28_999)
  assert.equal(reads.length, 1)
  await fake.advance(1)
  assert.equal(reads.length, 2)
  assert.deepEqual(reads.map(read => read.atMs), [10_000, 40_000])

  const writesBeforeWalk = writes.length
  await fake.advance(1_000)
  const walkWrites = writes.length - writesBeforeWalk
  assert.ok(walkWrites > 0 && walkWrites <= 8, `active animation wrote ${walkWrites} frames in one second`)

  input.emit('keypress', 'q', { name: 'q' })
  assert.deepEqual(await closed, { ok: true })
  assert.equal(fake.pending(), 0)
})

test('q pauses a pristine stdin but preserves an input that was already flowing', async (t) => {
  for (const [name, readableFlowing, expectedPauses] of [
    ['pristine stdin', null, 1],
    ['already flowing stdin', true, 0],
  ]) {
    await t.test(name, async () => {
      const { input, output, host } = makeSessionHarness()
      let pauses = 0
      let resumes = 0
      input.readableFlowing = readableFlowing
      input.isPaused = () => false
      input.pause = () => { pauses += 1 }
      input.resume = () => { resumes += 1 }
      const source = { read: () => new Promise(() => {}), close: () => {} }
      const closed = runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })

      input.emit('keypress', 'q', { name: 'q' })
      assert.deepEqual(await closed, { ok: true })
      assert.equal(resumes, 1)
      assert.equal(pauses, expectedPauses)
    })
  }
})

test('resizes during a pending read coalesce and repaint at the current dimensions', async () => {
  const { input, output, host, writes } = makeSessionHarness()
  const fake = makeFakeClock()
  const firstRead = deferred()
  const requests = []
  const source = {
    durationMs: 0,
    read: async (_nowMs, request) => {
      requests.push(request)
      if (requests.length === 1) return firstRead.promise
      return roomObservation(3)
    },
    close: () => {},
  }
  const closed = runViewSession(source, { color: '16' }, { input, output, host, env: {}, platform: 'win32', clock: fake.clock })

  output.columns = 100
  output.rows = 30
  output.emit('resize')
  output.columns = 120
  output.rows = 40
  output.emit('resize')
  firstRead.resolve(roomObservation(2))
  await waitFor(() => requests.length === 2)
  await fake.advance(125)
  assert.match(writes.join(''), /room c/u)

  input.emit('keypress', 'q', { name: 'q' })
  await closed
  assert.deepEqual(requests, [
    { maxRooms: 2, size: { columns: 80, rows: 24 } },
    { maxRooms: 3, size: { columns: 120, rows: 40 } },
  ], 'two resizes while reading request one current-size reread')
  assert.match(writes.join(''), /\x1b\[40;1H/u, 'the pending result paints into the latest 120x40 bounds')
  assert.match(writes.join(''), /room c/u, 'the coalesced reread adds the third room visible at 120 columns')
})

test('read errors keep the session open until q restores the screen and removes every listener', async () => {
  const { input, output, host, writes } = makeSessionHarness({ isTTY: false })
  let closes = 0
  const source = { read: async () => ({ ok: false, error: 'offline' }), close: () => { closes += 1 } }
  const closed = runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })
  await waitFor(() => writes.join('').includes('Could not read the city.'))
  assert.equal(closes, 0)
  host.emit('SIGINT')
  const result = await closed

  assert.deepEqual(result, { ok: true })
  assert.equal(closes, 1)
  assert.match(writes.join(''), /\x1b\[\?25h\x1b\[\?1049l/u)
  assert.match(writes.at(-1), /View closed\./u)
  for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit']) {
    assert.equal(host.listenerCount(event), 0)
  }
  assert.equal(output.listenerCount('resize'), 0)
})

test('signals and crashes share cleanup while preserving honest outcomes', async (t) => {
  for (const [event, expectedMessage, expectedOk] of [
    ['SIGINT', 'View closed.', true],
    ['SIGTERM', 'View closed.', true],
    ['uncaughtException', 'Could not read the city.', false],
    ['unhandledRejection', 'Could not read the city.', false],
  ]) {
    await t.test(event, async () => {
      const { input, output, host, writes, rawModes } = makeSessionHarness()
      let closes = 0
      const source = { read: () => new Promise(() => {}), close: () => { closes += 1 } }
      const closed = runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })
      host.emit(event, new Error('simulated crash'))
      assert.deepEqual(await closed, { ok: expectedOk })
      assert.equal(closes, 1)
      assert.deepEqual(rawModes, [true, false])
      assert.match(writes.at(-1), new RegExp(expectedMessage.replaceAll('.', '\\.'), 'u'))
      assert.equal(host.listenerCount(event), 0)
    })
  }
})

test('a source cleanup exception still restores input, screen, and listeners', async () => {
  const { input, output, host, writes, rawModes } = makeSessionHarness()
  const source = {
    read: () => new Promise(() => {}),
    close: () => { throw new Error('simulated close failure') },
  }
  const closed = runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })
  input.emit('keypress', 'q', { name: 'q' })

  assert.deepEqual(await closed, { ok: false })
  assert.deepEqual(rawModes, [true, false])
  assert.match(writes.join(''), /\x1b\[\?25h\x1b\[\?1049l/u)
  assert.match(writes.at(-1), /View closed\./u)
  assert.equal(input.listenerCount('keypress'), 0)
  assert.equal(output.listenerCount('resize'), 0)
  assert.equal(host.listenerCount('SIGINT'), 0)
})
