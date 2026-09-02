#!/usr/bin/env node
// Runs standalone inside a spawned terminal window (see live.mjs). Draws the
// same text-grid look as the owner-reviewed mock, from real public reads.
// Refreshes every 30 seconds until the window closes or Ctrl+C is pressed.

import { buildLiveScene } from './lib/live-render.mjs'
import { toAnsi, DARK } from './lib/grid.mjs'

const place = process.argv[2]
const REFRESH_MS = 30_000
const CLEAR_SCREEN = '\x1b[2J\x1b[H'

let stopped = false
let timer = null
process.on('SIGINT', () => {
  stopped = true
  if (timer) clearInterval(timer)
  console.log('\nStopped. Close this window whenever you like.')
})

const tick = async () => {
  if (stopped) return
  let frame
  try {
    const outcome = await buildLiveScene(place, 'desktop')
    frame = outcome.ok
      ? toAnsi(outcome.scene, DARK)
      : `Could not read the public record right now (${outcome.error}). Retrying in 30 seconds.\n`
  } catch (error) {
    frame = `Could not read the public record right now (${error?.message || error}). Retrying in 30 seconds.\n`
  }
  if (stopped) return
  process.stdout.write(CLEAR_SCREEN)
  process.stdout.write(frame)
  console.log('(refreshed every 30 seconds from the public record · Ctrl+C to stop)')
}

await tick()
if (!stopped) timer = setInterval(tick, REFRESH_MS)
