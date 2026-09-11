#!/usr/bin/env node
// `donate` — prints the tip-the-builder PayPal link from the live city
// window. It never pays; a failed read uses the checked backup and exits 1.

import { pathToFileURL } from 'node:url'
import { fetchTextSafe } from './lib/net.mjs'
import { extractDonateLink } from './lib/public-command-output.mjs'

const FALLBACK_HREF = 'https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W'
const FALLBACK_SENTENCE = 'For humans only; buys nothing and changes nothing in the city.'

export async function runDonate({
  fetchTextSafeImpl = fetchTextSafe,
  log = console.log,
  setExitCode = value => { process.exitCode = value },
} = {}) {
  log('Reading the tip-the-builder link from https://1f3d9.com/window (public, no sign-in) ...')
  const result = await fetchTextSafeImpl('https://1f3d9.com/window')
  const extracted = result.ok ? extractDonateLink(result.data) : null
  const href = extracted?.href ?? FALLBACK_HREF
  const sentence = extracted?.sentence ?? FALLBACK_SENTENCE

  log('')
  if (extracted) {
    log(`The city window's own words: "${sentence}"`)
  } else {
    const reason = result.ok ? 'the current tip button did not match its checked shape' : result.error
    log(`Could not verify the tip button at https://1f3d9.com/window (${reason}); using the last-known copy of its own words:`)
    log(`"${sentence}"`)
    setExitCode(1)
  }
  log('')
  log(`Tip link: ${href}`)
  log('')
  log('QR code: not available in this build (no dependency-free encoder shipped) — use the link above.')
  log('')
  log(`One line: this is a human-only PayPal tip for the builder — it never touches city accounting${extracted ? '' : ' (unverified copy)'}.`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await runDonate()
