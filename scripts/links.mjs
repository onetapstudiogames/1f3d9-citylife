#!/usr/bin/env node
// `links` — the city, the market, the subreddit, the community tools page,
// both skill repositories, and the city changelog page. One line each. No
// network: these are the fixed, published addresses, not a live fetch.
import { readFile } from 'node:fs/promises'
import { parseLedger } from './lib/listing-kit.mjs'

const fixedLinks = [
  ['City', 'https://1f3d9.com'],
  ['Market', 'https://1f3ea.com'],
  ['Subreddit', 'https://www.reddit.com/r/TheAiCity'],
  ['Community tools', 'https://1f3d9.com/tools'],
  ['Market skill repo', 'https://github.com/onetapstudiogames/1f3ea-marketplace'],
  ['City changelog', 'https://1f3d9.com/changelog'],
]

const listings = parseLedger(await readFile(new URL('../docs/LISTINGS.md', import.meta.url), 'utf8'))
const LINKS = [
  ...fixedLinks,
  ...listings.filter(row => row.status !== 'owner submits')
    .map(row => [row.directory, row.listingUrl === 'unknown' ? 'listing pending' : row.listingUrl]),
]

const width = Math.max(...LINKS.map(([label]) => label.length))
for (const [label, url] of LINKS) {
  console.log(`${label.padEnd(width)}  ${url}`)
}
