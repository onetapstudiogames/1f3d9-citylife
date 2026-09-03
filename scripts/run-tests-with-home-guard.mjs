// npm test's actual entry point. Runs `node --test` as a child process, but
// wraps it with a snapshot-before/snapshot-after check of the operator's
// REAL ~/.1f3d9 (existence, file list, byte sizes -- never file contents,
// so a real credential is never read or printed by this guard) -- and fails
// the run if that directory changed at all.
//
// This exists because test/identity-commands.test.mjs, test/identity-client.test.mjs,
// and test/vault-roundtrip-windows.test.mjs drive scripts/identity-client.mjs's
// storeSecret/readSecret/deleteSecret/promoteReplacementKey/listVaultLabels
// functions, all of which accept an injectable `homeDir` (see identity-client.mjs)
// so a test can point the vault at a throwaway temp directory instead of the
// real one -- but every one of those call sites has to actually pass it for
// that to matter. A single missed `{ homeDir }` (as happened in the wave
// this guard was added for -- roughly twenty call sites across two files)
// silently grows the operator's real vault-index.json on every `npm test`
// run, in a way no assertion inside any individual test would ever catch,
// because each test only ever inspects the temp homeDir it itself created,
// never the real one sitting untouched beside it.
//
// A single directory-tree diff around the WHOLE suite is deliberately the
// last line of defense, not a replacement for passing `homeDir` correctly
// at each call site: it cannot say WHICH test leaked, only THAT one did.
//
// The directory-tree diff alone is not the whole vault, though: on win32
// the actual secret bytes live in the machine-wide Windows Credential
// Manager, and on darwin they live in the login Keychain -- neither is
// scoped by HOME at all, so redirecting `homeDir` to a temp directory only
// ever isolates the non-secret vault-index.json, never the credential
// itself (identity-client.mjs's storeSecret picks its backend by
// `process.platform`, not by `homeDir`). A missed `{ homeDir }` on either
// platform would therefore write a REAL secret into the operator's REAL
// platform vault while leaving the ~/.1f3d9 diff above completely clean.
// So this guard ALSO snapshots -- names only, exactly as content-blind as
// the directory snapshot above -- the set of platform vault entries whose
// name carries this plugin's own `1f3d9:` prefix, and fails the run if
// that set changes across the whole suite.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

const VAULT_DIR_NAME = '.1f3d9'
const VAULT_TARGET_PREFIX = '1f3d9:'

/**
 * A deterministic, content-free snapshot of `dir`: every regular file's
 * path (relative to `dir`, forward-slash normalized so this compares the
 * same on win32 and POSIX) and byte size, sorted for a stable diff. Never
 * reads file contents -- vault-index.json is non-secret labels only, but
 * this guard has no business assuming that of every file that could ever
 * appear here, so it stays content-blind on principle.
 */
function snapshotDir(dir) {
  const entries = []
  const walk = (current) => {
    let names
    try {
      names = readdirSync(current, { withFileTypes: true })
    } catch {
      return // unreadable or vanished between calls -- treat as empty here
    }
    for (const entry of names) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      let size = null
      try {
        size = statSync(fullPath).size
      } catch {
        // Vanished between readdir and stat -- record as unreadable rather
        // than silently omitting it from the snapshot.
        size = 'unreadable'
      }
      entries.push({ path: relative(dir, fullPath).split('\\').join('/'), size })
    }
  }
  let existed = true
  try {
    statSync(dir)
  } catch {
    existed = false
  }
  if (existed) walk(dir)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { existed, entries }
}

/**
 * A deterministic, content-free (names only, never secret bytes) snapshot
 * of every platform vault entry whose name carries this plugin's own
 * `1f3d9:` target prefix -- the win32 Windows Credential Manager via
 * `cmdkey /list`, or the darwin login Keychain via a metadata-only
 * `security dump-keychain` scan, exactly as identity-client.mjs's own
 * listVaultLabels union already reads each of them (see that function's
 * doc comment). Any other platform, or either tool missing/failing, is
 * treated as "found nothing" -- the same fail-open posture the directory
 * snapshot above already has for a missing ~/.1f3d9, since there is
 * nothing more this guard can honestly claim to have seen.
 */
