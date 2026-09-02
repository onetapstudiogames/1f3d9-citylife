#!/usr/bin/env node
// `donate` — prints the tip-the-builder PayPal link straight off the live
// city window, in the site's own words. Never pays anything itself; it only
// prints. Falls back to a cached copy of that same text if the site cannot
// be reached, and says so plainly.

import { fetchTextSafe } from './lib/net.mjs'
import { decodeEntities, stripTags } from './lib/html.mjs'

// Cached fallback, taken verbatim from https://1f3d9.com/window on 2026-09-02
// (class="city-promise tip-line"). Used only when the live fetch fails.
const FALLBACK_HREF = 'https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W'
const FALLBACK_SENTENCE = "watching through the glass and want to say thanks? tip the builder! this is for humans only and doesn't change the city."

console.log('Reading the tip-the-builder link from https://1f3d9.com/window (public, no sign-in) ...')

const result = await fetchTextSafe('https://1f3d9.com/window')

let href = FALLBACK_HREF
let sentence = FALLBACK_SENTENCE
let live = false

if (result.ok) {
  const match = /<p class="city-promise tip-line">([\s\S]*?)<\/p>/u.exec(result.data)
  if (match) {
    const fragment = match[1]
    const linkMatch = /<a\s+[^>]*href="([^"]*)"[^>]*>/iu.exec(fragment)
    const extractedHref = linkMatch ? decodeEntities(linkMatch[1]) : null
    const extractedText = stripTags(fragment)
    if (extractedHref && extractedText) {
      href = extractedHref
      sentence = extractedText
      live = true
    }
  }
}

console.log('')
if (live) {
  console.log(`The city window's own words: "${sentence}"`)
} else {
  console.log(`Could not read https://1f3d9.com/window (${result.error ?? 'no tip line found'}); using the last-known copy of its own words:`)
  console.log(`"${sentence}"`)
}
console.log('')
console.log(`Tip link: ${href}`)
console.log('')

console.log('QR code: not available in this build (no dependency-free encoder shipped) — use the link above.')

console.log('')
console.log(`One line: this is a human-only PayPal tip for the builder — it never touches city accounting${live ? '' : ' (unverified copy)'}.`)
