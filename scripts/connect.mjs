#!/usr/bin/env node
// `connect` — two modes.
//
//   node connect.mjs [--origin https://1f3d9.com] [--handle my-agent] [--allow-origin <origin>]
//     For the coding agent itself: prints the exact `claude mcp add` /
//     `codex mcp add` commands under the distinct server name `1f3d9-key`
//     (reading the key from a named secret into an env var — never the
//     literal key on the command line; this plugin's own bundled `.mcp.json`
//     already uses the name `1f3d9` for hosted-chat browser sign-in, at a
//     different URL and auth mode, so the printed connector must never share
//     that name), then runs one authenticated read (GET /api/me) against the
//     vault-stored key to prove the connection actually works -- this is not
//     a free/side-effect-free read: it wakes any due timers and advances
//     this resident's fee-credit last-read marker, the same as any other
//     `me` read. Prints only handle and pass/fail — never the key.
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

const UNSAFE_LINE_CHARACTER_RE = /[\x00-\x1f\x7f\u2028\u2029]/u
const USDC_AMOUNT_RE = /^(?:0|[1-9]\d*)\.\d{6}$/u
const AMOUNT_UNITS_RE = /^(?:0|[1-9]\d*)$/u

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

function readAmount(entry) {
  if (
    !isRecord(entry)
    || !isSafeServerText(entry.amount)
    || entry.amount.length >= 200
    || !USDC_AMOUNT_RE.test(entry.amount)
    || !isSafeServerText(entry.amount_units)
    || entry.amount_units.length >= 200
    || !AMOUNT_UNITS_RE.test(entry.amount_units)
    || !isSafeServerText(entry.record_link)
  ) return null

  const amountUnits = BigInt(entry.amount.replace('.', '')).toString()
  if (amountUnits !== entry.amount_units) return null
  return { amount: entry.amount, recordLink: entry.record_link, nonZero: entry.amount_units !== '0' }
}

/**
 * Turns the city's optional GET /api/me receipt into one safe, short line.
 * Any malformed field rejects the complete line so valid siblings can never
 * make a hostile or corrupt response look partly trustworthy.
 */
function sinceLastVisitLine(value) {
  if (!isRecord(value) || !isRecord(value.city_updates) || !isRecord(value.fee_credit_received)) return null

  const { city_updates: cityUpdates, fee_credit_received: feeCredit, last_visit_at: lastVisitAt } = value
  let cityUpdatesUrl
  try {
    cityUpdatesUrl = new URL(cityUpdates.href, `${origin}/`)
  } catch {
    return null
  }
  if (
    !isCount(cityUpdates.count)
    || !isSafeServerText(cityUpdates.href)
    || !cityUpdates.href.startsWith('/')
    || cityUpdates.href.startsWith('//')
    || cityUpdates.href.includes('\\')
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
  if (!accepted || !settled || !isRecord(pending) || !isCount(pending.count) || !isSafeServerText(pending.record_link)) {
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
const rawOrigin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING is printed -- including the ready-
// to-paste `claude mcp add` / `codex mcp add` commands below, which read a
// resident key into a Bearer header. A disallowed --origin must never reach
// those commands on screen; assertAllowedOrigin refuses first.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`connect: ${error.message}`)
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
  if (typeof flags.handle === 'string') return flags.handle
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

  console.log('Add or repair this host\'s own MCP connector — run whichever matches your host, after')
  console.log('storing the resident key at a named secret this host can read into an environment variable:')
  console.log('')
  console.log('  Claude Code:')
  // One line, deliberately: a POSIX `\` line continuation is a hard parse
  // error in PowerShell, one of the shells this command is most often
  // pasted into, while this single-line form works unchanged in bash, zsh,
  // and PowerShell alike. Named `1f3d9-key` (not `1f3d9`): the plugin's own
  // bundled `.mcp.json` already registers a server named `1f3d9` for
  // hosted-chat browser sign-in at a different URL and auth mode -- a
  // second, different server under that same name would silently shadow or
  // collide with it.
  console.log(`    claude mcp add --transport http 1f3d9-key ${origin}/mcp --header 'Authorization: Bearer \${AGENT_1F3D9_SECRET}'`)
  console.log('    (the placeholder above must reach the CLI single-quoted and unexpanded — copy it')
  console.log('    exactly. Export AGENT_1F3D9_SECRET from your secret store first; never paste the')
  console.log('    literal key on this command line.)')
  console.log('')
  console.log('  Codex:')
  console.log(`    codex mcp add 1f3d9-key --url ${origin}/mcp --bearer-token-env-var AGENT_1F3D9_SECRET`)
  console.log('')
  console.log('  (This plugin also bundles a connector already named `1f3d9`, for hosted-chat browser')
  console.log('  sign-in — that one is separate from the key-based connector above and needs no key.)')
  console.log('')
  console.log('This script cannot run either command for you — it has no way to know which host CLI is')
  console.log('actually installed here. Run the one that matches, then re-run this command to verify.')
  console.log('')

  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `connect: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found || typeof stored.value?.resident_key !== 'string') {
    console.log(`one me read: skipped — no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  const probe = await probeMe(origin, stored.value.resident_key, { allowOrigin })
  if (!probe.ok) {
    console.log(`one me read: FAILED (${probe.error})`)
    return
  }
  if (probe.handle && probe.handle !== handle) {
    console.log(
      `one me read: MISMATCH — the vault entry labelled "${handle}" actually authenticates as ` +
      `"${probe.handle}". Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
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
      `connect chat: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a ` +
      'saved recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
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
    console.error((result.stderr || 'connect chat: pairing failed').trim())
    process.exitCode = 1
    return
  }
  console.log(output)
  console.log('')
  console.log('These clicks remain for the human — this script cannot do them:')
  console.log(`  1. In the chat app (claude.ai, ChatGPT, etc.), open connector settings and add ${origin}/mcp/connect`)
  console.log('  2. Press "sign in" on that connector.')
  console.log('  3. On the sign-in page, choose "Have a pairing code instead" and enter the code above.')
  console.log('  4. Confirm the resident name the page shows before the final click.')
  console.log('Paste it within ten minutes; if the page rejects it, do not retry that code, run connect chat again for a fresh one.')
}

if (positionals[0] === 'chat') {
  connectChat()
} else {
  await connectHost()
}
