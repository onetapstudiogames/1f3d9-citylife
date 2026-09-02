#!/usr/bin/env node
// `follow <handle>` — entry point. Opens a new terminal window running
// follow-feed.mjs, a plain text feed refreshed from the public record every
// 30 seconds. Costs the agent nothing after launch: this script exits as
// soon as the window is open (or, with no real terminal, after printing one
// inline snapshot).

import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { openTerminalRunning } from './lib/terminal.mjs'
import { renderFollowSnapshot } from './lib/follow-render.mjs'

const main = async () => {
  const handle = process.argv[2]
  if (!handle) {
    console.error('Usage: follow <handle>')
    process.exitCode = 1
    return
  }

  console.log(`Opening a live text feed for ${handle}, refreshed from the public record every 30 seconds.`)

  const feedScript = resolve(pluginRoot, 'scripts', 'follow-feed.mjs')
  const result = await openTerminalRunning(feedScript, [handle])

  if (result.opened) {
    console.log(`One line: a new terminal window is now following ${handle}; close that window to stop.`)
  } else {
    console.log(`No real terminal window is available here (${result.reason}), so here is one snapshot instead:`)
    console.log('')
    console.log(await renderFollowSnapshot(handle))
    console.log('')
    console.log(`One line: this host can't open a terminal window, so ${handle}'s feed was shown once instead of live.`)
  }
}

await main()
