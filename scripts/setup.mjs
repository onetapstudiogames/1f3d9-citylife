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
//     --client-class coding_persistent [--model "claude-x"] [--human-approved <token>] \
//     [--wallet] [--reveal] [--new-identity] [--allow-origin <origin>]
//   node setup.mjs                      (repair pass: reads prior state)
//
// Human approval is a real two-pass gate that a single non-interactive call
// cannot satisfy on its own. When stdin IS an interactive terminal, this
// script asks the exact question itself and proceeds only on a real "yes" —
// no second run needed. Off a terminal, the FIRST run (no --human-approved,
// or a bare --human-approved with no token) can never approve itself: it
// writes a random nonce into ~/.1f3d9/setup-state.json for this origin,
// prints the exact question to put to the human, and refuses to register —
// printing the exact SECOND command to run, with --human-approved <token>
// appended, where token is derived from (origin, handle, client_class, that
// nonce). Only a SECOND run passing that exact token back proceeds; an
// unattended loop cannot produce that token in one call, because computing
// it requires the nonce this script only ever writes to disk on a prior,
// separate run. The token is proof a first pass happened here — it is
// still the agent's own recorded declaration that a human said yes out of
// band (decision row 74), never proof of who actually said it, and this
// script never treats it as more than that.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, writeSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { readSecret, SecretReadFailure, listVaultLabels } from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'

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
const rawOrigin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING else -- including the "Step 1"
// output below -- so a disallowed origin can never reach a printed MCP
// connector command, a registration attempt, or any other output at all.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`setup: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

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

// Throws SecretReadFailure (never silently returns keyWorks:false for it) --
// a corrupt vault entry is not proof nothing is there, so every caller below
// must handle that case explicitly rather than let it fall through into an
// attempted registration.
async function verifyStoredKey(handle) {
  const stored = readSecret(origin, handle)
  if (!stored.found) return { keyWorks: false, note: 'no vault entry found for this handle' }
  const residentKey = stored.value?.resident_key
  if (typeof residentKey !== 'string') return { keyWorks: false, note: 'vault entry has no resident_key field' }
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  if (!probe.ok) return { keyWorks: false, note: `me read failed: ${probe.error}` }
  // The vault entry is LABELLED `handle`, but the key it holds might not
  // actually authenticate as that resident (a stale label, a hand-copied
  // entry, or a handle the city normalized at registration) -- never adopt
  // or report success on that mismatch.
  if (probe.handle && probe.handle !== handle) {
    return {
      keyWorks: false,
      mismatchedHandle: probe.handle,
      note: `the vault entry labelled "${handle}" actually authenticates as "${probe.handle}" -- pass ` +
        `--handle ${probe.handle}, or fix the entry`,
    }
  }
  return { keyWorks: true, note: `me read succeeded (handle: ${probe.handle ?? handle})` }
}

/** Wraps a call to verifyStoredKey, turning SecretReadFailure into a clean, caller-worded refusal and exit. */
async function verifyStoredKeyOrRefuse(handle, label) {
  try {
    return await verifyStoredKey(handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `${label}: ${error.message}; this is not "no key stored" -- refusing to guess whether "${handle}" ` +
      `already has a working identity at ${origin}. Fix or remove the corrupt vault entry first (or, if ` +
      'you have a saved recovery code for this handle, run `key recover begin` to replace it), then ' +
      're-run setup. Never create a second identity to work around an unreadable one.',
    )
    process.exitCode = 1
    process.exit()
  }
}

