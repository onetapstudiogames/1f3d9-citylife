import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createLiveSource } from '../scripts/lib/live-source.mjs'
import { dumpReplay, parseViewArgs, runViewSession } from '../scripts/lib/live-view.mjs'

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

const roomObservation = (count) => ({
  ok: true,
  target: { id: 1, name: 'first town' },
  rooms: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `room ${String.fromCharCode(97 + index)}`,
    residents: [],
  })),
})

test('view arguments keep scene, size, and color explicit and reject typos', () => {
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

test('--once CLI renders the real fixture as plain text offline', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../scripts/live.mjs', import.meta.url)),
    '--once', '--scene', fileURLToPath(sceneFile), '--size', '80x24', '--at', '30000',
  ], { timeout: 5000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /first town/u)
  assert.doesNotMatch(stdout, /\x1b/u)
  assert.equal(stderr, '')
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
  const closed = runViewSession(source, { color: '16' }, { input, output, host, env: {}, platform: 'win32' })

  output.columns = 100
  output.rows = 30
  output.emit('resize')
  output.columns = 120
  output.rows = 40
  output.emit('resize')
  firstRead.resolve(roomObservation(2))
  await waitFor(() => requests.length === 2 && writes.join('').includes('room c'))

  input.emit('keypress', 'q', { name: 'q' })
  await closed
  assert.deepEqual(requests, [
    { maxRooms: 2, size: { columns: 80, rows: 24 } },
    { maxRooms: 3, size: { columns: 120, rows: 40 } },
  ], 'two resizes while reading request one current-size reread')
  assert.match(writes.join(''), /\x1b\[40;1H/u, 'the pending result paints into the latest 120x40 bounds')
  assert.match(writes.join(''), /room c/u, 'the coalesced reread adds the third room visible at 120 columns')
})

test('read errors restore the screen, close the source, and remove every listener', async () => {
  const { input, output, host, writes } = makeSessionHarness({ isTTY: false })
  let closes = 0
  const source = { read: async () => ({ ok: false, error: 'offline' }), close: () => { closes += 1 } }
  const result = await runViewSession(source, {}, { input, output, host, env: {}, platform: 'win32' })

  assert.deepEqual(result, { ok: false })
  assert.equal(closes, 1)
  assert.match(writes.join(''), /\x1b\[\?25h\x1b\[\?1049l/u)
  assert.match(writes.at(-1), /Could not read the city\./u)
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
