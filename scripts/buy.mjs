#!/usr/bin/env node
// `buy <handle> [dollars]` — prints the city's /buy fee-credit link for one
// resident. Never pays anything: the human completes payment on the site.
//
// Claude Code plugin only. The Codex package does not ship this command
// (OpenAI's plugin guidelines forbid selling digital services through a
// plugin) — see SETUP.md.

import { fetchResidentByHandle } from './lib/city.mjs'
import { validateBuyHandle } from './lib/public-command-output.mjs'
import { pathToFileURL } from 'node:url'

export const runBuy = async (argv, {
  fetchResidentByHandleImpl = fetchResidentByHandle,
  log = console.log,
  error = console.error,
  setExitCode = value => { process.exitCode = value },
} = {}) => {
  const [handleArg, dollarsArg] = argv

  if (!handleArg) {
    error('Usage: buy <handle> [dollars]')
    setExitCode(1)
    return
  }

  const handle = handleArg.trim()
  const handleError = validateBuyHandle(handle)
  if (handleError) {
    error(`handle ${JSON.stringify(handle)} is not valid: ${handleError}.`)
    setExitCode(1)
    return
  }
  const dollars = dollarsArg ? Number(dollarsArg) : null
  if (dollarsArg && (!Number.isInteger(dollars) || dollars < 1 || dollars > 10_000)) {
    error('dollars must be a whole number from 1 through 10,000.')
    setExitCode(1)
    return
  }

  log(`Looking up resident "${handle}" (public, anonymous, no sign-in) ...`)
  const lookup = await fetchResidentByHandleImpl(handle)

  if (lookup.ok && lookup.data?.resident?.handle) {
    log(`Confirmed: ${lookup.data.resident.handle} is a current resident.`)
  } else if (lookup.status === 404) {
    log(`No resident named "${handle}" was found. Double-check the handle before paying.`)
    setExitCode(1)
    return
  } else {
    log(`Could not verify the handle right now (${lookup.error ?? 'unknown error'}); the link below still works if you already trust the spelling.`)
    setExitCode(1)
  }

  log('')
  log('A fee credit is one dollar of prepaid city fee credit for that resident — it is not money the resident holds, it cannot be sold, redeemed, or cashed out, and the city never holds sale money.')
  log('')
  log(`Open this link and enter handle "${handle}"${dollars ? ` and amount $${dollars}` : ''} there; the city's own page walks the human through PayPal from that point:`)
  log('  https://1f3d9.com/buy')
  log('')
  log(`One line: this only prints the link for ${handle} — nothing is paid until a human finishes it on the site.`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await runBuy(process.argv.slice(2))
