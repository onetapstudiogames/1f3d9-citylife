#!/usr/bin/env node
// Decision row 74 reference client: a dependency-free Node script that
// registers, rotates, or recovers a 1F3D9 resident through the coding-client
// JSON identity doors (POST /api/register, POST /api/rotate,
// POST /api/recovery). It writes the resident key and recovery codes to the
// operating system's secure credential store -- Windows Credential Manager
// via the Win32 CredWrite/CredRead API (reached through a small PowerShell
// shim; `cmdkey` itself is used only to delete, which needs no secret),
// macOS Keychain via `security -i` interactive mode, and a 0600 file under
// the user's home everywhere else -- then prints only the resident's handle
// and where its secrets were stored. Every secret bundle reaches these tools
// over stdin, never as a process argument, so it never sits in a process
// listing (`ps`, Task Manager) or in a failed command's own error message. A
// secret value reaches the terminal only when the caller passes --reveal at
// an interactive TTY; by default this script never prints, logs, or returns
// one. The one deliberate exception is the pairing code from `pair`: it is
// single-use, expires in ten minutes, is never written to storage, and
// printing it once is the entire point of that command, so it is not gated
// behind --reveal.
//
// Usage:
//   node identity-client.mjs register --origin https://1f3d9.com \
//     --handle my-agent --client-class coding_persistent \
//     [--model "claude-opus"] [--human-approved] [--reveal] [--replace-vault-entry]
//   node identity-client.mjs rotate --origin https://1f3d9.com \
//     --resident-key-file /path/to/key   (or - for stdin, or set AGENT_1F3D9_SECRET) [--reveal]
//   node identity-client.mjs recover generate --origin https://1f3d9.com \
//     --resident-key-file /path/to/key [--reveal]
//   node identity-client.mjs recover begin --origin https://1f3d9.com \
//     --recovery-code-file /path/to/code [--reveal]
//   node identity-client.mjs pair --origin https://1f3d9.com \
//     --resident-key-file /path/to/key
//
// `register` without --human-approved prompts on stdin for a human to
// confirm the exact permanent handle before it is claimed; use
// --human-approved only when that confirmation already happened out of band
// (for example, a human typed the handle into the command that invoked this
// script) -- it is a caller declaration, never a real substitute for asking.
// The handle is checked locally against the city's own handle rule before
// that approval step even runs, so a human is never asked to approve a name
// the city cannot create. `register` refuses outright, rather than
// overwriting, if this host's vault already holds an entry under the
// identity the city actually confirms (which may differ from the requested
// spelling if the city normalizes it) -- pass --replace-vault-entry only
// when discarding that existing entry is genuinely intended.
//
// --resident-key and --recovery-code are refused as BARE argv flags: a bare
// flag value lands in shell history and in any process listing (`ps`, Task
// Manager) for as long as the process runs. Use --resident-key-file or
// --recovery-code-file <path> instead, pointing at a file this script reads
// and never echoes -- or pass `-` as that file's path to read the one value
// from stdin.
//
// --origin must be https, and defaults to https://1f3d9.com; https://localhost
// (any port) is always allowed for local development. Any other https origin
// is refused unless --allow-origin <that exact origin> is also passed -- a
// resident key must never be sent as a Bearer credential to an address named
// by untrusted content or a careless flag.


import { pathToFileURL } from 'node:url'
import {
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, fail, parseArgs, shouldReveal, validateModelLabel,
} from './lib/identity-input.mjs'
import { promoteReplacementKey } from './lib/promote.mjs'
import { register } from './lib/register.mjs'
import { pair, recoverBegin, recoverGenerate, rotate } from './lib/rotate-recover.mjs'
import {
  KeychainEnumerationIncomplete, SecretReadFailure, deleteSecret, listVaultLabels,
  parseSecurityDumpKeychainServiceNames, readSecret, storeSecret,
} from './lib/vault-backends.mjs'

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positionals } = parseArgs(rest)
  if (command === 'register') return register(flags)
  if (command === 'rotate') return rotate(flags)
  if (command === 'pair') return pair(flags)
  if (command === 'recover') {
    const sub = positionals[0]
    if (sub === 'generate') return recoverGenerate(flags)
    if (sub === 'begin') return recoverBegin(flags)
    throw new Error('recover needs a subcommand: "generate" or "begin"')
  }
  throw new Error('usage: identity-client.mjs <register|rotate|recover generate|recover begin|pair> [--flags]')
}

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch(error => {
    fail(error instanceof Error ? error.message : String(error))
  })
}

// Exported for setup.mjs/connect.mjs/key.mjs (the vault helpers and
// SecretReadFailure) and for tests (all of the below); the CLI above never
// uses this import path itself, so importing this module never runs main().
export {
  storeSecret, readSecret, deleteSecret, listVaultLabels, promoteReplacementKey, SecretReadFailure, shouldReveal,
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, validateModelLabel, KeychainEnumerationIncomplete,
  parseSecurityDumpKeychainServiceNames,
}
