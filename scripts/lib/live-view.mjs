import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { DARK, Grid, toAnsi, toPlainText } from './grid.mjs'
import { paintLiveView, visibleRoomLimit } from './live-render.mjs'
import { createLiveSource } from './live-source.mjs'
import { stepMotion } from './live-motion.mjs'
import { stepFollowMotion } from './follow-motion.mjs'
import { paintPicker, updatePicker } from './follow-picker.mjs'
import { chooseColorMode } from './terminal-colors.mjs'
import { TerminalScreen } from './terminal-screen.mjs'
import { openTerminalRunning } from './terminal.mjs'
import { prepareLegacyConsole } from './legacy-console.mjs'
import { pluginRoot } from './paths.mjs'

const REFRESH_MS = 30_000
const FRAME_MS = 125
const READ_ERROR = 'Could not read the city.'
const realClock = { now: () => performance.now(), setTimeout, clearTimeout }

export const parseViewArgs = (args) => {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--once') { options.once = true; continue }
    if (!arg.startsWith('-')) { positionals.push(arg); continue }
    if (!['--scene', '--dump', '--size', '--color', '--at', '--fail-at'].includes(arg)) throw new Error(`unknown view argument: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`view argument ${arg} needs a value`)
    if (arg === '--scene') options.sceneFile = value
    if (arg === '--dump') options.dump = value
    if (arg === '--size') {
      const match = /^(\d{1,3})x(\d{1,3})$/u.exec(value)
      if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error('view size must be columnsxrows, such as 80x24')
      options.columns = Number(match[1])
      options.rows = Number(match[2])
    }
    if (arg === '--color') {
      if (!['truecolor', '256', '16'].includes(value)) throw new Error('view color must be truecolor, 256, or 16')
      options.color = value
    }
    if (arg === '--at' || arg === '--fail-at') {
      if (!/^\d{1,9}$/u.test(value)) throw new Error('scene time must be milliseconds')
      options[arg === '--at' ? 'at' : 'failAt'] = Number(value)
    }
  }
  if (positionals.length > 1) throw new Error('follow view accepts one resident argument')
  if ((options.dump || options.at !== undefined || options.failAt !== undefined) && !options.sceneFile) throw new Error('--dump, --at, and --fail-at require --scene')
  if (!positionals[0]) throw new Error('follow view needs a resident handle')
  options.followHandle = positionals[0]
  return options
}

const stepViewMotion = (previous, options) => options.observation?.focus || previous?.observation?.focus
  ? stepFollowMotion(previous, options)
  : stepMotion(previous, options)

const paintMotion = (observation, size, motion) => paintLiveView(motion?.observation ?? observation, size, motion?.frame)

const sizeOf = (options, output) => ({
  columns: options.columns ?? output.columns ?? 80,
  rows: options.rows ?? output.rows ?? 24,
})

const readObservation = async (source, nowMs, size) => {
  const observation = await source.read(nowMs, { maxRooms: visibleRoomLimit(size), size })
  if (!observation.ok) throw new Error('Could not read the city.')
  return observation
}

const quietFrame = (picture, size, message) => {
  const grid = new Grid(size.columns, size.rows, DARK.bg)
  for (let y = 0; y < Math.min(picture?.height ?? 0, grid.height - 1); y += 1) {
    for (let x = 0; x < Math.min(picture.width, grid.width); x += 1) grid.cells[y][x] = [...picture.cells[y][x]]
  }
  grid.put(1, grid.height - 1, message, DARK.muted, DARK.bg, Math.max(0, grid.width - 2))
  return grid
}

/** Replay observations in order, then advance only the decorative clock. */
export const createReplay = (source, size) => {
  const moments = source.momentTimes ?? [0]
  let index = 0
  let state = null
  let observation = null
  let previousTime = -1
  let error = null
  let picture = null
  return {
    async at(nowMs) {
      if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < previousTime || nowMs > source.durationMs) {
        throw new Error('scene time must stay within its duration and move forward')
      }
      while (index < moments.length && moments[index] <= nowMs) {
        const time = moments[index++]
        if (state && !error) {
          const advanced = stepViewMotion(state, { nowMs: time, size })
          state = advanced.state
          picture = paintMotion(observation, size, advanced)
        }
        try {
          observation = await readObservation(source, time, size)
          state = stepViewMotion(state, { nowMs: time, observation, size }).state
          error = null
        } catch {
          error = READ_ERROR
        }
      }
      const motion = !error && state ? stepViewMotion(state, { nowMs, size }) : null
      if (motion) {
        state = motion.state
        picture = paintMotion(observation, size, motion)
      }
      previousTime = nowMs
      return { observation, motion, error, frame: error ? quietFrame(picture, size, error) : picture }
    },
  }
}

/** File output uses a fake clock and fixed cell bounds; it never reads wall time. */
export const dumpReplay = async (source, options) => {
  const size = sizeOf(options, {})
  const times = options.at === undefined ? source.frameTimes : [options.at]
  if (!Array.isArray(times) || !times.length) throw new Error('scene has no frame times')
  const frames = []
  const coloredFrames = []
  const replay = createReplay(source, size)
  for (const time of times) {
    const { frame } = await replay.at(time)
    frames.push(`frame ${String(time).padStart(6, '0')} ms | ${size.columns}x${size.rows}\n${toPlainText(frame)}`)
    coloredFrames.push(`frame ${String(time).padStart(6, '0')} ms | ${size.columns}x${size.rows}\n${toAnsi(frame, undefined, options.color ?? 'truecolor')}`)
  }
  await writeFile(options.dump, frames.join('\n'), 'utf8')
  await writeFile(`${options.dump}.ansi`, coloredFrames.join('\n'), 'utf8')
  return { frames: frames.length, path: options.dump }
}

/** Run one terminal session. Cleanup is shared by keys, signals, and failures. */
export const runViewSession = (source, options, {
  input = process.stdin, output = process.stdout, host = process,
  env = process.env, platform = process.platform,
  clock = realClock,
} = {}) => new Promise(resolveClosed => {
  const screen = new TerminalScreen({
    output,
    mode: options.color ?? chooseColorMode({ env, platform, isTTY: true }),
    synchronized: platform === 'win32' ? Boolean(env.WT_SESSION) : Boolean(env.TMUX || /iterm|ghostty/iu.test(env.TERM_PROGRAM ?? '')),
  })
  let stopped = false
  let reading = false
  let refreshAgain = false
  let observation = null
  let pollTimer = null
  let motionTimer = null
  let paintTimer = null
  let motion = null
  let lastPaintMs = -Infinity
  let lastPicture = null
  let nextNameAtMs = null
  let frozenPicture = null
  let quietError = null
  let generation = 0
  let resetMotion = false
  let picker = null
  let pickerResidents = []
  const startedAt = clock.now()
  const now = () => options.at ?? Math.min(clock.now() - startedAt, source.durationMs ?? Infinity)
  const oldRaw = Boolean(input.isRaw)
  const wasFlowing = input.readableFlowing === true

  const finish = (message = 'View closed.') => {
    if (stopped) return
    stopped = true
    for (const timer of [pollTimer, motionTimer, paintTimer]) clock.clearTimeout(timer)
    let cleanupFailed = false
    try { source.close?.() } catch { cleanupFailed = true }
    input.removeListener('keypress', onKey)
    output.removeListener('resize', onResize)
    host.removeListener('SIGINT', onSignal)
    host.removeListener('SIGTERM', onSignal)
    host.removeListener('uncaughtException', onCrash)
    host.removeListener('unhandledRejection', onCrash)
    host.removeListener('exit', onExit)
    try {
      if (input.isTTY) input.setRawMode(oldRaw)
      if (!wasFlowing) input.pause()
    } catch {
      cleanupFailed = true
    }
    try {
      screen.restore()
      output.write(`${message}\n`)
    } catch {
      cleanupFailed = true
    }
    resolveClosed({ ok: message === 'View closed.' && !cleanupFailed })
  }
  const onSignal = () => finish()
  const onCrash = () => finish('Could not read the city.')
  const onExit = () => {
    try { if (input.isTTY) input.setRawMode(oldRaw) } finally { screen.restore() }
  }
  const resync = () => {
    void refresh()
  }
  const onKey = (text, key = {}) => {
    if (key.ctrl && key.name === 'c') { finish(); return }
    if (key.sequence === '\x1b[I') { resync(); return }
    if (picker) {
      const selected = updatePicker(picker, text, key, pickerResidents)
      picker = selected.cancelled ? null : selected.picker
      if (selected.handle) {
        const result = source.selectResident?.(selected.handle)
        if (result?.ok) {
          picker = null
          if (result.changed) {
            generation += 1
            resetMotion = true
            observation = null
            motion = null
            lastPicture = null
            frozenPicture = null
            quietError = null
            clock.clearTimeout(motionTimer)
            void refresh()
          }
        } else showError(options.sceneFile ? 'That resident is not in this recording.' : READ_ERROR)
      }
      present()
      return
    }
    if (key.name === 'q' || key.name === 'escape') finish()
    else if (key.name === 'r' || key.name === 'return') resync()
    else if (key.name === 'f') { picker = { query: '', index: 0 }; present() }
    else if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name) && motion?.state?.activity) {
      motion = stepViewMotion(motion.state, {
        nowMs: quietError ? motion.state.nowMs : now(), size: sizeOf(options, output), scroll: key.name,
      })
      if (quietError) frozenPicture = paintMotion(observation, sizeOf(options, output), motion)
      present()
      scheduleMotion()
    }
  }
  const onResize = () => {
    if (stopped) return
    screen.invalidate()
    if (quietError) present()
    else if (observation) animate(true)
    void refresh()
  }
  const schedule = () => {
    if (stopped || options.at !== undefined) return
    const nextRead = source.momentTimes?.find(time => time > now()) ?? now() + REFRESH_MS
    if (nextRead > (source.durationMs ?? Infinity)) return
    pollTimer = clock.setTimeout(() => { void refresh() }, nextRead - now())
  }
  const present = () => {
    if (stopped || (!observation && !quietError && !resetMotion)) return
    clock.clearTimeout(paintTimer)
    paintTimer = null
    const delay = lastPaintMs + FRAME_MS - clock.now()
    if (delay > 0) {
      paintTimer = clock.setTimeout(present, delay)
      return
    }
    const size = sizeOf(options, output)
    const picture = quietError || (resetMotion && !observation)
      ? quietFrame(frozenPicture, size, quietError ?? '')
      : paintMotion(observation, size, motion)
    const frame = picker ? paintPicker(picture, picker, pickerResidents, observation?.focus?.handle, now()) : picture
    nextNameAtMs = frame.nextNameAtMs ?? null
    if (screen.present(frame)) {
      lastPaintMs = clock.now()
      lastPicture = picture
    }
    scheduleMotion()
  }
  const showError = (message = READ_ERROR) => {
    if (!quietError) frozenPicture = lastPicture
    quietError = message
    clock.clearTimeout(motionTimer)
    clock.clearTimeout(paintTimer)
    present()
  }
  const scheduleMotion = () => {
    clock.clearTimeout(motionTimer)
    const wakeTimes = [motion?.nextAtMs, nextNameAtMs].filter(Number.isFinite)
    if (stopped || quietError || options.at !== undefined || !wakeTimes.length) return
    const nextAtMs = Math.min(...wakeTimes)
    if (nextAtMs > (source.durationMs ?? Infinity)) return
    motionTimer = clock.setTimeout(() => animate(), Math.max(FRAME_MS, nextAtMs - now()))
  }
  const animate = (force = false) => {
    if (stopped || quietError || !observation) return
    motion = stepViewMotion(motion?.state ?? null, { nowMs: now(), size: sizeOf(options, output) })
    if (force || motion.changed) present()
    scheduleMotion()
  }
  const refresh = async () => {
    if (stopped) return
    if (reading) { refreshAgain = true; return }
    reading = true
    const readGeneration = generation
    clock.clearTimeout(pollTimer)
    try {
      const size = sizeOf(options, output)
      const result = options.at !== undefined
        ? await createReplay(source, size).at(options.at)
        : { observation: await readObservation(source, now(), size) }
      if (stopped) return
      if (readGeneration !== generation) { refreshAgain = true; return }
      if (result.error) {
        frozenPicture = result.frame
        quietError = result.error
        present()
        return
      }
      observation = result.observation
      pickerResidents = observation.residents ?? []
      quietError = null
      frozenPicture = null
      motion = result.motion ?? stepViewMotion(resetMotion ? null : motion?.state ?? null, {
        nowMs: now(), observation, size: sizeOf(options, output),
      })
      resetMotion = false
      screen.invalidate()
      present()
      scheduleMotion()
    } catch {
      if (!stopped && readGeneration === generation) showError()
    } finally {
      reading = false
      if (refreshAgain && !stopped) {
        refreshAgain = false
        void refresh()
      } else schedule()
    }
  }

  host.on('SIGINT', onSignal)
  host.on('SIGTERM', onSignal)
  host.on('uncaughtException', onCrash)
  host.on('unhandledRejection', onCrash)
  host.on('exit', onExit)
  output.on('resize', onResize)
  try {
    screen.enter()
    if (input.isTTY) {
      emitKeypressEvents(input)
      input.setRawMode(true)
      input.on('keypress', onKey)
      input.resume()
    }
    void refresh()
  } catch {
    finish('Could not open the drawn view.')
  }
})

export const runDrawnView = async (options) => {
  const legacy = !options.dump && !options.once && process.stdout.isTTY
    ? await prepareLegacyConsole()
    : { mode: 'ansi' }
  if (legacy.mode === 'relaunched') {
    if (legacy.exitCode) process.exitCode = legacy.exitCode
    return
  }
  const source = await createLiveSource({ ...options, mode: 'follow-room' })
  try {
    if (options.dump) {
      const result = await dumpReplay(source, options)
      console.log(`Saved ${result.frames} frames to ${result.path}.`)
      return
    }
    if (options.once || !process.stdout.isTTY || legacy.mode === 'plain') {
      const size = sizeOf(options, process.stdout)
      const { frame } = options.sceneFile
        ? await createReplay(source, size).at(options.at ?? 0)
        : { frame: paintLiveView(await readObservation(source, 0, size), size) }
      process.stdout.write(`${legacy.mode === 'plain' ? `${legacy.message}\n` : ''}${toPlainText(frame)}`)
      return
    }
    const result = await runViewSession(source, options)
    if (!result.ok) process.exitCode = 1
  } finally {
    source.close?.()
  }
}

export const viewCommand = async (args, { feed = false } = {}) => {
  try {
    const options = parseViewArgs(args)
    if (feed || options.dump || options.once) return await runDrawnView(options)
    const script = resolve(pluginRoot, 'scripts', 'follow-feed.mjs')
    const result = await openTerminalRunning(script, args, { title: '1F3D9 follow' })
    if (result.opened) console.log('The follow view was launched in a terminal window.')
    else await runDrawnView({ ...options, once: true })
  } catch (error) {
    console.error(error?.message ?? 'Could not open the drawn view.')
    process.exitCode = 1
  }
}
