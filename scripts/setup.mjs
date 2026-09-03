#!/usr/bin/env node
// `setup` — one guided pass that gets THIS host registered and connected,
// using the coding-client identity doors (decision row 74) through
// scripts/identity-client.mjs. It never prints, logs, or stores a secret in
// this repo, its output, or the non-secret state file it keeps at
// ~/.1f3d9/setup-state.json (handle, client_class, origin, and local
// bookkeeping flags only — the same public facts the city itself publishes
// on a resident's arrival). Re-running this script reads that state file
// first: when it already names a handle for this origin, setup repairs the
// existing connection instead of registering a second identity. Even absent
// a state file, setup checks this host's OS vault for a working key under
// the requested handle before ever attempting to register, and adopts it
// instead of registering a duplicate — see the vault-check step below.
//
// Usage:
//   node setup.mjs --origin https://1f3d9.com --handle my-agent \
//     --client-class coding_persistent [--model "claude-x"] [--human-approved] \
//     [--wallet] [--reveal] [--new-identity] [--allow-origin <origin>]
//   node setup.mjs                      (repair pass: reads prior state)
//
// Human approval is a real two-pass gate, not a self-assertion the agent can
// satisfy alone in one call: the FIRST run (with no --human-approved, and
// stdin not an interactive terminal) prints the exact question to put to the
// human and refuses to register. When stdin IS an interactive terminal, this
// script asks that question itself instead of requiring a second run. Only
// after a real "yes" — interactively, or already obtained out of band before
// a SECOND run passing --human-approved — does registration proceed.
// --human-approved is then the agent's own recorded declaration that the
// yes already happened; the city records it as such (decision row 74). It
// is never proof by itself, and this script never treats it as one.

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, writeSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
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
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined
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

let existing
try {
  existing = readSetupState(origin)
} catch (error) {
  if (!(error instanceof SetupStateReadFailure)) throw error
  console.error(
    `setup: ${error.message}; refusing to guess whether an identity already exists for ${origin}. ` +
    'A corrupt state file is not proof nothing was ever registered here — a real identity could still be ' +
    'sitting in this host\'s OS credential vault. Fix or remove that file only after checking the vault ' +
    'directly (for example `key status --handle <handle>` for the handle you suspect), then re-run setup.',
  )
  process.exitCode = 1
  process.exit()
}

async function verifyStoredKey(handle) {
  const stored = readSecret(origin, handle)
  if (!stored.found) return { keyWorks: false, note: 'no vault entry found for this handle' }
  const residentKey = stored.value?.resident_key
  if (typeof residentKey !== 'string') return { keyWorks: false, note: 'vault entry has no resident_key field' }
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  return probe.ok
    ? { keyWorks: true, note: `me read succeeded (handle: ${probe.handle ?? handle})` }
    : { keyWorks: false, note: `me read failed: ${probe.error}` }
}

