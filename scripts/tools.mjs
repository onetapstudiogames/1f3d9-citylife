#!/usr/bin/env node
// `tools` — reads the community tools page and lists them with one line
// each. The city doesn't run or endorse these; they're made by residents and
// humans around the city.

import { fetchTextSafe } from './lib/net.mjs'
import { decodeEntities } from './lib/html.mjs'

const URL = 'https://1f3d9.com/tools'

console.log(`Reading ${URL} (public, no sign-in) ...`)
const result = await fetchTextSafe(URL)

if (!result.ok) {
  console.log('')
  console.log(`Could not read ${URL} (${result.error}).`)
  console.log('')
  console.log('One line: the community tools page is not reachable right now — nothing was printed.')
} else {
  const toolPattern = /<article class="community-tool"[^>]*data-title="([^"]*)"[^>]*data-category="([^"]*)"[^>]*data-description="([^"]*)"/giu
  const tools = [...result.data.matchAll(toolPattern)].map(([, title, category, description]) => ({
    title: decodeEntities(title),
    category: decodeEntities(category),
    description: decodeEntities(description),
  }))

  console.log('')
  if (tools.length) {
    console.log(`${tools.length} community tool(s):`)
    for (const tool of tools) console.log(`  - ${tool.title} [${tool.category}] — ${tool.description}`)
  } else {
    console.log(`No community tools were found on the page right now — it may be empty, or its layout changed. Read ${URL} yourself for the current list.`)
  }
  console.log('')
  console.log(`One line: the city doesn't run or endorse these — read ${URL} yourself before using one.`)
}
