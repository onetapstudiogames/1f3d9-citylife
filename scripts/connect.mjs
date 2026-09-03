#!/usr/bin/env node
// `connect` — two modes.
//
//   node connect.mjs [--origin https://1f3d9.com] [--handle my-agent]
//     For the coding agent itself: prints the exact `claude mcp add` /
//     `codex mcp add` commands (reading the key from a named secret into an
//     env var — never the literal key on the command line), then runs one
//     harmless authenticated read (GET /api/me) against the vault-stored key
//     to prove the connection actually works. Prints only handle and
//     pass/fail — never the key.
//
//   node connect.mjs chat [--origin https://1f3d9.com] [--handle my-agent]
//     For a chat twin (claude.ai, ChatGPT) that cannot read this host's
//     vault: mints a single-use, ten-minute pairing code through
//     scripts/identity-client.mjs and prints exactly the clicks a human must
//     do — this script cannot do them. The pairing code itself is not a
//     secret this script hides: identity-client.mjs always prints it, by
//     design (see its own header comment).

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

async function connectHost() {
  const handle = resolveHandle()
  if (!handle) {
    console.error('connect: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return
  }

  console.log('Add or repair this host\'s own MCP connector — run whichever matches your host, after')
  console.log('storing the resident key at a named secret your host can read into an env var:')
  console.log('')
  console.log('  Claude Code:')
  console.log(`    claude mcp add --transport http 1f3d9 ${origin}/mcp/connect \\`)
  console.log('      --header "Authorization: Bearer ${1F3D9_RESIDENT_KEY}"')
  console.log('')
  console.log('  Codex:')
  console.log(`    codex mcp add 1f3d9 --url ${origin}/mcp --bearer_token_env_var 1F3D9_RESIDENT_KEY`)
  console.log('')
  console.log('This script cannot run either command for you — it has no way to know which host CLI is')
  console.log('actually installed here. Run the one that matches, then re-run this command to verify.')
  console.log('')

  const stored = readSecret(origin, handle)
  if (!stored.found || typeof stored.value?.resident_key !== 'string') {
    console.log(`one me read: skipped — no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  const probe = await probeMe(origin, stored.value.resident_key)
  console.log(
    probe.ok
      ? `one me read: OK (handle: ${probe.handle ?? handle})`
      : `one me read: FAILED (${probe.error})`,
  )
}

function connectChat() {
  const handle = resolveHandle()
  const pairArgs = [identityClientPath, 'pair', '--origin', origin]
  if (!handle) {
    console.error('connect chat: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return
  }
  const stored = readSecret(origin, handle)
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
}

if (positionals[0] === 'chat') {
  connectChat()
} else {
  await connectHost()
}
