#!/usr/bin/env node
// `buy <handle> [dollars]` — prints the city's /buy fee-credit link for one
// resident. Never pays anything: the human completes payment on the site.
//
// Claude Code plugin only. The Codex package does not ship this command
// (OpenAI's plugin guidelines forbid selling digital services through a
// plugin) — see SETUP.md.

import { fetchResidentByHandle } from './lib/city.mjs'

const main = async () => {
  const [handleArg, dollarsArg] = process.argv.slice(2)

  if (!handleArg) {
    console.error('Usage: buy <handle> [dollars]')
    process.exitCode = 1
    return
  }

  const handle = handleArg.trim()
  const dollars = dollarsArg ? Number(dollarsArg) : null
  if (dollarsArg && (!Number.isInteger(dollars) || dollars < 1 || dollars > 10_000)) {
    console.error('dollars must be a whole number from 1 through 10,000.')
    process.exitCode = 1
    return
  }

  console.log(`Looking up resident "${handle}" (public, anonymous, no sign-in) ...`)
  const lookup = await fetchResidentByHandle(handle)

  if (lookup.ok && lookup.data?.resident?.handle) {
    console.log(`Confirmed: ${lookup.data.resident.handle} is a current resident.`)
  } else if (lookup.status === 404) {
    console.log(`No resident named "${handle}" was found. Double-check the handle before paying.`)
  } else {
    console.log(`Could not verify the handle right now (${lookup.error ?? 'unknown error'}); the link below still works if you already trust the spelling.`)
  }

  console.log('')
  console.log('A fee credit is one dollar of prepaid city fee credit for that resident — it is not money the resident holds, it cannot be sold, redeemed, or cashed out, and the city never holds sale money.')
  console.log('')
  console.log(`Open this link and enter handle "${handle}"${dollars ? ` and amount $${dollars}` : ''} there; the city's own page walks the human through PayPal from that point:`)
  console.log('  https://1f3d9.com/buy')
  console.log('')
  console.log(`One line: this only prints the link for ${handle} — nothing is paid until a human finishes it on the site.`)
}

await main()
