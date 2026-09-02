#!/usr/bin/env node
// `live [place]` — entry point. Opens a new terminal window running
// live-feed.mjs: the drawn text-grid view (rooms as box-drawing boxes,
// residents as coloured half-block portraits) refreshed every 30 seconds.
// On a host with no real terminal, renders one frame inline instead.

import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { openTerminalRunning } from './lib/terminal.mjs'
import { buildLiveScene } from './lib/live-render.mjs'
import { toPlainText } from './lib/grid.mjs'

const main = async () => {
  const place = process.argv[2]

  console.log(`Opening the live text-grid view${place ? ` of "${place}"` : ''}, refreshed from the public record every 30 seconds.`)

  const feedScript = resolve(pluginRoot, 'scripts', 'live-feed.mjs')
  const args = place ? [place] : []
  const result = await openTerminalRunning(feedScript, args, { title: '1F3D9 live' })

  if (result.opened) {
    console.log(`Launched: ${result.commandLine}${result.pid ? ` (pid ${result.pid})` : ''}`)
    console.log('A window should have appeared; close it to stop the live view.')
    console.log(`One line: launched ${result.commandLine} to draw the live view in its own window.`)
    return
  }

  console.log(`No real terminal window is available here (${result.reason}), so here is one frame instead:`)
  console.log('')
  const outcome = await buildLiveScene(place, 'desktop')
  if (outcome.ok) {
    console.log(toPlainText(outcome.scene))
    console.log(`One line: this host can't open a terminal window, so ${outcome.target.name} was drawn once instead of live.`)
  } else {
    console.log(`Could not build the live view (${outcome.error}).`)
    console.log('One line: the live view is unavailable right now — try https://1f3d9.com/window instead.')
  }
}

await main()
