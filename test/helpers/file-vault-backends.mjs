// Test-only facade: use a temporary-HOME-backed command stub on Windows and
// the normal temporary-HOME file backend elsewhere. Explicit backend deps
// are preserved for tests that deliberately exercise one implementation.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

import * as real from '../../scripts/lib/vault-backends.mjs'
import { credentialsFilePath } from '../../scripts/lib/vault-index.mjs'

const testPlatformVaultDir = homeDir => join(homeDir, '.1f3d9', 'test-platform-vault')
const testPlatformVaultEntryPath = (homeDir, target) =>
  join(testPlatformVaultDir(homeDir), Buffer.from(target, 'utf8').toString('base64url'))

function windowsExecFileSync(homeDir) {
  const dir = testPlatformVaultDir(homeDir)
  const entryPath = target => testPlatformVaultEntryPath(homeDir, target)

  return (command, args, options = {}) => {
    if (command === 'powershell.exe' && options.input !== undefined) {
      const { target, blob } = JSON.parse(options.input)
      mkdirSync(dir, { recursive: true })
      writeFileSync(entryPath(target), blob, 'utf8')
      return ''
    }
    if (command === 'powershell.exe') {
      const target = /CredRead\('([^']+)'/u.exec(args.at(-1))?.[1]
      if (!target) throw new Error('credential not found')
      return readFileSync(entryPath(target), 'utf8')
    }
    if (command === 'cmdkey' && args[0]?.startsWith('/delete:')) {
      rmSync(entryPath(args[0].slice('/delete:'.length)), { force: true })
      return ''
    }
    if (command === 'cmdkey' && args[0] === '/list') {
      let names
      try {
        names = readdirSync(dir)
      } catch {
        names = []
      }
      return names
        .map(name => Buffer.from(name, 'base64url').toString('utf8'))
        .map(target => `Target: ${target}`)
        .join('\n')
    }
    throw new Error(`unexpected credential command: ${command}`)
  }
}

/** Seeds an entry the active test backend can find but cannot decode. */
export function seedCorruptTestVaultEntry(origin, label, homeDir) {
  if (platform() === 'win32') {
    const target = `1f3d9:${origin}:${label}`
    mkdirSync(testPlatformVaultDir(homeDir), { recursive: true })
    writeFileSync(testPlatformVaultEntryPath(homeDir, target), 'not-valid-base64-json{{{', 'utf8')
    return
  }

  const filePath = credentialsFilePath(origin, label, homeDir)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'not valid json{{{', 'utf8')
}

/** Lists raw targets held by the file-backed Windows command shim. */
export function listTestPlatformVaultTargets(homeDir) {
  let names
  try {
    names = readdirSync(testPlatformVaultDir(homeDir))
  } catch {
    return []
  }
  return names.map(name => Buffer.from(name, 'base64url').toString('utf8'))
}

function withTestBackend(deps = {}) {
  if (typeof deps.execFileSync === 'function') return deps
  if (deps.platform === 'win32' || (deps.platform === undefined && platform() === 'win32')) {
    return {
      ...deps,
      platform: 'win32',
      execFileSync: windowsExecFileSync(deps.homeDir ?? homedir()),
    }
  }
  return { ...deps, platform: 'linux' }
}

export const storeSecret = (origin, label, payload, deps) =>
  real.storeSecret(origin, label, payload, withTestBackend(deps))
export const readSecret = (origin, label, deps) =>
  real.readSecret(origin, label, withTestBackend(deps))
export const deleteSecret = (origin, label, deps) =>
  real.deleteSecret(origin, label, withTestBackend(deps))
export const listVaultLabels = (origin, deps) =>
  real.listVaultLabels(origin, withTestBackend(deps))

export const {
  KeychainEnumerationIncomplete,
  SecretReadFailure,
  parseSecurityDumpKeychainServiceNames,
} = real
