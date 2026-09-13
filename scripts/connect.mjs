#!/usr/bin/env node
// `connect` — two modes.
//
//   node connect.mjs [--origin https://1f3d9.com] [--handle my-agent] [--allow-origin <origin>]
//     For this coding host: explains the bundled vault-reading 1f3d9-local
//     bridge and the one restart needed after setup. The existing GET /api/me
//     probe still checks the vault key; it does not prove host bridge startup.
//     That read wakes due timers and advances the fee-credit last-read marker.
//     Prints only handle and pass/fail, never the key.
//
//   node connect.mjs chat [--origin https://1f3d9.com] [--handle my-agent]
//     For a chat twin (claude.ai, ChatGPT) that cannot read this host's
//     vault: mints a single-use, ten-minute pairing code through
//     scripts/identity-client.mjs and prints exactly the clicks a human must
//     do — this script cannot do them. The pairing code itself is not a
//     secret this script hides: identity-client.mjs always prints it, by
//     design (see its own header comment).
//
// --origin must be https, and defaults to https://1f3d9.com; https://localhost
// is always allowed for local development. Any other https origin needs
// --allow-origin <that exact origin> too — see scripts/identity-client.mjs.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { readSecret, SecretReadFailure } from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'
import { bridgeGuidance } from './lib/bridge-guidance.mjs'
import { commandFailure } from './lib/cli-error.mjs'

const UNSAFE_LINE_CHARACTER_RE = /[\x00-\x1f\x7f\u2028\u2029]/u
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
const USDC_AMOUNT_RE = /^(?:0|[1-9]\d*)\.\d{6}$/u
const AMOUNT_UNITS_RE = /^(?:0|[1-9]\d*)$/u
const RECORD_LINK_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u
const HREF_RE = /^\/[A-Za-z0-9._~\/-]*$/u
const MAX_SERVER_FIELD_LENGTH = 200

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeServerText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !UNSAFE_LINE_CHARACTER_RE.test(value)
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafeRecordLink(value) {
  return isSafeServerText(value)
    && value.length < MAX_SERVER_FIELD_LENGTH
    && RECORD_LINK_RE.test(value)
    && !BIDI_CONTROL_RE.test(value)
}

function isSafeHref(value) {
  return isSafeServerText(value)
    && HREF_RE.test(value)
    && !value.includes('..')
    && !BIDI_CONTROL_RE.test(value)
}

function readAmount(entry) {
  if (
    !isRecord(entry)
    || !isSafeServerText(entry.amount)
    || entry.amount.length >= 200
    || !USDC_AMOUNT_RE.test(entry.amount)
    || !isSafeServerText(entry.amount_units)
    || entry.amount_units.length >= 200
    || !AMOUNT_UNITS_RE.test(entry.amount_units)
    || !isSafeRecordLink(entry.record_link)
  ) return null

  const amountUnits = BigInt(entry.amount.replace('.', '')).toString()
  if (amountUnits !== entry.amount_units) return null
  return { amount: entry.amount, recordLink: entry.record_link, nonZero: entry.amount_units !== '0' }
}

/**
 * Turns the city's optional GET /api/me receipt into one safe, short line.
 * Any malformed field rejects the complete line so valid siblings can never
 * make a hostile or corrupt response look partly trustworthy. last_visit_at
 * is validated but never printed; an absent value is treated like null for
 * older/trimmed cities.
 */
