#!/usr/bin/env node
// `key` — status, rotate, recover, and show, all built on the vault helpers
// and the coding-client identity doors in scripts/identity-client.mjs.
// Never prints, logs, or returns a secret except `key show --reveal` at an
// interactive TTY.
//
// Usage:
//   node key.mjs status [--origin https://1f3d9.com] [--handle my-agent]
//   node key.mjs rotate [--origin ...] [--handle ...] [--reveal]
//   node key.mjs recover generate [--origin ...] [--handle ...] [--reveal]
//   node key.mjs recover begin --recovery-code-file <path|-> [--origin ...] [--reveal]
//   node key.mjs show [--origin ...] [--handle ...] [--reveal]
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

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
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

// The origin guard runs before ANYTHING else -- before status/rotate/
// recover/show ever touch the vault or the network for a disallowed origin.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`key: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

function resolveHandle() {
  if (typeof flags.handle === 'string') return flags.handle
  const state = readSetupState(origin)
  return state?.handle ?? null
}

function requireHandle() {
  let handle
  try {
    handle = resolveHandle()
  } catch (error) {
    if (!(error instanceof SetupStateReadFailure)) throw error
    console.error(`key: ${error.message}; pass --handle <handle> explicitly, or fix that file first.`)
    process.exitCode = 1
    return null
  }
  if (!handle) {
    console.error('key: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return null
  }
  return handle
}

function requireStoredKey(handle) {
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return null
  }
  if (!stored.found || typeof stored.value?.resident_key !== 'string') {
    console.error(`key: no vault entry found for "${handle}" at ${origin}.`)
    process.exitCode = 1
    return null
  }
  return stored.value.resident_key
}

async function status() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  console.log(`handle: ${handle}`)
  if (!probe.ok) {
    console.log(`stored key: does not work (${probe.error})`)
    return
  }
  if (probe.handle && probe.handle !== handle) {
    console.log(
      `stored key: works, but authenticates as "${probe.handle}", not "${handle}" -- the vault entry ` +
      `labelled "${handle}" belongs to a different resident. Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    return
  }
  console.log('stored key: works (one me read succeeded)')
}

/**
 * Runs `node identity-client.mjs <args...>` with `residentKey` piped in on
 * stdin. When --reveal was requested, this can only take effect if the
 * CHILD's own stdout is a real interactive terminal (revealOrHide there
 * checks process.stdout.isTTY on the child, not this wrapper) — a captured
 * pipe, which this function otherwise always uses so it can print or
 * re-throw the child's output itself, can never be a TTY. So --reveal here
 * either hands the child the real terminal directly (this wrapper's own
 * stdout must be a TTY too) or is refused up front, never silently dropped.
 */
function runIdentityClient(label, args, residentKey) {
  if (flags.reveal === true) {
    if (!process.stdout.isTTY) {
      console.error(`${label}: --reveal cannot work through this wrapper; run scripts/identity-client.mjs ` +
        'directly at an interactive terminal.')
      process.exitCode = 1
      return
    }
    const result = spawnSync(process.execPath, [...args, '--reveal'], {
      input: residentKey,
      stdio: [residentKey === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    })
    if (result.status !== 0) process.exitCode = 1
    return
  }
  const result = spawnSync(process.execPath, args, { input: residentKey, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${label}: failed\n`)
    process.exitCode = 1
  }
}

function rotate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const args = [identityClientPath, 'rotate', '--origin', origin, '--resident-key-file', '-']
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key rotate', args, residentKey)
}

function recoverGenerate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const args = [identityClientPath, 'recover', 'generate', '--origin', origin, '--resident-key-file', '-']
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key recover generate', args, residentKey)
}

function recoverBegin() {
  const codeSource = flags['recovery-code-file']
  if (typeof codeSource !== 'string') {
    console.error('key recover begin: --recovery-code-file <path|-> is required (never a bare --recovery-code).')
    process.exitCode = 1
    return
  }
  const args = [identityClientPath, 'recover', 'begin', '--origin', origin, '--recovery-code-file', codeSource]
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exitCode = 1
}

function show() {
  const handle = requireHandle()
  if (!handle) return
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found) {
    console.log(`no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  if (typeof stored.value?.resident_key !== 'string') {
    console.log(
      `a vault entry exists for "${handle}" at ${origin}, but it carries no resident_key field -- there ` +
      'is nothing to show.',
    )
    return
  }
  console.log(`handle: ${handle}`)
  if (flags.reveal === true && process.stdout.isTTY) {
    console.log('Resident key (shown once):')
    console.log(stored.value.resident_key)
    if (Array.isArray(stored.value.recovery_codes)) {
      console.log('Recovery codes:')
      for (const code of stored.value.recovery_codes) console.log(code)
    } else if (stored.value.recovery_codes_invalidated_at) {
      console.log(
        `Recovery codes: invalidated by the last rotation/recovery (${stored.value.recovery_codes_invalidated_at}); ` +
        'run `key recover generate` to mint a fresh set.',
      )
    } else {
      console.log('Recovery codes: none stored.')
    }
    return
  }
  console.log('key: not printed to the terminal (pass --reveal at an interactive TTY to see it once).')
}

const command = positionals[0]
if (command === 'status') await status()
else if (command === 'rotate') rotate()
else if (command === 'recover') {
  const sub = positionals[1]
  if (sub === 'generate') recoverGenerate()
  else if (sub === 'begin') recoverBegin()
  else {
    console.error('key recover: needs a subcommand, "generate" or "begin"')
    process.exitCode = 1
  }
} else if (command === 'show') show()
else {
  console.error('usage: key.mjs <status|rotate|recover generate|recover begin|show> [--flags]')
  process.exitCode = 1
}
