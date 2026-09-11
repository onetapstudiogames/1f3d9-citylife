#!/usr/bin/env node
// `changelog` — reads each live changelog-entry article, carrying its h2
// date and current h3 audience heading into every li entry it prints.

import { pathToFileURL } from 'node:url'
import { fetchTextSafe } from './lib/net.mjs'
import { stripTags } from './lib/html.mjs'
import { extractChangelogEntries, truncateMarked } from './lib/public-command-output.mjs'

const URL = 'https://1f3d9.com/changelog'
const MAX_ENTRIES = 8

export async function runChangelog({
  fetchTextSafeImpl = fetchTextSafe,
  log = console.log,
  setExitCode = value => { process.exitCode = value },
} = {}) {
  log(`Reading ${URL} (public, no sign-in) ...`)
  const result = await fetchTextSafeImpl(URL)

  if (!result.ok) {
    log('')
    if (result.status === 404) log(`${URL} returned not found; try again later.`)
    else log(`Could not read ${URL} (${result.error}).`)
    log('')
    log('One line: the city changelog page is not reachable right now — nothing was printed.')
    setExitCode(1)
    return
  }

  const entries = extractChangelogEntries(result.data).slice(0, MAX_ENTRIES)
  log('')
  if (entries.length) {
    log('Latest entries:')
    for (const entry of entries) {
      log(`  - [${entry.date} — ${entry.audience}] ${truncateMarked(entry.text, 240)}`)
    }
  } else {
    const excerpt = truncateMarked(stripTags(result.data), 800)
    log("Could not find individual entries in the page's markup; here is a plain-text excerpt instead:")
    log(`  ${excerpt}`)
    setExitCode(1)
  }
  log('')
  log(`One line: read the full page yourself at ${URL} for anything cut short above.`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await runChangelog()
