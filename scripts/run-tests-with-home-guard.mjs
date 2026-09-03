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
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSecurityDumpKeychainServiceNames } from './identity-client.mjs'

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
 * Classifies a raw platform-vault target name of the shape
 * `1f3d9:<origin>:<label>` by its origin:
 *   - 'loopback' for `https://localhost[:port]` or `https://127.0.0.1[:port]`
 *     -- the ONLY origins a stub city server this repo's own tests ever
 *     start can use (scripts/lib/origin-guard.mjs allows nothing else
 *     unconditionally, and AGENT_1F3D9_STUB_ONLY=1 forbids anything else
 *     outright), so an entry classified this way in the REAL platform vault
 *     can only be test/stub residue, never a real resident.
 *   - 'real' for `https://1f3d9.com` -- an operator's own, entirely
 *     legitimate resident identity from actually running `setup` against
 *     the live city. Never treated as drift or a leak.
 *   - 'other' for anything else (a caller-confirmed `--allow-origin` value
 *     this guard has no opinion about).
 * Returns null for a name that does not even carry this plugin's own
 * `1f3d9:` prefix.
 */
function classifyVaultTargetOrigin(name) {
  if (!name.startsWith(VAULT_TARGET_PREFIX)) return null
  const rest = name.slice(VAULT_TARGET_PREFIX.length)
  if (/^https:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?:/u.test(rest)) return 'loopback'
  if (/^https:\/\/1f3d9\.com:/u.test(rest)) return 'real'
  return 'other'
}

/**
 * Enumerates this plugin's own `1f3d9:`-prefixed platform-vault entries.
 * Returns `{ ok: true, names }` on a successful (possibly empty)
 * enumeration, and `{ ok: false, names: [] }` when the enumeration tool
 * itself failed on this platform -- distinct from "found nothing", the same
 * distinction identity-client.mjs's own listVaultLabels/
 * KeychainEnumerationIncomplete already has to make for the exact same
 * `security dump-keychain` and `cmdkey /list` calls. A bare
 * `catch { return [] }` here cannot tell "nothing to see" from "could not
 * look", and collapsing the two the way an earlier version of this function
 * did is wrong in either direction it could fail: a tool failure only on
 * the AFTER call would read as "nothing added" (hiding a real leak this
 * whole guard exists to catch), and a tool failure only on the BEFORE call
 * would report every entry the AFTER call legitimately found as spurious
 * drift (failing a clean run). The caller below refuses to compare when
 * either read failed, rather than guessing which of those two wrong answers
 * to give.
 *
 * Darwin's parsing is shared with identity-client.mjs's own
 * darwinKeychainServiceLabels via parseSecurityDumpKeychainServiceNames,
 * rather than a second, independently-maintained copy of the same regex --
 * a prior copy here did not run unescapeSecurityDumpString, so it decoded a
 * non-ASCII label byte differently (mojibake) than the shared parser does.
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
      return { ok: true, names: names.sort() }
    } catch {
      return { ok: false, names: [] }
    }
  }
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('security', ['dump-keychain'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
      })
      const names = parseSecurityDumpKeychainServiceNames(output).filter(name => name.startsWith(VAULT_TARGET_PREFIX))
      return { ok: true, names: names.sort() }
    } catch {
      return { ok: false, names: [] }
    }
  }
  // Any other platform has no platform-vault tool this guard knows how to
  // ask at all -- a genuine, successful "nothing to enumerate here", never
  // a failure.
  return { ok: true, names: [] }
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

/**
 * Runs the whole guarded suite once and returns the exit code it should
 * produce. Pulled out of top-level script code (rather than running
 * immediately at import time) so test/run-tests-with-home-guard.test.mjs
 * can import and unit-test the pure pieces above (classifyVaultTargetOrigin
 * especially) without this file spawning a nested `node --test` merely by
 * being imported -- see the isDirectRun guard at the bottom of this file.
 */
function runGuard(extraTestArgs = []) {
  const vaultDir = join(homedir(), VAULT_DIR_NAME)
  const before = snapshotDir(vaultDir)
  const platformVaultBefore = snapshotPlatformVaultNames()

  // Checked from the BEFORE snapshot alone, before the test suite even
  // runs: a stub city server (the only kind this repo's own tests ever
  // start) is loopback-only, so a loopback-origin `1f3d9:` entry already
  // sitting in the REAL platform vault before this run started can only be
  // residue some PAST run leaked in -- this run did not cause it, but it
  // must not go unreported just because the diff below only compares
  // before/after within the CURRENT run. Never trips on a real
  // `1f3d9:https://1f3d9.com:<handle>` entry -- an operator's own resident
  // identity is expected there and is never drift.
  const preexistingLoopbackLeak = platformVaultBefore.ok
    ? platformVaultBefore.names.filter(name => classifyVaultTargetOrigin(name) === 'loopback')
    : []

  const result = spawnSync(process.execPath, ['--test', ...extraTestArgs], {
    stdio: 'inherit',
  })

  const after = snapshotDir(vaultDir)
  const diff = diffSnapshots(before, after)
  const platformVaultAfter = snapshotPlatformVaultNames()
  const enumerationFailed = !platformVaultBefore.ok || !platformVaultAfter.ok
  const platformVaultDiff = platformVaultBefore.ok && platformVaultAfter.ok
    ? diffNameSets(platformVaultBefore.names, platformVaultAfter.names)
    : { added: [], removed: [] }
  const platformVaultDrifted = platformVaultDiff.added.length > 0 || platformVaultDiff.removed.length > 0

  let exitCode
  if (enumerationFailed) {
    const tool = process.platform === 'win32' ? 'cmdkey /list' : 'security dump-keychain'
    console.error(
      '\nidentity-vault-home-guard: the platform vault could not be enumerated, this run proves nothing ' +
      `about it (${tool} failed on the ${!platformVaultBefore.ok ? 'BEFORE' : 'AFTER'} read). A failed ` +
      'enumeration is never silently treated as "found nothing" -- doing that could either hide a real leak ' +
      'or report every pre-existing entry as spurious drift, depending on which call failed. Investigate why ' +
      'the enumeration tool failed on this host, then re-run.',
    )
    exitCode = 1
  } else if (preexistingLoopbackLeak.length > 0) {
    console.error(
      '\nidentity-vault-home-guard: the REAL platform vault already held a loopback-origin `1f3d9:` entry ' +
      "before this run even started -- a stub city server (the only kind this repo's own tests ever start) " +
      'is always loopback-only, so this means some PAST test run leaked a real secret into the operator\'s ' +
      'real vault. Never trips on a real `1f3d9:https://1f3d9.com:<handle>` entry -- an operator\'s own ' +
      `resident identity is expected there and is never drift. Leaked entries:\n` +
      preexistingLoopbackLeak.map(name => `  - ${name}`).join('\n'),
    )
    exitCode = 1
  } else if (isDrift(diff) || platformVaultDrifted) {
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
    exitCode = 1
  } else if (result.status !== 0) {
    exitCode = result.status ?? 1
  } else if (result.signal) {
    exitCode = 1
  } else {
    exitCode = 0
  }
  return exitCode
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  process.exitCode = runGuard(process.argv.slice(2))
}

// Exported for test/run-tests-with-home-guard.test.mjs; importing this
// module never runs the guard itself -- only isDirectRun above does that.
export {
  classifyVaultTargetOrigin, snapshotPlatformVaultNames, snapshotDir, diffNameSets, diffSnapshots, isDrift, runGuard,
}
