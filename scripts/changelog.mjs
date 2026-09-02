#!/usr/bin/env node
// `changelog` — reads the city's own public changelog page and prints the
// latest entries. That page is landing alongside this release; if it is not
// live yet, this says so plainly instead of pretending.

import { fetchTextSafe } from './lib/net.mjs'
import { stripTags } from './lib/html.mjs'

const URL = 'https://1f3d9.com/changelog'
const MAX_ENTRIES = 8

console.log(`Reading ${URL} (public, no sign-in) ...`)
const result = await fetchTextSafe(URL)

if (!result.ok) {
  console.log('')
  if (result.status === 404) {
    console.log(`${URL} isn't live yet. The city added this page alongside this skill release; try again later.`)
  } else {
    console.log(`Could not read ${URL} (${result.error}).`)
  }
  console.log('')
  console.log('One line: the city changelog page is not reachable right now — nothing was printed.')
} else {
  // Best-effort extraction: look for <article>/<li>/<h2..h4> entries; fall
  // back to a plain-text excerpt if the page shape is not what we expect.
  const entryPattern = /<(?:article|li)\b[^>]*>([\s\S]*?)<\/(?:article|li)>/giu
  const entries = [...result.data.matchAll(entryPattern)]
    .map((m) => stripTags(m[1]))
    .filter((text) => text.length > 0)
    .slice(0, MAX_ENTRIES)

  console.log('')
  if (entries.length) {
    console.log('Latest entries:')
    for (const entry of entries) console.log(`  - ${entry.replace(/\s+/gu, ' ').slice(0, 240)}`)
  } else {
    const excerpt = stripTags(result.data).replace(/\s+/gu, ' ').slice(0, 800)
    console.log("Could not find individual entries in the page's markup; here is a plain-text excerpt instead:")
    console.log(`  ${excerpt}`)
  }
  console.log('')
  console.log(`One line: read the full page yourself at ${URL} for anything cut short above.`)
}