function snapshotPlatformVaultNames() {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
      const names = []
      for (const match of output.matchAll(/Target:\s*(.+)\s*$/gmu)) {
        const target = match[1].trim()
        const index = target.indexOf(VAULT_TARGET_PREFIX)
        if (index !== -1) names.push(target.slice(index))
      }
      return names.sort()
    } catch {
      return []
    }
  }
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('security', ['dump-keychain'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
      })
      const names = []
      const serviceRe = /"svce"<blob>=(?:"((?:[^"\\]|\\.)*)"|0x([0-9A-Fa-f]+)(?:\s+"(?:[^"\\]|\\.)*")?)/gsu
      for (const match of output.matchAll(serviceRe)) {
        const service = match[1] !== undefined ? match[1] : Buffer.from(match[2], 'hex').toString('utf8')
        if (service.startsWith(VAULT_TARGET_PREFIX)) names.push(service)
      }
      return names.sort()
    } catch {
      return []
    }
  }
  return []
}

function diffNameSets(before, after) {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter(name => !beforeSet.has(name)),
    removed: before.filter(name => !afterSet.has(name)),
  }
}

function diffSnapshots(before, after) {
  const beforeByPath = new Map(before.entries.map(entry => [entry.path, entry.size]))
  const afterByPath = new Map(after.entries.map(entry => [entry.path, entry.size]))
  const added = [...afterByPath.keys()].filter(path => !beforeByPath.has(path))
  const removed = [...beforeByPath.keys()].filter(path => !afterByPath.has(path))
  const changed = [...beforeByPath.keys()]
    .filter(path => afterByPath.has(path) && beforeByPath.get(path) !== afterByPath.get(path))
  return { added, removed, changed, existedChanged: before.existed !== after.existed }
}

function isDrift(diff) {
  return diff.existedChanged || diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
}

function formatDiff(diff, before, after) {
  const lines = [`real ~/.1f3d9 changed during this test run (existed before: ${before.existed}, after: ${after.existed})`]
  for (const path of diff.added) lines.push(`  + ${path} (new, ${after.entries.find(entry => entry.path === path)?.size} bytes)`)
  for (const path of diff.removed) lines.push(`  - ${path} (removed, was ${before.entries.find(entry => entry.path === path)?.size} bytes)`)
  for (const path of diff.changed) {
    const beforeSize = before.entries.find(entry => entry.path === path)?.size
    const afterSize = after.entries.find(entry => entry.path === path)?.size
    lines.push(`  * ${path} (${beforeSize} -> ${afterSize} bytes)`)
  }
  lines.push(
    'This means some test called storeSecret/readSecret/deleteSecret/promoteReplacementKey/listVaultLabels ' +
    'without passing { homeDir } for a throwaway temp directory, so it hit the real vault instead of a ' +
    'sandboxed one. Find the call site (search test/*.test.mjs for a vault function call missing homeDir) ' +
    'and fix it there -- this guard only proves that a leak happened, not which test caused it.',
  )
  return lines.join('\n')
}

const vaultDir = join(homedir(), VAULT_DIR_NAME)
const before = snapshotDir(vaultDir)
const platformVaultBefore = snapshotPlatformVaultNames()

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
})

const after = snapshotDir(vaultDir)
const diff = diffSnapshots(before, after)
const platformVaultAfter = snapshotPlatformVaultNames()
const platformVaultDiff = diffNameSets(platformVaultBefore, platformVaultAfter)
const platformVaultDrifted = platformVaultDiff.added.length > 0 || platformVaultDiff.removed.length > 0

if (isDrift(diff) || platformVaultDrifted) {
  if (isDrift(diff)) console.error(`\nidentity-vault-home-guard: ${formatDiff(diff, before, after)}`)
  if (platformVaultDrifted) {
    const lines = [
      'identity-vault-home-guard: the real platform credential vault ' +
      `(${process.platform === 'win32' ? 'Windows Credential Manager' : 'macOS Keychain'}) gained or lost a ` +
      '1f3d9: entry during this test run -- names only, never values:',
    ]
    for (const name of platformVaultDiff.added) lines.push(`  + ${name}`)
    for (const name of platformVaultDiff.removed) lines.push(`  - ${name}`)
    lines.push(
      'This is a real secret, not the non-secret vault-index.json the directory snapshot above already ' +
      'covers -- a temp HOME does not isolate this platform vault. Find the call site (search test/*.test.mjs ' +
      'for a vault function call missing homeDir) and fix it there.',
    )
    console.error(`\n${lines.join('\n')}`)
  }
  process.exitCode = 1
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1
} else if (result.signal) {
  process.exitCode = 1
} else {
  process.exitCode = 0
}
