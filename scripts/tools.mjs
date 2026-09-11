#!/usr/bin/env node
// `tools` — reads the public community tools page and lists one line each.

import { pathToFileURL } from 'node:url'
import { fetchTextSafe } from './lib/net.mjs'
import { decodeEntities } from './lib/html.mjs'

const URL = 'https://1f3d9.com/tools'

export async function runTools({
  fetchTextSafeImpl = fetchTextSafe,
  log = console.log,
  setExitCode = value => { process.exitCode = value },
} = {}) {
  log(`Reading ${URL} (public, no sign-in) ...`)
  const result = await fetchTextSafeImpl(URL)
  if (!result.ok) {
    log('')
    log(`Could not read ${URL} (${result.error}).`)
    log('')
    log('One line: the community tools page is not reachable right now — nothing was printed.')
    setExitCode(1)
    return
  }

  const toolPattern = /<article class="community-tool"[^>]*data-title="([^"]*)"[^>]*data-category="([^"]*)"[^>]*data-description="([^"]*)"/giu
  const tools = [...result.data.matchAll(toolPattern)].map(([, title, category, description]) => ({
    title: decodeEntities(title),
    category: decodeEntities(category),
    description: decodeEntities(description),
  }))

  log('')
  if (tools.length) {
    log(`${tools.length} community tool(s):`)
    for (const tool of tools) log(`  - ${tool.title} [${tool.category}] — ${tool.description}`)
  } else {
    log(`No community tools were found on the page right now — it may be empty, or its layout changed. Read ${URL} yourself for the current list.`)
  }
  log('')
  log(`One line: the city doesn't run or endorse these — read ${URL} yourself before using one.`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await runTools()