function printConnectStep(handle) {
  say('=== Step: Connect this host\'s own MCP door ===')
  say('This script never runs a host CLI on your behalf. Run whichever of these matches your host,')
  say('after storing the resident key at a named secret this host can read into an environment variable')
  say('— never paste the raw key on this command line:')
  say('')
  say('  Claude Code:')
  // One line, deliberately: a POSIX `\` line continuation is a hard parse
  // error in PowerShell, one of the shells this command is most often
  // pasted into, while this single-line form works unchanged in bash, zsh,
  // and PowerShell alike.
  say(`    claude mcp add --transport http 1f3d9 ${origin}/mcp --header 'Authorization: Bearer \${AGENT_1F3D9_SECRET}'`)
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
  const keyCheck = precomputedKeyCheck ?? await verifyStoredKeyOrRefuse(handle, 'setup')
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
    '(never the human), then re-run with --handle <chosen-handle> --client-class ' +
    'coding_persistent|coding_ephemeral. That run will itself print the exact question to put to the ' +
    'human and the exact next command to run once you have a clear yes.',
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
const priorVaultEntry = await verifyStoredKeyOrRefuse(handle, 'setup')
if (priorVaultEntry.mismatchedHandle) {
  console.error(
    `setup: refusing to adopt or register "${handle}" at ${origin}: the vault entry stored under that ` +
    `label actually authenticates as "${priorVaultEntry.mismatchedHandle}". Pass --handle ` +
    `${priorVaultEntry.mismatchedHandle} to use the identity that entry really belongs to, or fix the ` +
    'vault entry before retrying. Never overwrite it or register a fresh identity to work around this.',
  )
  process.exitCode = 1
  process.exit()
}
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

// The check above only ever looked at the EXACT handle requested. That
// leaves the same stranding scenario open under a different handle: the
// vault is user-scoped and setup-state.json lives under HOME, so "state
// file gone, vault intact" is the normal shape after a HOME reset, a
// profile move, or a container with a mounted keychain -- and a fresh
// session that then chooses a different handle would otherwise register a
// second, permanent, unrecoverable resident right next to the first one.
// Enumerate every OTHER label this vault already holds for this origin
// (never the handle just checked above, and never a rotation/recovery
// staging label, which is not a real registered identity) and refuse
// outright unless --new-identity was passed.
if (!newIdentity) {
  const otherLabels = listVaultLabels(origin).filter(label => label !== handle)
  if (otherLabels.length > 0) {
    console.error(
      `setup: refusing to register "${handle}" as a new identity at ${origin}: this host's vault already ` +
      `holds ${otherLabels.length === 1 ? 'an entry' : 'entries'} for this origin under a different ` +
      `label (${otherLabels.join(', ')}). A lost or never-written setup-state.json must never turn an ` +
      'existing resident into a second, permanent, unrecoverable one. If one of those is really this ' +
      'agent\'s own entry under a stale or normalized label, pass --handle <that label> instead. Only ' +
      'pass --new-identity if a genuinely new resident, distinct from all of those, is really intended.',
    )
    process.exitCode = 1
    process.exit()
  }
}

function computeApprovalToken(nonce) {
  return createHash('sha256')
    .update(`${origin} ${handle} ${clientClass} ${nonce}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * A real two-pass human-approval gate that a single non-interactive call
 * cannot satisfy on its own -- see the header comment for the full shape.
 * Returns { approved: true } once a real yes has been obtained (either
 * interactively just now, or by a valid token from a prior refused pass);
 * otherwise { approved: false, token } where `token` is the value the next
 * run must pass back with --human-approved.
 */
async function confirmHumanApproval() {
  if (process.stdin.isTTY) {
    const question =
      `Confirm the exact permanent public handle "${handle}" (client class: ${clientClass}) was chosen ` +
      'with a human\'s clear yes. Register it now?'
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
      return { approved: /^y(es)?$/iu.test(answer.trim()) }
    } finally {
      rl.close()
    }
  }

  const provided = typeof flags['human-approved'] === 'string' ? flags['human-approved'] : null
  const pending = existing?.pending_approval
  if (
    provided
    && pending
    && pending.handle === handle
    && pending.client_class === clientClass
    && provided === computeApprovalToken(pending.nonce)
  ) {
    // Single-use: consume the nonce so this exact token can never approve a
    // later, separate registration attempt.
    writeSetupState(origin, { pending_approval: null })
    return { approved: true }
  }

  // No valid token was presented -- mint a fresh nonce, persist it, and
  // hand back the token derived from it so the caller can print the exact
  // next command. This never approves on this call, even if a (wrong or
  // stale) --human-approved value was given.
  const nonce = randomBytes(16).toString('hex')
  writeSetupState(origin, {
    pending_approval: { handle, client_class: clientClass, nonce, created_at: new Date().toISOString() },
  })
  return { approved: false, token: computeApprovalToken(nonce) }
}

const approval = await confirmHumanApproval()
if (!approval.approved) {
  console.error(
    'setup: before registering, put this exact question to the human: "Confirm the permanent public ' +
    `handle "${handle}" (client class: ${clientClass}) — register it now?" Registration creates a ` +
    'permanent public identity that cannot be silently replaced. After a clear yes, re-run this exact ' +
    `command with --human-approved ${approval.token} appended. That token proves THIS first pass ran and ` +
    'wrote the nonce it is derived from to setup-state.json -- an unattended loop cannot produce it in ' +
    'one call, because it can only be computed after that nonce already exists on disk. The token is ' +
    'still only the agent\'s own recorded declaration that the yes already happened, exactly as before -- ' +
    'the city records it as such (decision row 74); it is never proof of who actually said yes, and this ' +
    'script never treats it as more than proof that a first pass happened. (stdin was not an interactive ' +
    'terminal here, so this script could not ask directly; on one, it would have asked instead of ' +
    'requiring a second run.)',
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
