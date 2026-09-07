import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { toAnsi, toPlainText } from './grid.mjs'
import { paintLiveView, visibleRoomLimit } from './live-render.mjs'
import { createLiveSource } from './live-source.mjs'
import { chooseColorMode } from './terminal-colors.mjs'
import { TerminalScreen } from './terminal-screen.mjs'
import { openTerminalRunning } from './terminal.mjs'
import { pluginRoot } from './paths.mjs'

const REFRESH_MS = 30_000

export const parseViewArgs = (args, kind = 'live') => {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--once') { options.once = true; continue }
    if (!arg.startsWith('-')) { positionals.push(arg); continue }
    if (!['--scene', '--dump', '--size', '--color', '--at'].includes(arg)) throw new Error(`unknown view argument: ${arg}`)
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
    if (arg === '--at') {
      if (!/^\d{1,9}$/u.test(value)) throw new Error('scene time must be milliseconds')
      options.at = Number(value)
    }
  }
  if (positionals.length > 1) throw new Error('view accepts one place or resident argument')
  if ((options.dump || options.at !== undefined) && !options.sceneFile) throw new Error('--dump and --at require --scene')
  if (kind === 'follow') {
    if (!positionals[0]) throw new Error('follow view needs a resident handle')
    options.followHandle = positionals[0]
  } else if (positionals[0]) options.placeArg = positionals[0]
  return options
}

const sizeOf = (options, output) => ({
  columns: options.columns ?? output.columns ?? 80,
  rows: options.rows ?? output.rows ?? 24,
})

const readFrame = async (source, nowMs, size) => {
  const observation = await source.read(nowMs, { maxRooms: visibleRoomLimit(size), size })
  if (!observation.ok) throw new Error('Could not read the city.')
  return { observation, frame: paintLiveView(observation, size) }
}

/** File output uses a fake clock and fixed cell bounds; it never reads wall time. */
export const dumpReplay = async (source, options) => {
  const size = sizeOf(options, {})
  const times = options.at === undefined ? source.frameTimes : [options.at]
  if (!Array.isArray(times) || !times.length) throw new Error('scene has no frame times')
  const frames = []
  const coloredFrames = []
  for (const time of times) {
    const { frame } = await readFrame(source, time, size)
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
} = {}) => new Promise(resolveClosed => {
  const screen = new TerminalScreen({
    output,
    mode: options.color ?? chooseColorMode({ env, platform, isTTY: true }),
    synchronized: Boolean(env.WT_SESSION || env.TMUX || (platform !== 'win32' && /iterm|ghostty/iu.test(env.TERM_PROGRAM ?? ''))),
  })
  let stopped = false
  let reading = false
  let refreshAgain = false
  let observation = null
  let timer = null
  let sceneNow = options.at ?? 0
  const oldRaw = Boolean(input.isRaw)
  const wasFlowing = input.readableFlowing === true

  const finish = (message = 'View closed.') => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
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
  const onKey = (_text, key = {}) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) finish()
  }
  const onResize = () => {
    if (stopped) return
    screen.invalidate()
    if (observation) screen.present(paintLiveView(observation, sizeOf(options, output)))
    void refresh()
  }
  const schedule = () => {
    if (stopped || options.at !== undefined) return
    if (source.durationMs !== undefined && sceneNow + REFRESH_MS > source.durationMs) return
    timer = setTimeout(() => {
      if (source.durationMs !== undefined) sceneNow += REFRESH_MS
      void refresh()
    }, REFRESH_MS)
  }
  const refresh = async () => {
    if (stopped) return
    if (reading) { refreshAgain = true; return }
    reading = true
    clearTimeout(timer)
    try {
      const result = await readFrame(source, source.durationMs === undefined ? 0 : sceneNow, sizeOf(options, output))
      if (stopped) return
      observation = result.observation
      screen.present(paintLiveView(observation, sizeOf(options, output)))
    } catch {
      if (!stopped) finish('Could not read the city.')
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
  const source = await createLiveSource(options)
  try {
    if (options.dump) {
      const result = await dumpReplay(source, options)
      console.log(`Saved ${result.frames} frames to ${result.path}.`)
      return
    }
    if (options.once || !process.stdout.isTTY) {
      const { frame } = await readFrame(source, options.at ?? 0, sizeOf(options, process.stdout))
      process.stdout.write(toPlainText(frame))
      return
    }
    const result = await runViewSession(source, options)
    if (!result.ok) process.exitCode = 1
  } finally {
    source.close?.()
  }
}

export const viewCommand = async (kind, args, { feed = false } = {}) => {
  try {
    const options = parseViewArgs(args, kind)
    if (feed || options.dump || options.once) return await runDrawnView(options)
    const script = resolve(pluginRoot, 'scripts', `${kind}-feed.mjs`)
    const result = await openTerminalRunning(script, args, { title: kind === 'follow' ? '1F3D9 follow' : '1F3D9 live' })
    if (result.opened) console.log('The city view was launched in a terminal window.')
    else await runDrawnView({ ...options, once: true })
  } catch (error) {
    console.error(error?.message ?? 'Could not open the drawn view.')
    process.exitCode = 1
  }
}
