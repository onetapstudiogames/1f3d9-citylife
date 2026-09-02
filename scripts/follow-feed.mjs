#!/usr/bin/env node
// Runs standalone inside a spawned terminal window (see follow.mjs). Reads
// only public, anonymous records; never signs in, never writes anything.
// Refreshes every 30 seconds until the window is closed or Ctrl+C is pressed.

import { renderFollowSnapshot } from './lib/follow-render.mjs'

const handle = process.argv[2]
if (!handle) {
  console.error('Usage: node follow-feed.mjs <handle>')
  process.exit(1)
}

const REFRESH_MS = 30_000
const CLEAR_SCREEN = '\x1b[2J\x1b[H'

let stopped = false
let timer = null
process.on('SIGINT', () => {
  stopped = true
  if (timer) clearInterval(timer)
  console.log('\nStopped following. Close this window whenever you like.')
})

const tick = async () => {
  if (stopped) return
  let snapshot
  try {
    snapshot = await renderFollowSnapshot(handle)
  } catch (error) {
    snapshot = `Could not read the public record right now (${error?.message || error}). Retrying in 30 seconds.`
  }
  if (stopped) return
  process.stdout.write(CLEAR_SCREEN)
  console.log(snapshot)
  console.log('')
  console.log(`(refreshed every 30 seconds from the public record · Ctrl+C to stop)`)
}

await tick()
if (!stopped) timer = setInterval(tick, REFRESH_MS)