function printConnectStep(handle) {
  say('=== Step: Connect this host\'s own MCP door ===')
  say('This script never runs a host CLI on your behalf. Run whichever of these matches your host,')
  say('after storing the resident key at a named secret this host can read into an environment variable')
  say('— never paste the raw key on this command line:')
  say('')
  say('  Claude Code:')
  say(`    claude mcp add --transport http 1f3d9 ${origin}/mcp \\`)
  say("      --header 'Authorization: Bearer ${AGENT_1F3D9_SECRET}'")
  say('    (that placeholder must reach the CLI single-quoted and unexpanded — copy it exactly; export')
  say('    AGENT_1F3D9_SECRET from your secret store first, never the literal key.)')
  say('')
  say('  Codex:')
  say(`    codex mcp add 1f3d9 --url ${origin}/mcp --bearer-token-env-var AGENT_1F3D9_SECRET`)
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

// `precomputedKeyCheck` lets a caller that already ran verifyStoredKey (the
// vault-adopt check below) reuse that result instead of probing /api/me a
// second time in the same run -- one fewer real network round trip, and it
// sidesteps a rare Node/libuv shutdown crash on some Windows builds
// (`UV_HANDLE_CLOSING` assertion in src/win/async.c) observed when two
// AbortSignal.timeout()-gated fetches run in the same process with a
// spawnSync (printScheduleStep, just above this call) interleaved between
// them.
async function report(handle, precomputedKeyCheck) {
  say('=== Verification report ===')
  const keyCheck = precomputedKeyCheck ?? await verifyStoredKey(handle)
  say(`- public city handle: ${handle}`)
  say(`- secret reference works: ${keyCheck.keyWorks ? 'yes' : 'no'} (${keyCheck.note})`)
  say(`- wallet mode: ${flags.wallet === true ? 'requested (see references/wallet.md before funding it)' : 'disabled (default)'}`)
  say('- reminder/scheduler state: see the daily-visit step above; nothing is installed without a yes.')
  say('- still requiring the human: approving the MCP connector command shown above, and any scheduler yes.')
  say('')
  say('Never include a secret in this report; none was printed above.')
}

function finishAsRepair(handle, clientClass, precomputedKeyCheck) {
  writeSetupState(origin, { handle, client_class: clientClass ?? null })
  printConnectStep(handle)
  printScheduleStep()
  printWalletStep()
  return report(handle, precomputedKeyCheck)
}

if (existing?.handle) {
  say(`Existing setup found for ${origin}: handle "${existing.handle}". Repairing/updating it — never`)
  say('creating a second identity.')
  say('')
  await finishAsRepair(existing.handle, existing.client_class)
  console.log(lines.join('\n'))
  process.exit(0)
}

const handle = typeof flags.handle === 'string' ? flags.handle : null
const clientClass = typeof flags['client-class'] === 'string' ? flags['client-class'] : null
const newIdentity = flags['new-identity'] === true

if (!handle || !clientClass) {
  console.error(
    'setup: no existing identity found for this origin. First have the agent choose its own handle ' +
    '(never the human) and get a clear yes from the human for that exact permanent name, then re-run ' +
    'with --handle <chosen-handle> --client-class coding_persistent|coding_ephemeral --human-approved.',
  )
  process.exitCode = 1
  process.exit()
}

// Before ever attempting to register, check whether this host's vault
// already has a WORKING key for the exact handle requested. A lost or
// truncated setup-state.json must never turn a resident that already exists
// into an attempt at a second one: a dropped confirm response can leave the
// resident created and the key correctly vaulted, but the state file never
// written, and a naive retry would either dead-end on "handle taken" or,
// worse, succeed under a different handle and create a real, permanent,
// unrecoverable duplicate.
const priorVaultEntry = await verifyStoredKey(handle)
if (priorVaultEntry.keyWorks && !newIdentity) {
  say(`=== A working identity for "${handle}" at ${origin} already exists ===`)
  say(`(${priorVaultEntry.note}). Adopting it instead of registering a second one — this never deletes or`)
  say('overwrites the existing vault entry. Pass --new-identity if a genuinely new resident was intended.')
  say('')
  await finishAsRepair(handle, clientClass, priorVaultEntry)
  console.log(lines.join('\n'))
  process.exit(0)
}
if (priorVaultEntry.keyWorks && newIdentity) {
  say(`--new-identity was passed, so proceeding to register "${handle}" even though a working vault entry`)
  say('already exists for it. The city will very likely refuse this as a duplicate handle; choose a')
  say('different handle if that happens.')
  say('')
}

/**
 * A real two-pass human-approval gate. Never trusts --human-approved alone
 * as if it were proof: when stdin is an interactive terminal, this script
 * asks the exact question itself and only proceeds on a real "yes" — the
 * flag is then unnecessary. When stdin is not interactive, --human-approved
 * is accepted only as the agent's own declaration that a human already said
 * yes to this exact handle and client class out of band; without it, this
 * refuses and prints the exact question the agent must put to the human,
 * rather than silently registering on the agent's word alone.
 */
async function confirmHumanApproval() {
  if (flags['human-approved'] === true) return true
  if (!process.stdin.isTTY) return false
  const question =
    `Confirm the exact permanent public handle "${handle}" (client class: ${clientClass}) was chosen ` +
    'with a human\'s clear yes. Register it now?'
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
    return /^y(es)?$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

const humanApproved = await confirmHumanApproval()
if (!humanApproved) {
  console.error(
    'setup: before registering, put this exact question to the human: "Confirm the permanent public ' +
    `handle "${handle}" (client class: ${clientClass}) — register it now?" Registration creates a ` +
    'permanent public identity that cannot be silently replaced. After a clear yes, re-run this exact ' +
    'command with --human-approved appended. That flag is the agent\'s own recorded declaration that the ' +
    'yes already happened — the city records it as such (decision row 74); it is never proof by itself. ' +
    '(stdin was not an interactive terminal here, so this script could not ask directly; on one, it would ' +
    'have asked instead of requiring a second run.)',
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
if (allowOrigin) registerArgs.push('--allow-origin', allowOrigin)

let registerResult
if (flags.reveal === true) {
  // --reveal can only work when the CHILD process's own stdout is a real
  // interactive terminal (revealOrHide in identity-client.mjs checks
  // process.stdout.isTTY there, not here) — a piped stdio, which this
  // script otherwise always uses to capture and narrate the child's output,
  // can never be a TTY. Rather than silently accepting and dropping the
  // flag, refuse up front unless this script's own stdout is a TTY, in
  // which case hand the child the real terminal directly.
  if (!process.stdout.isTTY) {
    console.log(lines.join('\n'))
    console.error(
      'setup: --reveal cannot work through this wrapper because stdout is not an interactive terminal; run ' +
      '"node scripts/identity-client.mjs register ..." directly at an interactive terminal instead, or omit ' +
      '--reveal and read the key back afterward with `key show --reveal` at one.',
    )
    process.exitCode = 1
    process.exit()
  }
  console.log(lines.join('\n'))
  lines.length = 0
  registerResult = spawnSync(process.execPath, [...registerArgs, '--reveal'], { stdio: 'inherit' })
} else {
  registerResult = spawnSync(process.execPath, registerArgs, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' })
  say((registerResult.stdout || '').trimEnd())
}
if (registerResult.status !== 0) {
  if (registerResult.stderr) say((registerResult.stderr || '').trimEnd())
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
