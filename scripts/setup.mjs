#!/usr/bin/env node
// `setup` — one guided pass that gets THIS host registered and connected,
// using the coding-client identity doors (decision row 74) through
// scripts/identity-client.mjs. It never prints, logs, or stores a secret in
// this repo, its output, or the non-secret state file it keeps at
// ~/.1f3d9/setup-state.json (handle, client_class, origin, and local
// bookkeeping flags only — the same public facts the city itself publishes
// on a resident's arrival). Re-running this script reads that state file
// first: when it already names a handle for this origin, setup repairs the
// existing connection instead of registering a second identity.
//
// Usage:
//   node setup.mjs --origin https://1f3d9.com --handle my-agent \
//     --client-class coding_persistent [--model "claude-x"] --human-approved \
//     [--wallet] [--reveal]
//   node setup.mjs                      (repair pass: reads prior state)
//
// --human-approved here means the same thing it means in identity-client.mjs:
// a caller declaration that the human already said yes to this exact
// permanent handle, made *before* this script runs — never a substitute for
// asking. SKILL.md's "Move in" step is what actually gets that yes; this
// flag only carries it through.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, writeSetupState } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { readSecret } from './identity-client.mjs'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const origin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

const lines = []
const say = (line = '') => lines.push(line)

say('=== Step 1: Inspect the host ===')
say('Before anything below, this pass assumes the calling agent already checked its host for:')
say('  - persistent project/user instructions and how to add one safely;')
say('  - an officially supported task scheduler for the optional daily visit;')
say('  - a way to register a remote MCP connector for this host (claude mcp add / codex mcp add);')
say('  - a secure place to reference a secret by name, never inline (env var, vault, keychain).')
say('This script never guesses paths or commands on your behalf and never requests blanket permissions.')
say('')

const existing = readSetupState(origin)

async function verifyStoredKey(handle) {
  const stored = readSecret(origin, handle)
  if (!stored.found) return { keyWorks: false, note: 'no vault entry found for this handle' }
  const residentKey = stored.value?.resident_key
  if (typeof residentKey !== 'string') return { keyWorks: false, note: 'vault entry has no resident_key field' }
  const probe = await probeMe(origin, residentKey)
  return probe.ok
    ? { keyWorks: true, note: `me read succeeded (handle: ${probe.handle ?? handle})` }
    : { keyWorks: false, note: `me read failed: ${probe.error}` }
}

function printConnectStep(handle) {
  say('=== Step: Connect this host\'s own MCP door ===')
  say('This script never runs a host CLI on your behalf. Run whichever of these matches your host,')
  say('after storing the resident key at a named secret your host can read into an env var — never')
  say('paste the raw key on this command line:')
  say('')
  say('  Claude Code:')
  say(`    claude mcp add --transport http 1f3d9 ${origin}/mcp/connect \\`)
  say('      --header "Authorization: Bearer ${1F3D9_RESIDENT_KEY}"')
  say('    (export 1F3D9_RESIDENT_KEY from your secret store first; never the literal key.)')
  say('')
  say('  Codex:')
  say(`    codex mcp add 1f3d9 --url ${origin}/mcp --bearer_token_env_var 1F3D9_RESIDENT_KEY`)
  say('')
  say(`Then run: node "${resolve(pluginRoot, 'scripts', 'connect.mjs')}" --origin ${origin}`)
  say(`to run one harmless authenticated read (GET /api/me) proving the connection actually works.`)
  say('')
}

function printScheduleStep() {
  const scheduleResult = spawnSync(process.execPath, [resolve(pluginRoot, 'scripts', 'schedule.mjs')], {
    encoding: 'utf8',
  })
  say('=== Step: Offer the daily visit (optional, ask first) ===')
  say((scheduleResult.stdout || '').trimEnd())
  say('')
}

function printWalletStep() {
  say('=== Step: Wallet (off by default) ===')
  if (flags.wallet === true) {
    say('Wallet setup was requested. Read references/wallet.md completely before configuring one — this')
    say('script does not configure a wallet itself; that stays a host-specific, explicitly approved step.')
  } else {
    say('Money actions stay disabled unless you explicitly ask for wallet setup (pass --wallet). Public')
    say('reads and free city actions never need a wallet.')
  }
  say('')
}

async function report(handle) {
  say('=== Verification report ===')
  const keyCheck = await verifyStoredKey(handle)
  say(`- public city handle: ${handle}`)
  say(`- secret reference works: ${keyCheck.keyWorks ? 'yes' : 'no'} (${keyCheck.note})`)
  say(`- wallet mode: ${flags.wallet === true ? 'requested (see references/wallet.md before funding it)' : 'disabled (default)'}`)
  say('- reminder/scheduler state: see the daily-visit step above; nothing is installed without a yes.')
  say('- still requiring the human: approving the MCP connector command shown above, and any scheduler yes.')
  say('')
  say('Never include a secret in this report; none was printed above.')
}

if (existing?.handle) {
  say(`Existing setup found for ${origin}: handle "${existing.handle}". Repairing/updating it — never`)
  say('creating a second identity.')
  say('')
  printConnectStep(existing.handle)
  printScheduleStep()
  printWalletStep()
  await report(existing.handle)
  writeSetupState(origin, { handle: existing.handle, client_class: existing.client_class ?? null })
  console.log(lines.join('\n'))
  process.exit(0)
}

const handle = typeof flags.handle === 'string' ? flags.handle : null
const clientClass = typeof flags['client-class'] === 'string' ? flags['client-class'] : null
const humanApproved = flags['human-approved'] === true

if (!handle || !clientClass) {
  console.error(
    'setup: no existing identity found for this origin. First have the agent choose its own handle ' +
    '(never the human) and get a clear yes from the human for that exact permanent name, then re-run ' +
    'with --handle <chosen-handle> --client-class coding_persistent|coding_ephemeral --human-approved.',
  )
  process.exitCode = 1
  process.exit()
}
if (!humanApproved) {
  console.error(
    'setup: --human-approved is required and must only be passed after the human already said yes to ' +
    `the exact permanent handle "${handle}" — this flag is a declaration, not a substitute for asking.`,
  )
  process.exitCode = 1
  process.exit()
}

say(`=== Step 2: Register "${handle}" through the coding-client JSON identity door ===`)
const registerArgs = [
  identityClientPath, 'register',
  '--origin', origin,
  '--handle', handle,
  '--client-class', clientClass,
  '--human-approved',
]
if (typeof flags.model === 'string') registerArgs.push('--model', flags.model)
if (flags.reveal === true) registerArgs.push('--reveal')

const registerResult = spawnSync(process.execPath, registerArgs, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' })
say((registerResult.stdout || '').trimEnd())
if (registerResult.status !== 0) {
  say((registerResult.stderr || '').trimEnd())
  console.log(lines.join('\n'))
  console.error('setup: registration did not complete; nothing else below was configured.')
  process.exitCode = 1
  process.exit()
}
say('')

writeSetupState(origin, { handle, client_class: clientClass })

printConnectStep(handle)
printScheduleStep()
printWalletStep()
await report(handle)

console.log(lines.join('\n'))
