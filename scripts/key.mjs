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

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { readSecret } from './identity-client.mjs'

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
const origin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

function resolveHandle() {
  if (typeof flags.handle === 'string') return flags.handle
  const state = readSetupState(origin)
  return state?.handle ?? null
}

function requireHandle() {
  const handle = resolveHandle()
  if (!handle) {
    console.error('key: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return null
  }
  return handle
}

function requireStoredKey(handle) {
  const stored = readSecret(origin, handle)
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
  const probe = await probeMe(origin, residentKey)
  console.log(`handle: ${handle}`)
  console.log(probe.ok ? 'stored key: works (one me read succeeded)' : `stored key: does not work (${probe.error})`)
}

function rotate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const args = [identityClientPath, 'rotate', '--origin', origin, '--resident-key-file', '-']
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { input: residentKey, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'key rotate: failed\n')
    process.exitCode = 1
  }
}

function recoverGenerate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const args = [identityClientPath, 'recover', 'generate', '--origin', origin, '--resident-key-file', '-']
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { input: residentKey, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'key recover generate: failed\n')
    process.exitCode = 1
  }
}

function recoverBegin() {
  const codeSource = flags['recovery-code-file']
  if (typeof codeSource !== 'string') {
    console.error('key recover begin: --recovery-code-file <path|-> is required (never a bare --recovery-code).')
    process.exitCode = 1
    return
  }
  const args = [identityClientPath, 'recover', 'begin', '--origin', origin, '--recovery-code-file', codeSource]
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exitCode = 1
}

function show() {
  const handle = requireHandle()
  if (!handle) return
  const stored = readSecret(origin, handle)
  if (!stored.found) {
    console.log(`no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  console.log(`handle: ${handle}`)
  if (flags.reveal === true && process.stdout.isTTY) {
    console.log('Resident key (shown once):')
    console.log(stored.value.resident_key)
    if (Array.isArray(stored.value.recovery_codes)) {
      console.log('Recovery codes:')
      for (const code of stored.value.recovery_codes) console.log(code)
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