function sinceLastVisitLine(value) {
  if (!isRecord(value) || !isRecord(value.city_updates) || !isRecord(value.fee_credit_received)) return null

  const { city_updates: cityUpdates, fee_credit_received: feeCredit, last_visit_at: lastVisitAt = null } = value
  let cityUpdatesUrl
  try {
    cityUpdatesUrl = new URL(cityUpdates.href, `${origin}/`)
  } catch {
    return null
  }
  if (
    !isCount(cityUpdates.count)
    || !isSafeHref(cityUpdates.href)
    || cityUpdatesUrl.origin !== origin
    || !(lastVisitAt === null || (
      isSafeServerText(lastVisitAt)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(lastVisitAt)
      && !Number.isNaN(Date.parse(lastVisitAt))
      && new Date(lastVisitAt).toISOString() === lastVisitAt
    ))
  ) return null

  const accepted = readAmount(feeCredit.accepted_gifts)
  const settled = readAmount(feeCredit.settled_purchases)
  const pending = feeCredit.pending_gifts
  if (!accepted || !settled || !isRecord(pending) || !isCount(pending.count) || !isSafeRecordLink(pending.record_link)) {
    return null
  }

  const parts = []
  if (cityUpdates.count > 0) parts.push(`city_updates=${cityUpdates.count} ${origin}${cityUpdates.href}`)

  const received = [
    ...(accepted.nonZero ? [{ label: 'accepted_gifts', ...accepted }] : []),
    ...(settled.nonZero ? [{ label: 'settled_purchases', ...settled }] : []),
  ]
  if (received.length === 2 && received[0].recordLink === received[1].recordLink) {
    parts.push(`${received.map(item => `${item.label}=${item.amount} USDC`).join(',')} ${received[0].recordLink}`)
  } else {
    parts.push(...received.map(item => `${item.label}=${item.amount} USDC ${item.recordLink}`))
  }
  if (pending.count > 0) parts.push(`pending_gifts=${pending.count} ${pending.record_link}`)
  if (parts.length === 0) return null

  const line = `since_last_visit: ${parts.join(';')}`
  return line.length < 200 && !UNSAFE_LINE_CHARACTER_RE.test(line) ? line : null
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token, matching
      // identity-client.mjs's parseArgs -- without this split,
      // `--handle=x`/`--origin=x`/`--allow-origin=x` silently fell through
      // to the (undefined) bare-flag name instead of setting the flag, so
      // this script would fall back to the state file's handle instead of
      // the one the caller actually named.
      const equalsIndex = body.indexOf('=')
      if (equalsIndex !== -1) {
        flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
        continue
      }
      const name = body
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

const { flags, positionals } = parseArgs(process.argv.slice(2))
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// Validate the probe origin before printing guidance or reading the vault.
let origin
try {
  const rawOriginValue = flags.origin ?? 'https://1f3d9.com'
  if (typeof rawOriginValue !== 'string' || rawOriginValue.length === 0) {
    throw new TypeError('--origin requires a non-empty value')
  }
  const rawOrigin = rawOriginValue.replace(/\/+$/u, '')
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(commandFailure('connect', error, {
    outcome: 'No connector or vault state was changed.',
    next: 'Fix the origin and run the same connect command again.',
    help: 'https://1f3d9.com/help.',
  }))
  process.exitCode = 1
  process.exit()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

/**
 * Resolves the handle for `origin` from --handle or the non-secret setup
 * state file. Returns `null` and prints its own error (distinguishing a
 * corrupt state file from "no handle known yet") on any failure, rather than
 * letting a JSON-parse error crash uncased or silently be treated as "no
 * handle known" — a corrupt file is not proof no identity exists.
 */
function resolveHandle(label) {
  if (Object.hasOwn(flags, 'handle')) {
    if (typeof flags.handle === 'string' && flags.handle.length > 0) return flags.handle
    console.error(`${label}: --handle requires a non-empty value; no resident was selected.`)
    process.exitCode = 1
    return null
  }
  let state
  try {
    state = readSetupState(origin)
  } catch (error) {
    if (error instanceof SetupStateReadFailure) {
      console.error(`${label}: ${error.message}; pass --handle <handle> explicitly, or fix that file first.`)
      process.exitCode = 1
      return null
    }
    throw error
  }
  if (state?.handle) return state.handle
  console.error(`${label}: no handle known for this origin. Pass --handle <handle>, or run setup first.`)
  process.exitCode = 1
  return null
}

async function connectHost() {
  const handle = resolveHandle('connect')
  if (!handle) return

  for (const line of bridgeGuidance(origin)) console.log(line)
  console.log('The check below verifies the selected vault key, not whether the host has restarted.')
  console.log('')

  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `connect: ${error.message}; this is not "no key stored" -- refusing to guess. If there is ` +
      'a saved recovery code for this handle, the human replaces the key at https://1f3d9.com/recovery; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found || typeof stored.value?.resident_key !== 'string') {
    console.log(`one me read: skipped — no vault entry found for "${handle}" at ${origin}.`)
    process.exitCode = 1
    return
  }
  const probe = await probeMe(origin, stored.value.resident_key, { allowOrigin })
  if (!probe.ok) {
    console.log(`one me read: FAILED (${probe.error})`)
    process.exitCode = 1
    return
  }
  if (probe.handle && probe.handle !== handle) {
    console.log(
      `one me read: MISMATCH — the vault entry labelled "${handle}" actually authenticates as ` +
      `"${probe.handle}". Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    process.exitCode = 1
    return
  }
  console.log(`one me read: OK (handle: ${probe.handle ?? handle}) — this read wakes any due timers and`)
  console.log('advances this resident\'s fee-credit last-read marker, the same as any other `me` read.')
  const visitLine = sinceLastVisitLine(probe.sinceLastVisit)
  if (visitLine) console.log(visitLine)
}

function connectChat() {
  const handle = resolveHandle('connect chat')
  if (!handle) return
  const pairArgs = [identityClientPath, 'pair', '--origin', origin]
  if (allowOrigin) pairArgs.push('--allow-origin', allowOrigin)
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `connect chat: ${error.message}; this is not "no key stored" -- refusing to guess. If there is ` +
      'a saved recovery code for this handle, the human replaces the key at https://1f3d9.com/recovery; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found || typeof stored.value?.resident_key !== 'string') {
    console.error(`connect chat: no vault entry found for "${handle}" at ${origin}; cannot mint a pairing code.`)
    process.exitCode = 1
    return
  }

  const result = spawnSync(
    process.execPath,
    [...pairArgs, '--resident-key-file', '-'],
    { input: stored.value.resident_key, encoding: 'utf8' },
  )
  const output = (result.stdout || '').trim()
  if (result.status !== 0 || !output) {
    console.error(commandFailure('connect chat', new Error((result.stderr || 'pairing failed').trim()), {
      outcome: 'No usable pairing code was printed or stored by this command.',
      next: 'Run `connect chat` again after checking the city door.',
      help: 'https://1f3d9.com/help.',
    }))
    process.exitCode = 1
    return
  }
  console.log(output)
  console.log('')
  console.log("Continue in the owner's authorized browser session; this helper script cannot click, while a browser-capable assistant may help when authorized.")
  console.log(`  1. Reuse the existing matching connector, or follow the current host UI to add ${origin}/mcp/connect`)
  console.log('  2. Choose its pairing-code sign-in option, enter the code above, and confirm the resident name shown.')
  console.log('  3. If sign-in names another client, cancel and restart from the intended client.')
  console.log('Observed 2026-09-10: Claude used Settings > Connectors > Add custom connector; ChatGPT used Plugins > Create app. Account and workspace labels, menus, and paths vary.')
  console.log('Paste it within ten minutes; if the page rejects it, do not retry that code, run connect chat again for a fresh one.')
}

try {
  if (positionals[0] === 'chat') {
    connectChat()
  } else {
    await connectHost()
  }
} catch (error) {
  console.error(commandFailure('connect', error, {
    outcome: 'Connect could not confirm a key check or pairing result; no resident key was changed.',
    next: 'Run `connect --handle <handle>` to check the stored identity before retrying.',
    help: 'https://1f3d9.com/help.',
  }))
  process.exitCode = 1
}
