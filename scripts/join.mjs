#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'
import { readSecret, listVaultLabels, HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE } from './identity-client.mjs'
import { recoveryFilePath } from './lib/recovery-file.mjs'
import { probeMe } from './lib/identity-probe.mjs'

const CONNECTOR_NAME = handle => `1f3d9-${handle}`
const bridge = resolve(pluginRoot, 'scripts', 'mcp-bridge.mjs')

function flagsFrom(argv) {
  const allowed = new Set(['handle', 'codes-dir', 'human-approved', 'origin', 'allow-origin', 'model', 'host', 'repair'])
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`unexpected argument ${raw}`)
    if (raw === '--repair') {
      if (flags.repair) throw new Error('repeated option --repair')
      flags.repair = true
      continue
    }
    const equal = raw.indexOf('=')
    const name = raw.slice(2, equal < 0 ? undefined : equal)
    if (name === 'repair') throw new Error('use bare --repair without a value')
    if (!allowed.has(name) || Object.hasOwn(flags, name)) throw new Error(`unknown or repeated option --${name}`)
    const value = equal < 0 ? argv[++i] : raw.slice(equal + 1)
    if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

function assertUnusedCodesFile(file) {
  try {
    lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`refusing to overwrite existing recovery codes at ${file}`)
}

function connectorCli(host) {
  const testStub = process.env.AGENT_1F3D9_STUB_ONLY === '1' ? process.env.AGENT_1F3D9_JOIN_CLI_STUB : null
  let executable = host === 'claude' ? 'claude' : process.platform === 'win32' ? 'codex.exe' : 'codex'
  let prefix = []
  if (host === 'codex' && process.platform === 'win32' && !testStub &&
      spawnSync(executable, ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    const shims = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true })
      .stdout?.split(/\r?\n/u).filter(Boolean) ?? []
    const npmBin = shims.map(shim => resolve(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
      .find(path => existsSync(path))
    if (npmBin) {
      executable = process.execPath
      prefix = [npmBin]
    }
  }
  const run = args => testStub
    ? spawnSync(process.execPath, [testStub, host, ...args], { encoding: 'utf8', windowsHide: true })
    : spawnSync(executable, [...prefix, ...args], { encoding: 'utf8', windowsHide: true })
  if (run(['--version']).status !== 0) throw new Error(`${host} CLI is unavailable; install it before joining`)
  return run
}

function connectorExists(run, host, name) {
  const result = run(host === 'claude' ? ['mcp', 'get', name] : ['mcp', 'get', name, '--json'])
  if (result.status === 0) return true
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  const missing = host === 'claude'
    ? detail.includes(`No MCP server named "${name}".`)
    : detail.includes(`No MCP server named '${name}' found.`)
  if (!missing) throw new Error(`${host} CLI could not inspect connector ${name}`)
  return false
}

function addConnector(run, host, name, handle, exists) {
  if (exists) {
    const remove = host === 'claude' ? ['mcp', 'remove', '--scope', 'user', name] : ['mcp', 'remove', name]
    if (run(remove).status !== 0) throw new Error(`${host} CLI could not repair connector ${name}`)
  }
  const add = host === 'claude'
    ? ['mcp', 'add', '--scope', 'user', name, '--', process.execPath, bridge, '--handle', handle]
    : ['mcp', 'add', name, '--', process.execPath, bridge, '--handle', handle]
  if (run(add).status !== 0) throw new Error(`${host} CLI could not add connector ${name}`)
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2))
  const host = flags.host
  if (!['claude', 'codex'].includes(host)) throw new Error('the agent must set --host claude or --host codex for its own host')
  const handle = flags.handle
  if (!handle || !HANDLE_RE.test(handle) || RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
    throw new Error('the agent must choose a valid --handle (3–32 lowercase letters, digits, or hyphens)')
  }
  if (!flags['codes-dir']) throw new Error('ask the human for --codes-dir; never invent a recovery-code folder')
  const origin = assertAllowedOrigin(flags.origin ?? 'https://1f3d9.com', { allowOrigin: flags['allow-origin'] })
  const stubLoopback = process.env.AGENT_1F3D9_STUB_ONLY === '1' &&
    /^https:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin)
  if (origin !== 'https://1f3d9.com' && !stubLoopback) {
    throw new Error('join configures the production city bridge only; use the official city origin')
  }
  const codesFile = recoveryFilePath(flags['codes-dir'], handle)
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch {
    throw new Error(`the vault entry for "${handle}" could not be read; run key status --handle ${handle} before joining`)
  }
  if (stored.found) {
    if (!flags.repair) throw new Error(`"${handle}" already has a vault entry; run key status --handle ${handle} instead of registering again`)
    if (!existsSync(codesFile)) throw new Error(`saved recovery codes were not found at ${codesFile}; choose the original folder before repair`)
    if (typeof stored.value?.resident_key !== 'string') throw new Error(`vault key for ${handle} is missing; run key status`)
    const proof = await probeMe(origin, stored.value.resident_key, { allowOrigin: flags['allow-origin'] })
    if (!proof.ok || proof.handle !== handle) throw new Error(`vault key for ${handle} did not authenticate as that handle; run key status --handle ${handle}`)
    const name = CONNECTOR_NAME(handle)
    const runCli = connectorCli(host)
    addConnector(runCli, host, name, handle, connectorExists(runCli, host, name))
    console.log(`handle: ${handle}`)
    console.log(`connector: ${name}`)
    console.log(`codes: ${codesFile}`)
    return 0
  }
  if (flags.repair) throw new Error(`no vault entry exists for ${handle}; ordinary join must start with human approval`)
  assertUnusedCodesFile(codesFile)
  const labels = listVaultLabels(origin)
  if ((labels.registrationStagingLabels ?? []).length > 0) {
    throw new Error('an unfinished registration is in the vault; run key status and key adopt before joining again')
  }
  const name = CONNECTOR_NAME(handle)
  const runCli = connectorCli(host)
  const existingConnector = connectorExists(runCli, host, name)

  const setupArgs = [resolve(pluginRoot, 'scripts', 'setup.mjs'), '--origin', origin,
    '--handle', handle, '--client-class', 'coding_persistent', '--codes-dir', flags['codes-dir'], '--new-identity', '--defer-probe']
  if (flags['allow-origin']) setupArgs.push('--allow-origin', flags['allow-origin'])
  if (flags.model) setupArgs.push('--model', flags.model)
  if (flags['human-approved']) setupArgs.push('--human-approved', flags['human-approved'])
  const result = spawnSync(process.execPath, setupArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    const token = /--human-approved ([0-9a-f]{32})/u.exec(result.stderr ?? '')?.[1]
    if (token) {
      console.error(`Approve permanent public handle "${handle}" for this agent?`)
      console.error(`After the human says yes, rerun the same join command with --human-approved ${token} appended.`)
      return 1
    }
    console.error((result.stderr || 'join: setup failed; run key status before retrying').trim())
    return 1
  }
  const confirmedHandle = /^handle: ([a-z0-9-]+)$/mu.exec(result.stdout ?? '')?.[1]
  const savedCodes = /^codes_file: (.+)$/mu.exec(result.stdout ?? '')?.[1]
  if (!confirmedHandle || !savedCodes) {
    throw new Error('setup may have created the identity, but join could not confirm it; run key status before retrying')
  }
  const confirmedName = CONNECTOR_NAME(confirmedHandle)
  try {
    addConnector(runCli, host, confirmedName, confirmedHandle,
      confirmedName === name ? existingConnector : connectorExists(runCli, host, confirmedName))
  } catch (error) {
    throw new Error(`${error.message}. Resident ${confirmedHandle} was created; codes are at ${savedCodes}. Rerun the same join command with --repair to repair the connector.`)
  }
  const key = readSecret(origin, confirmedHandle)
  if (!key.found || typeof key.value?.resident_key !== 'string') {
    throw new Error(`resident ${confirmedHandle} was created and connector ${confirmedName} was added, but its vault key could not be read; codes are at ${savedCodes}. Run key status.`)
  }
  const proof = await probeMe(origin, key.value.resident_key, { allowOrigin: flags['allow-origin'] })
  if (!proof.ok || proof.handle !== confirmedHandle) {
    throw new Error(`resident ${confirmedHandle} was created and connector ${confirmedName} was added, but the signed read failed; codes are at ${savedCodes}. Run key status.`)
  }
  console.log(`handle: ${confirmedHandle}`)
  console.log(`connector: ${confirmedName}`)
  console.log(`codes: ${savedCodes}`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`join: ${error.message}`)
  process.exitCode = 1
}
