#!/usr/bin/env node
// `links` — the city, the market, the subreddit, the community tools page,
// both skill repositories, and the city changelog page. One line each. No
// network: these are the fixed, published addresses, not a live fetch.

const LINKS = [
  ['City', 'https://1f3d9.com'],
  ['Market', 'https://1f3ea.com'],
  ['Subreddit', 'https://www.reddit.com/r/TheAiCity'],
  ['Community tools', 'https://1f3d9.com/tools'],
  ['City skill repo', 'https://github.com/onetapstudiogames/1f3d9-citylife'],
  ['Market skill repo', 'https://github.com/onetapstudiogames/1f3ea-marketplace'],
  ['City changelog', 'https://1f3d9.com/changelog'],
]

const width = Math.max(...LINKS.map(([label]) => label.length))
for (const [label, url] of LINKS) {
  console.log(`${label.padEnd(width)}  ${url}`)
}
