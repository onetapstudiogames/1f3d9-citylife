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

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertAllowedOrigin, DEFAULT_ORIGIN } from './lib/origin-guard.mjs'

const ROOT_KEY_RE = /^1f3d9_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE_RE = /^1f3d9_rc_[0-9a-f]{64}$/u

// The city's own handle rule (matches the browser join door's validation,
// which the front door states the JSON doors "mirror" in limit, name rule,
// and refusal). Checked locally, before ever putting a handle in front of a
// human for approval, so a human is never asked to approve a name the city
// cannot create -- and so the label this script stores the vault entry
// under is never assumed to equal the requested spelling (the city may
// still normalize it further; see register() below, which always trusts
// the server's own answer as the identity of record, not this local check).
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/u

// The one legal (letter-first) environment variable name used everywhere a
// resident key is read from the host's own secret store -- by the printed
// `claude mcp add` / `codex mcp add` commands (scripts/connect.mjs,
// scripts/setup.mjs) and by this script's own rotate/recover/pair fallback
// below. A single consistent name means a caller exports it once. Every
// env-var name this repo prints or reads must match
// /^[A-Za-z_][A-Za-z0-9_]*$/ -- `1F3D9_...` forms do not, because POSIX
// shells refuse `export NAME=value` (and `${NAME}` expansion) when NAME
// starts with a digit.
const AGENT_SECRET_ENV_VAR = 'AGENT_1F3D9_SECRET'

function fail(message) {
  console.error(`identity-client: ${message}`)
  process.exitCode = 1
  return null
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token so a caller cannot defeat
      // the bare-secret-flag refusal below by writing --resident-key=...
      // instead of --resident-key ... (both still land in shell history and
      // process listings the exact same way).
      const equalsIndex = body.indexOf('=')
      if (equalsIndex !== -1) {
        flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
        continue
      }
      const name = body
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        index += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function originOf(flags) {
  const raw = flags.origin ?? process.env.IDENTITY_ORIGIN ?? DEFAULT_ORIGIN
  const trimmed = raw.replace(/\/+$/u, '')
  const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined
  return assertAllowedOrigin(trimmed, { allowOrigin })
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
    return /^y(es)?$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

// --- Secret input: argv is refused, a file path or stdin is required ------

// argv-flag name -> the -file flag that must supply it instead. Both values
// here can authenticate a request or consume a one-use credential, so
// neither may ever be a bare argv flag.
const SECRET_ARGV_FLAGS = {
  'resident-key': 'resident-key-file',
  'recovery-code': 'recovery-code-file',
}

async function readStdinText() {
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function readSecretFromPathOrStdin(source) {
  const raw = source === '-' ? await readStdinText() : readFileSync(source, 'utf8')
  const value = raw.trim()
  if (!value) throw new Error(`no value read from ${source === '-' ? 'stdin' : source}`)
  return value
}

/**
 * Refuses --resident-key or --recovery-code as a bare flag and resolves the
 * matching --*-file flag (a path, or `-` for stdin) into the plain secret
 * value the caller below expects. Falls back to the given environment
 * variables only when neither argv form is present -- an environment
 * variable is not visible in a process listing the way argv is, so it stays
 * allowed as before.
 */
async function resolveSecretArg(flags, bareName, envNames = []) {
  const fileName = SECRET_ARGV_FLAGS[bareName]
  if (bareName in flags) {
    throw new Error(
      `--${bareName} is refused as a bare flag (this also catches --${bareName}=VALUE): it would land ` +
      `in shell history and process listings. If you just typed it either way, treat that value as ` +
      `exposed now and rotate it. Use --${fileName} <path> (or --${fileName} - to read one value from ` +
      'stdin) instead.',
    )
  }
  if (fileName in flags) {
    const source = flags[fileName]
    if (typeof source !== 'string') throw new Error(`--${fileName} requires a path or -`)
    return readSecretFromPathOrStdin(source)
  }
  for (const envName of envNames) {
    if (process.env[envName]) return process.env[envName]
  }
  return null
}

// --- Secret output: hidden unless the caller opts in at a real TTY --------

/**
 * The pure predicate revealOrHide below is built on -- exported separately
 * so a test can exercise all four combinations of (reveal flag) x (TTY)
 * directly, without needing to fork a subprocess whose own stdout can never
 * be a real TTY either way (which is exactly why the naive version of that
 * test could not actually reach or fail on the reveal branch at all).
 */
function shouldReveal(flags, isTty) {
  return flags.reveal === true && isTty === true
}

/**
 * Prints `values` only when the caller passed --reveal AND stdout is an
 * interactive TTY (never a pipe, redirect, or captured subprocess output --
 * exactly where a secret could land in a log or another program's memory).
 * Otherwise prints only a pointer to where the value already went.
 */
function revealOrHide(flags, label, values) {
  if (shouldReveal(flags, process.stdout.isTTY)) {
    console.log(`${label} (shown once):`)
    for (const value of values) console.log(value)
    return
  }
  console.log(
    `${label}: not printed to the terminal (pass --reveal at an interactive TTY to see it ` +
    'once); read it back from storage instead.',
  )
}

// --- Secure storage -----------------------------------------------------

function vaultTarget(origin, handleOrLabel) {
  return `1f3d9:${origin}:${handleOrLabel}`
}

// homeDir is injectable (defaults to the real home directory) so tests can
// round-trip storeSecret/readSecret against a temp directory instead of the
// caller's real ~/.1f3d9/credentials.
function credentialsFilePath(origin, handleOrLabel, homeDir = homedir()) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeLabel = handleOrLabel.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir, '.1f3d9', 'credentials', `${safeOrigin}__${safeLabel}.json`)
}

/**
 * The staging label a replacement credential is written under before it is
 * confirmed.
 *
 * `kind === 'registration'` gets a short random suffix, making the label
 * unique PER RUN rather than a pure function of `handle` alone. Without
 * this, two concurrent `register` invocations racing the SAME requested
 * handle would stage their bundles under the identical label; the winner's
 * own cleanup (promoteReplacementKey's final `deleteSecret`, once its write
 * actually lands) would then delete whatever the LOSER had just staged
 * there -- even though the loser's resident was itself confirmed
 * server-side and is now permanent. With the suffix, each run's staging
 * entry is exclusively its own: nothing but that run's own successful
 * promotion (or its own error-path cleanup) ever deletes it.
 *
 * `rotate()`/`recoverBegin()` do not get a suffix: their staging label is
 * scoped to a handle the caller already owns and confirms via a valid
 * resident key/recovery code, and promoteReplacementKey's per-(origin,
 * handle) file lock already serializes concurrent runs for that handle
 * end to end -- there is no legitimate way for two DIFFERENT callers to
 * even reach that code path for the same handle at once the way two
 * `register` calls can both request the same not-yet-owned handle.
 */
function pendingLabel(handle, kind) {
  if (kind === 'registration') {
    return `${handle}--pending-registration-${randomBytes(4).toString('hex')}`
  }
  return `${handle}--pending-${kind}`
}

/**
 * True for a staging label (`pendingLabel` above), never a real registered
 * identity. Covers every kind `pendingLabel` can produce, including the
 * per-run suffixed registration form -- an abandoned registration staging
 * entry (a run that died between staging and promotion) must never trip
 * setup.mjs's duplicate-identity guard (`listVaultLabels` filters through
 * this) the way a genuine second identity would.
 */
function isPendingLabel(label) {
  return /--pending-(?:rotation|recovery|registration(?:-[0-9a-f]+)?)$/u.test(label)
}

// --- Non-secret vault index (macOS and Windows) -----------------------------
//
// macOS Keychain has no reliable, non-interactive way for this script to
// enumerate every entry it owns: `security dump-keychain` prints every
// stored secret in the user's whole login keychain, not just this plugin's
// entries, so using it here to answer "does ANY entry already exist for
// this origin" would mean reading (and having to filter through) secrets
// this script has no business touching at all. Windows has a different
// problem with the same shape: `cmdkey /list` is this script's only
// non-interactive way to enumerate entries, but its output is localized --
// on a non-English Windows install the literal "Target:" label this script
// parses for never appears, so scraping it alone silently returns nothing,
// language-dependently. Instead, storeSecret and deleteSecret below keep a
// small non-secret index file -- ~/.1f3d9/vault-index.json, labels only,
// never a key or recovery code -- that setup.mjs's duplicate-identity guard
// reads through listVaultLabels. It is a heuristic, not a source of truth:
// it can go stale if an entry is removed by some other tool (Keychain
// Access.app, Windows Credential Manager's own UI, `security`/`cmdkey` by
// hand), and listVaultLabels below treats that as fine to err toward, since
// the whole point is only ever to make setup ask for --new-identity one
// time too many, never to silently register a real duplicate resident. On
// win32, listVaultLabels unions this index with whatever `cmdkey /list`
// scraping does find, rather than depending on the index alone -- the index
// is best-effort too (a write failure here is never fatal), so neither
// source alone is trusted as complete.

function vaultIndexPath(homeDir = homedir()) {
  return join(homeDir, '.1f3d9', 'vault-index.json')
}

function readVaultIndex(homeDir) {
  try {
    const parsed = JSON.parse(readFileSync(vaultIndexPath(homeDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// updateVaultIndex is a read-modify-write over one shared file with no
// built-in locking of its own -- two runs updating it at nearly the same
// moment (a rotate and a register from two different sessions, or just two
// tests in this repo's own suite) can each read the same starting state,
// mutate their own copy, and write it back, with the second write silently
// discarding the first's change. lockWithRetry below closes that window
// with a plain `wx`-mode (O_EXCL) lockfile next to vault-index.json: only
// one process can ever hold that name at once, so a second one either waits
// briefly or, if the lock looks abandoned, breaks it and proceeds.
const VAULT_INDEX_LOCK_STALE_MS = 5_000
const VAULT_INDEX_LOCK_MAX_WAIT_MS = 2_000
const VAULT_INDEX_LOCK_RETRY_MS = 20

function sleepSyncMs(ms) {
  // A real, blocking sleep with no busy-spin -- Atomics.wait blocks this
  // thread without burning CPU, unlike a `while (Date.now() < until) {}`
  // spin loop would. Safe here because this whole file is synchronous,
  // single-threaded CLI code with no event loop work that a spin (or this)
  // would otherwise starve.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs `fn` (synchronous) while holding a short-lived lockfile at `lockPath`,
 * retrying with backoff for up to VAULT_INDEX_LOCK_MAX_WAIT_MS if another
 * process already holds it. A lock older than VAULT_INDEX_LOCK_STALE_MS is
 * treated as abandoned (the process that created it crashed, was killed, or
 * otherwise never reached its own cleanup) and broken rather than honored
 * forever -- this file's own contents are always small and held only for the
 * few synchronous fs calls inside `fn`, so a real holder is never actually
 * still working after that long. Returns `undefined` (running `fn` not at
 * all) if the wait budget is exhausted without ever acquiring the lock,
 * rather than blocking indefinitely -- callers here already treat the whole
 * operation as best effort.
 */
function withFileLock(lockPath, fn) {
  const deadline = Date.now() + VAULT_INDEX_LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let staleEnough = false
      try {
        staleEnough = Date.now() - statSync(lockPath).mtimeMs > VAULT_INDEX_LOCK_STALE_MS
      } catch {
        // The lock disappeared between the EEXIST above and this stat --
        // another process's own cleanup won that race; just retry.
      }
      if (staleEnough) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process may have broken (or re-created) it first; retry
          // either way rather than treating that as this call's failure.
        }
        continue
      }
      if (Date.now() >= deadline) return undefined
      sleepSyncMs(VAULT_INDEX_LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // Best effort -- see the module comment above.
    }
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * Best effort: the index is a heuristic, so a write failure here is never
 * fatal. Also a no-op, on purpose, when `mutate` would not actually change
 * anything -- most commonly deleteSecret's own cleanup of a label this
 * particular homeDir's index never held in the first place (a mismatched
 * homeDir between the storeSecret and deleteSecret call that wrote/read
 * it, or simply deleting something already gone). Without this check,
 * every such call would still create ~/.1f3d9 and (re)write
 * vault-index.json purely to record the same empty state it already had --
 * which is exactly how a caller that forgets to pass the SAME `homeDir` a
 * test used elsewhere quietly starts writing into the operator's real
 * home. This is a defense-in-depth backstop, not a substitute for passing
 * `homeDir` correctly at every call site -- see
 * test/*.test.mjs and scripts/run-tests-with-home-guard.mjs.
 *
 * A cheap, unlocked peek decides first whether anything would change at
 * all; only when it would does this go on to create the directory, take
 * the lock, and re-check under it (a concurrent writer could have changed
 * things between the peek and the lock) before actually writing.
 */
function updateVaultIndex(origin, label, homeDir, mutate) {
  try {
    const path = vaultIndexPath(homeDir)

    const peekIndex = readVaultIndex(homeDir)
    const peekLabels = new Set(Array.isArray(peekIndex[origin]) ? peekIndex[origin] : [])
    const probeLabels = new Set(peekLabels)
    mutate(probeLabels, label)
    if (setsEqual(probeLabels, peekLabels)) return

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    withFileLock(`${path}.lock`, () => {
      const index = readVaultIndex(homeDir)
      const labels = new Set(Array.isArray(index[origin]) ? index[origin] : [])
      const before = new Set(labels)
      mutate(labels, label)
      if (setsEqual(labels, before)) return
      index[origin] = [...labels]
      writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
    })
  } catch {
    // Best effort -- see the module comment above.
  }
}

/**
 * The PowerShell/.NET shim that writes one credential through the real
 * Win32 CredWrite API. The secret bundle travels to this process over
 * stdin, as base64-encoded JSON -- never as a command-line argument, so it
 * is never visible in a process listing (`ps`, Task Manager) and never
 * appears in this command's own failure message. Mirrors the CredRead shim
 * in readSecret below.
 */
const WINDOWS_CRED_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredW1F3D9 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
}
'@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$blobBytes = [Convert]::FromBase64String($payload.blob)
$targetPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.target)
$userPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.username)
$blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($blobBytes.Length, 1))
if ($blobBytes.Length -gt 0) {
  [Runtime.InteropServices.Marshal]::Copy($blobBytes, 0, $blobPtr, $blobBytes.Length)
}
$cred = New-Object CredW1F3D9+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1
$cred.TargetName = $targetPtr
$cred.Comment = [IntPtr]::Zero
$cred.CredentialBlobSize = $blobBytes.Length
$cred.CredentialBlob = $blobPtr
$cred.Persist = 2
$cred.AttributeCount = 0
$cred.Attributes = [IntPtr]::Zero
$cred.TargetAlias = [IntPtr]::Zero
$cred.UserName = $userPtr
$ok = [CredW1F3D9]::CredWrite([ref]$cred, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($targetPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($userPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
if (-not $ok) { exit 1 }
`

/** Never include the caught error's own message/output: it may echo stdin back. */
function secretFreeStorageError(where, target) {
  return new Error(`could not write to ${where} (target "${target}"); no secret was included in this error`)
}

function writeWindowsCredential(execImpl, target, username, base64Blob) {
  const payload = JSON.stringify({ target, username, blob: base64Blob })
  try {
    execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CRED_WRITE_SCRIPT], {
      input: payload,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch {
    throw secretFreeStorageError('Windows Credential Manager', target)
  }
}

function shellQuoteForSecurityInteractive(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

function writeMacKeychainCredential(execImpl, service, account, base64Blob) {
  const script = [
    `add-generic-password -a ${shellQuoteForSecurityInteractive(account)}`,
    `-s ${shellQuoteForSecurityInteractive(service)}`,
    `-w ${shellQuoteForSecurityInteractive(base64Blob)} -U`,
    'quit',
    '',
  ].join('\n')
  try {
    // Interactive mode (`-i`) reads its subcommands from stdin, so the
    // password never becomes a `security` process argument the way a direct
    // `add-generic-password -w <value>` invocation would.
    execImpl('security', ['-i'], { input: script, stdio: ['pipe', 'ignore', 'pipe'] })
  } catch {
    throw secretFreeStorageError('macOS Keychain', service)
  }
}

/**
 * Writes one secret bundle to the OS credential store and returns a
 * human-readable, secret-free description of where it went. Store one JSON
 * blob per identity (key + recovery codes together) so a caller resuming
 * later reads them back from the same place with the same tool. The secret
 * bundle is always base64-encoded JSON delivered over stdin to whichever
 * tool writes it, never a process argument -- see writeWindowsCredential and
 * writeMacKeychainCredential above. `deps.homeDir` is consulted on macOS
 * and Windows (the non-secret vault index) and on the plain-file path (the
 * credentials directory); it never changes where the OS credential store
 * itself keeps the secret entry.
 */
function storeSecret(origin, label, payload, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  const serialized = JSON.stringify(payload)
  const encoded = Buffer.from(serialized, 'utf8').toString('base64')
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    writeWindowsCredential(execImpl, target, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.add(thisLabel))
    return `Windows Credential Manager (target "${target}", value base64-encoded JSON)`
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    writeMacKeychainCredential(execImpl, service, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.add(thisLabel))
    return `macOS Keychain (service "${service}", account "${label}")`
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  // writeFileSync's `mode` option is ignored when the file already exists
  // (it only applies to a newly created file), so an existing world/group
  // readable file would silently keep its old permissions. chmodSync after
  // the write is what actually narrows an existing file, and it can fail
  // silently on filesystems without POSIX permission bits (e.g. FAT/exFAT)
  // -- so verify the mode actually landed instead of trusting either call.
  writeFileSync(filePath, `${serialized}\n`, { mode: 0o600 })
  if (os === 'win32') {
    // POSIX mode bits do not apply on Windows; the file already went
    // through the win32 branch above, so this path is unreachable in
    // practice, but keep the message accurate if it is ever reached.
    return `local file ${filePath} (POSIX mode bits do not apply on this platform)`
  }
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX permissions;
    // fall through to the stat check below, which will catch the case
    // where the file ended up group/world readable.
  }
  let observedMode
  try {
    observedMode = statSync(filePath).mode & 0o777
  } catch {
    throw secretFreeStorageError('local credentials file', filePath)
  }
  if ((observedMode & 0o077) !== 0) {
    try {
      unlinkSync(filePath)
    } catch {
      // Best effort: the file could not be removed either, but we still
      // must not report success or leave the caller believing the secret
      // is safely stored.
    }
    throw secretFreeStorageError('local credentials file', filePath)
  }
  return `local file ${filePath} (mode ${observedMode.toString(8).padStart(3, '0')})`
}

/**
 * Raised by readSecret when the vault reports a target/service/file exists
 * but its content could not be decoded back into the JSON bundle storeSecret
 * writes. Kept distinct from "nothing is stored there" (readSecret returns
 * `{ found: false }` for that case) so a caller can tell "there was never a
 * prior entry" -- fine, nothing to carry forward -- apart from "a prior
 * entry exists but this read cannot recover it" -- never safe to silently
 * treat as empty, because doing so is exactly how rotation and recovery used
 * to overwrite a live vault entry and drop the recovery codes and
 * client_class it carried.
 */
class SecretReadFailure extends Error {}

/**
 * The counterpart to storeSecret: reads back the JSON bundle this script
 * wrote for `label`. Returns `{ found: false, value: null }` when nothing is
 * stored there. Returns `{ found: true, value }` when the stored entry was
 * read and decoded successfully -- a write followed by a read must return
 * exactly what was written, on every supported platform. Throws
 * SecretReadFailure when the vault reports an entry exists but this read
 * could not decode it, so a caller can refuse to promote over it rather than
 * silently treating "could not read" the same as "nothing there". Used by
 * rotate/recoverBegin below to carry forward fields -- recovery codes,
 * client_class -- that the replacement key alone does not carry.
 */
function readSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    const escapedTarget = target.replaceAll("'", "''")
    // cmdkey itself has no way to print a stored password back out -- by
    // design it only lists the account name. Reading it back needs the real
    // Win32 Credential Manager API (CredRead), reached here through a small
    // inline PowerShell/.NET shim.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cred1F3D9 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
$ok = [Cred1F3D9]::CredRead('${escapedTarget}', 1, 0, [ref]$ptr)
if (-not $ok) { exit 1 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Cred1F3D9+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Cred1F3D9]::CredFree($ptr)
# writeWindowsCredential above stores the exact raw bytes CredWrite was given
# (the UTF-8 bytes of the JSON payload, decoded from the base64 wire form
# sent over stdin) -- never UTF-16. Re-encode those same raw bytes back to
# base64 here so the Node side's Buffer.from(encoded, 'base64') below
# recovers the exact original bytes, with no text-encoding step in between
# that could corrupt them. (A prior version of this script decoded the
# CredentialBlob as UTF-16LE here, which does not match how it was written
# and made every read return null after a successful write.)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`
    // A non-zero exit here means CredRead found nothing at this target (the
    // `if (-not $ok) { exit 1 }` above) -- that is "not found", not a read
    // failure, so it maps to { found: false }, not a thrown error.
    let encoded
    try {
      encoded = execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    if (!encoded) return { found: false, value: null }
    // Past this point CredRead reported an entry and returned bytes: any
    // decode failure here is a corrupt or unrecoverable entry, not a missing
    // one, so it throws instead of returning { found: false }.
    try {
      return { found: true, value: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the Windows Credential Manager entry for "${label}" exists but could not be decoded back into ` +
        'the expected JSON bundle',
      )
    }
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    // A non-zero exit here means `security` found no matching keychain item
    // -- "not found", not a read failure.
    let serialized
    try {
      serialized = execImpl(
        'security',
        ['find-generic-password', '-a', label, '-s', service, '-w'],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    // writeMacKeychainCredential above stores the base64-encoded JSON
    // payload as the keychain password (`-w base64Blob`), matching what it
    // sends -- so this must decode that same base64 back before parsing.
    // (A prior version of this script parsed the raw retrieved text as JSON
    // directly, without ever base64-decoding it, so it never matched what
    // was actually stored and every read failed.)
    try {
      return { found: true, value: JSON.parse(Buffer.from(serialized.trim(), 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the macOS Keychain entry for "${label}" exists but could not be decoded back into the expected ` +
        'JSON bundle',
      )
    }
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  let raw
  try {
    raw = (deps.readFileSync ?? readFileSync)(filePath, 'utf8')
  } catch {
    return { found: false, value: null }
  }
  try {
    return { found: true, value: JSON.parse(raw) }
  } catch {
    throw new SecretReadFailure(`the credentials file "${filePath}" exists but could not be parsed as JSON`)
  }
}

/**
 * Lock path for promoteReplacementKey's critical section below, scoped to
 * one (origin, handle) pair -- deliberately not to the caller (register,
 * rotate, recoverBegin) or to the specific staging label, since what this
 * must serialize against is any OTHER promotion racing for the same live
 * vault entry on this host, whichever command started it. Lives in the
 * same ~/.1f3d9 directory as vault-index.json and reuses the exact same
 * withFileLock mechanism (short-retry, stale-aware) defined above.
 */
function promoteLockPath(origin, handle, homeDir) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeHandle = handle.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir ?? homedir(), '.1f3d9', `promote-lock__${safeOrigin}__${safeHandle}.lock`)
}

/**
 * Shared by register()/rotate()/recoverBegin() after their server-side
 * confirm has already succeeded (so the replacement resident_key is
 * already the live one on the server -- only where it lives in the local
 * vault is still being settled here). Reads back the live entry to carry
 * forward fields the replacement key alone does not carry (via
 * `mergeFields`), then overwrites that live entry and deletes the staging
 * copy.
 *
 * The read, the refuseIfPresent re-check, and the write all run inside one
 * withFileLock critical section keyed by (origin, handle) (see
 * promoteLockPath above): two promotions for the SAME handle on THIS host
 * -- two concurrent `register` invocations racing the same requested
 * handle is the case that matters in practice -- are serialized end to
 * end, so the second one's read can never observe the stale "not found"
 * the first one already read past. This closes the same-HOST race
 * completely; it closes nothing across hosts (two different machines
 * racing the same handle are decided by the city's own confirm, not by
 * anything this client does locally -- see register()'s own comment).
 * `refuseIfPresent` below is what actually decides who wins on a single
 * host once that ordering is fixed; the lock is what makes the ordering
 * trustworthy to decide from in the first place.
 *
 * If the read-back reports the live entry exists but cannot be decoded
 * (SecretReadFailure), this refuses to promote: the live entry is left
 * completely untouched, and -- critically -- the staging copy is also left
 * in place rather than deleted, because it is the only place the already-
 * confirmed replacement key currently lives. The caller sees exactly where
 * to recover it and what to fix before retrying.
 *
 * The write that follows can fail too (a locked keychain, a permission
 * error, a full disk) -- and by the time this function runs, the server
 * already confirmed the rotation/recovery, so the OLD key is already dead
 * there. A write failure here must never surface as a bare "could not
 * write" with no context: the caller needs to know the old key no longer
 * works AND that the only copy of the new one currently lives at
 * `stagingLabel` and nowhere else. The staging copy is left in place (it is
 * only deleted after storeSecret below actually succeeds), so nothing is
 * lost -- but it must be recovered by hand.
 *
 * `refuseIfPresent` (default false): when true, refuses to overwrite an
 * entry the readSecret call just above found -- register() passes this,
 * since (unlike rotate/recoverBegin, which intentionally replace the live
 * entry for the SAME already-owned handle) register() must never silently
 * overwrite a DIFFERENT registration that came to exist for this handle
 * after register()'s own pre-flight check ran and before this, its last
 * chance to check again immediately before the write -- now made safe to
 * trust by the lock above, rather than merely narrowing the window the way
 * an unlocked re-check would. Same "staging copy kept, caller-worded
 * message" shape as the SecretReadFailure case above.
 */
function promoteReplacementKey(origin, handle, stagingLabel, residentKey, mergeFields, deps = {}, { refuseIfPresent = false } = {}) {
  const lockPath = promoteLockPath(origin, handle, deps.homeDir)
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const result = withFileLock(lockPath, () => {
    let previous
    try {
      previous = readSecret(origin, handle, deps)
    } catch (error) {
      throw new Error(
        `refusing to overwrite the existing vault entry for "${handle}": ${error.message}. ` +
        'The already-confirmed replacement key was NOT lost -- it is still stored under the ' +
        `staging label "${stagingLabel}". Resolve the unreadable entry, read the replacement key back ` +
        `from "${stagingLabel}", then store it under "${handle}" yourself.`,
      )
    }
    if (refuseIfPresent && previous.found) {
      // With the lock above held for this entire read-check-write section,
      // this re-check is no longer merely narrowing a TOCTOU window -- it
      // is the actual, trustworthy last word on whether this handle is
      // free on THIS host: no other promoteReplacementKey call for the
      // same (origin, handle) can be reading or writing concurrently while
      // this one holds the lock. `previous` above was read inside that
      // same locked section, immediately before the write below.
      //
      // Whether the staging entry is STILL there is a separate question
      // from whether the live entry now exists, and this refusal must not
      // assert an answer to it without checking: re-read `stagingLabel`
      // itself, inside this same locked section, rather than repeating the
      // fixed "it is still stored under the staging label" claim
      // unconditionally. Since pendingLabel() now mints a per-run-unique
      // label for registration (see its own doc comment), nothing but
      // THIS run's own successful promotion could have deleted it -- and
      // this run has not reached that point -- so in practice this reads
      // found:true; the explicit check exists so the message never lies if
      // that ever stops being true, and says plainly when it is gone
      // instead.
      let stagingStillPresent
      try {
        stagingStillPresent = readSecret(origin, stagingLabel, deps).found
      } catch {
        // An unreadable staging entry is not the same as "confirmed
        // present" -- word the refusal as not-verifiable rather than
        // asserting something this call cannot actually stand behind.
        stagingStillPresent = false
      }
      const stagingNote = stagingStillPresent
        ? `The confirmed resident key from THIS registration was NOT lost -- it is still stored under the ` +
          `staging label "${stagingLabel}" and nowhere else. Work out which of the two entries is the one ` +
          `you actually want (for example \`key status --handle ${handle}\`), then store the key from ` +
          `"${stagingLabel}" under "${handle}" yourself if it turns out to be the one that should have won.`
        : `The confirmed resident key from THIS registration is NO LONGER at its staging label "${stagingLabel}" ` +
          '-- it cannot be recovered from this vault. Check whatever recorded the resident_key when this ' +
          'registration confirmed (terminal scrollback, a captured --reveal run) before concluding it is ' +
          'gone for good.'
      throw new Error(
        `refusing to overwrite the vault entry for "${handle}" that now exists: it was not there when this ` +
        'registration started, so a concurrent run on this host must have won the race for this handle. ' +
        stagingNote,
      )
    }
    let location
    try {
      location = storeSecret(origin, handle, {
        kind: 'resident',
        handle,
        ...mergeFields(previous.found ? previous.value : null),
        resident_key: residentKey,
        origin,
        stored_at: new Date().toISOString(),
      }, deps)
    } catch (error) {
      throw new Error(
        `the rotation/recovery already CONFIRMED, so the old key for "${handle}" no longer works: ${error.message}. ` +
        `The replacement key is stored under "${stagingLabel}" and nowhere else -- read it back from ` +
        `"${stagingLabel}", then store it under "${handle}" yourself before doing anything else.`,
      )
    }
    deleteSecret(origin, stagingLabel, deps)
    return location
  })
  if (result === undefined) {
    // withFileLock returns undefined, without ever running the critical
    // section above, only when it could not acquire the lock within its
    // own wait budget -- meaning another promoteReplacementKey call for
    // this exact (origin, handle) is apparently still running on this
    // host. Silently returning undefined here (as a caller-visible
    // "location") would be worse than the race this lock exists to close:
    // it would report success without ever having read, checked, or
    // written anything.
    throw new Error(
      `could not acquire the per-handle vault lock for "${handle}" on this host within ` +
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: another registration, rotation, or recovery for the same handle ` +
      'appears to still be running concurrently on this host. The already-confirmed replacement key was NOT ' +
      `lost -- it is still stored under the staging label "${stagingLabel}" and nowhere else. Retry once the ` +
      `other run finishes, or read the key back from "${stagingLabel}" and store it under "${handle}" yourself.`,
    )
  }
  return result
}

/** Removes a stored secret bundle. Best effort: a missing entry is not an error. */
function deleteSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    try {
      execImpl('cmdkey', [`/delete:${vaultTarget(origin, label)}`], { stdio: 'ignore' })
    } catch {
      // Best effort: nothing to delete, or cmdkey already reports failure loudly enough elsewhere.
    }
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
    return
  }
  if (os === 'darwin') {
    try {
      execImpl(
        'security',
        ['delete-generic-password', '-a', label, '-s', vaultTarget(origin, label)],
        { stdio: 'ignore' },
      )
    } catch {
      // Best effort, same as above.
    }
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
    return
  }
  try {
    rmSync(credentialsFilePath(origin, label, deps.homeDir), { force: true })
  } catch {
    // Best effort, same as above.
  }
}

/**
 * Lists every label this host's vault currently holds for `origin`,
 * excluding staging labels (`pendingLabel` above) -- never the exact-handle
 * lookup readSecret already does, but a genuine enumeration of "does
 * anything else already exist here", so setup.mjs's duplicate-identity
 * guard can refuse a fresh registration under a different handle instead of
 * silently creating a second, permanent, unrecoverable resident next to one
 * that already exists. Never throws: an enumeration failure (no `cmdkey` on
 * PATH, an unreadable directory, a missing index) is treated as "found
 * nothing", the same fail-open behavior that guard already accepts for a
 * missing setup-state.json -- the guard exists to catch the common case
 * (state lost, vault intact), not to be a perfect audit.
 */
function listVaultLabels(origin, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    const prefix = vaultTarget(origin, '')
    // cmdkey's own output is localized -- on a non-English Windows install
    // the literal "Target:" label below never appears, so this alone can
    // silently return nothing. Union it with the non-secret vault index
    // (language-independent, maintained by storeSecret/deleteSecret above)
    // instead of trusting either source alone: a failed or empty cmdkey
    // scrape still leaves the index, and a stale/incomplete index still
    // leaves whatever cmdkey actually found.
    const fromCmdkey = []
    try {
      const output = execImpl('cmdkey', ['/list'], { encoding: 'utf8' })
      for (const match of output.matchAll(/Target:\s*(.+)\s*$/gmu)) {
        // Real `cmdkey /list` output prefixes the target this script wrote
        // with its own credential-type marker -- observed as
        // "LegacyGeneric:target=1f3d9:<origin>:<label>", not the bare target
        // -- so search for the prefix anywhere in the line rather than
        // requiring it at the very start.
        const target = match[1].trim()
        const index = target.indexOf(prefix)
        if (index !== -1) fromCmdkey.push(target.slice(index + prefix.length))
      }
    } catch {
      // cmdkey unavailable or failed -- fall through to the index below
      // rather than reporting an empty result outright.
    }
    const vaultIndex = readVaultIndex(deps.homeDir)
    const fromIndex = Array.isArray(vaultIndex[origin]) ? vaultIndex[origin] : []
    const labels = new Set([...fromCmdkey, ...fromIndex])
    return [...labels].filter(label => !isPendingLabel(label))
  }
  if (os === 'darwin') {
    const index = readVaultIndex(deps.homeDir)
    const labels = Array.isArray(index[origin]) ? index[origin] : []
    return labels.filter(label => !isPendingLabel(label))
  }
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const dir = join(deps.homeDir ?? homedir(), '.1f3d9', 'credentials')
  const prefix = `${safeOrigin}__`
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => name.slice(prefix.length, -'.json'.length))
    .filter(label => !isPendingLabel(label))
}

// --- HTTP -----------------------------------------------------------------

/**
 * Wraps a fetch failure (DNS, connection refused, timeout, TLS -- anything
 * before a response ever arrives) into a caller-facing message that names
 * the origin, says nothing was created, and suggests a next step, instead of
 * letting the bare engine error ("fetch failed") escape unexplained. Kept as
 * a byte-identical copy of the city's own reference client
 * (scripts/identity-client.mjs); if this file ever diverges from that
 * upstream copy, port the fix there too.
 */
async function fetchOrExplain(url, init) {
  try {
    // redirect: 'error' overrides anything a caller passed in `init` -- a
    // real identity door has no reason to redirect any of these calls, and
    // without this, a 307/308 response from the (validated) named origin
    // could carry a secret request body to an entirely different host on
    // the next hop, a hop assertAllowedOrigin (called only against the
    // first-hop origin, in originOf above) never gets a chance to check.
    return await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    // Node's fetch wraps the real failure in `error.cause`, which for a
    // connection failure is itself an AggregateError with an EMPTY top-level
    // message and the useful text one level deeper in `.errors[0].message`
    // (or just a `.code` like ECONNREFUSED/ENOTFOUND when even that is
    // absent) -- so fall through several levels rather than printing a bare
    // "(network error: )" with nothing after the colon.
    const cause = error?.cause
    const detail =
      cause?.message
      || cause?.errors?.[0]?.message
      || cause?.code
      || error?.message
      || String(error)
    throw new Error(
      `could not reach ${url} (network error: ${detail}); nothing was created -- check the address and ` +
      'your connection, then retry',
    )
  }
}

async function postJson(origin, path, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // Non-JSON response falls through with parsed === null below.
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    const nextStep = parsed?.next_step ? ` next_step: ${parsed.next_step}` : ''
    throw new Error(`${path} refused: ${error}.${nextStep}`)
  }
  return parsed
}

async function postAuthed(origin, path, residentKey, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${residentKey}`,
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled below
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    throw new Error(`${path} refused: ${error}`)
  }
  return parsed
}

// --- Commands ---------------------------------------------------------

/** Best effort: tells the city to release a stage it will otherwise just let expire on its own. */
async function cancelStage(origin, path, stageToken) {
  try {
    await postJson(origin, path, { action: 'cancel', stage_token: stageToken })
  } catch {
    // Best effort -- the stage expires on its own either way, and the
    // caller above is already reporting the real failure.
  }
}

async function register(flags) {
  const origin = originOf(flags)
  const handle = requireFlag(flags, 'handle')
  if (!HANDLE_RE.test(handle)) {
    throw new Error(
      `--handle "${handle}" does not match the city's handle rule ${HANDLE_RE.source} (lowercase letters, ` +
      'digits, and hyphens, 3-32 characters, must start with a letter or digit); nothing was created -- ' +
      'choose a handle that already matches this rule before asking a human to approve it',
    )
  }
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }
  const model = typeof flags.model === 'string' ? flags.model : ''
  const replaceVaultEntry = flags['replace-vault-entry'] === true

  let humanApproved = flags['human-approved'] === true
  if (!humanApproved) {
    humanApproved = await askYesNo(
      `Confirm the permanent public handle "${handle}" was chosen with a human's approval. Register it now?`,
    )
  }
  if (!humanApproved) {
    throw new Error(
      'registration needs human approval of the permanent public name; re-run with a "y" answer or pass --human-approved only after that approval already happened',
    )
  }

  const staged = await postJson(origin, '/api/register', {
    action: 'stage',
    handle,
    ...(model ? { model } : {}),
    client_class: clientClass,
    human_approved: true,
  })
  // The city may normalize the requested handle at staging time -- from
  // here on ITS answer is the identity of record, never the spelling this
  // call was invoked with (see the module comment on HANDLE_RE above).
  const stagedHandle = typeof staged.handle === 'string' ? staged.handle : handle

  // Same discipline rotate()/recoverBegin() already apply, extended to
  // register() itself: never overwrite whatever the vault already holds
  // under the identity of record without an explicit, deliberate override.
  // Without this, a stale or normalized label collision would let the
  // storeSecret call below silently destroy an existing key and its
  // recovery codes -- exactly the failure mode a dropped/ambiguous probe
  // result (setup.mjs's own vault-adopt guard cannot always tell "rejected"
  // from "could not tell") could otherwise walk straight into.
  if (!replaceVaultEntry) {
    let existing
    try {
      existing = readSecret(origin, stagedHandle)
    } catch (error) {
      await cancelStage(origin, '/api/register', staged.stage_token)
      throw new Error(
        `refusing to register over a vault entry for "${stagedHandle}" that could not be read back: ` +
        `${error.message}. The staged registration was cancelled; nothing was created. Resolve the ` +
        'unreadable entry first, then retry -- or pass --replace-vault-entry only if you are certain that ' +
        'entry should be discarded.',
      )
    }
    if (existing.found) {
      await cancelStage(origin, '/api/register', staged.stage_token)
      throw new Error(
        `refusing to register over the vault entry that already exists for "${stagedHandle}": the staged ` +
        'registration was cancelled and nothing was created. Pass --replace-vault-entry only if you are ' +
        'certain that entry should be discarded -- doing so destroys whatever key and recovery codes it ' +
        'currently holds.',
      )
    }
  }

  // Stage the new bundle under a DISTINCT vault label first, exactly like
  // rotate()/recoverBegin() below -- never write to the live label before
  // confirm actually succeeds.
  const stagingLabel = pendingLabel(stagedHandle, 'registration')
  storeSecret(origin, stagingLabel, {
    kind: 'resident',
    handle: stagedHandle,
    client_class: clientClass,
    resident_key: staged.resident_key,
    recovery_codes: staged.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/register', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/register', staged.stage_token)
    throw error
  }

  // The identity of record is the city's CONFIRMED answer, falling back to
  // the staged one only if the response is somehow missing it -- never the
  // originally requested spelling. promoteReplacementKey moves the staged
  // bundle to that label and deletes the staging copy only once it has
  // actually landed there.
  const finalHandle = typeof confirmed.handle === 'string' ? confirmed.handle : stagedHandle

  // Validated here, before finalHandle is ever used as a vault label,
  // printed, or (via setup.mjs's regex parse of the "handle: " line below)
  // written into setup-state.json -- the same discipline every OTHER
  // handle in this file gets before use. The registration already happened
  // server-side by this point, so this is defense in depth against the
  // city's own confirmed spelling somehow failing the rule this script
  // otherwise enforces before ever asking a human to approve a handle, not
  // an expected path.
  if (!HANDLE_RE.test(finalHandle)) {
    // Best effort: the stage is already confirmed server-side, so this call
    // is unlikely to change anything beyond what confirming already did --
    // it costs nothing to attempt, and matches every other early exit in
    // this function that cancels the stage before refusing.
    await cancelStage(origin, '/api/register', staged.stage_token)
    throw new Error(
      `refusing to store or print the handle "${finalHandle}" the city confirmed for this registration: it ` +
      `does not match the local handle rule ${HANDLE_RE.source}. The resident was already created ` +
      'server-side under that exact spelling, and its confirmed resident key and recovery codes were NOT ' +
      `lost -- they are still stored under the staging label "${stagingLabel}" and nowhere else. Read them ` +
      `back from "${stagingLabel}" and store them under a label of your choosing yourself; this script will ` +
      'not do so automatically for a handle that fails its own naming rule.',
    )
  }

  // refuseIfPresent: register() must never silently overwrite a DIFFERENT
  // registration that came to exist for this exact handle after the
  // pre-flight check further up this function ran (see promoteReplacementKey's
  // own doc comment) -- unlike rotate()/recoverBegin() below, which
  // intentionally replace the live entry for the same already-owned handle.
  // Only when the caller passed --replace-vault-entry is that overwrite
  // actually intended -- the same flag the pre-flight check above already
  // honors, so the final write must honor it identically rather than
  // refusing what the caller explicitly asked to replace.
  const location = promoteReplacementKey(origin, finalHandle, stagingLabel, staged.resident_key, () => ({
    client_class: clientClass,
    recovery_codes: staged.recovery_codes,
  }), {}, { refuseIfPresent: !replaceVaultEntry })

  revealOrHide(flags, 'Resident key', [staged.resident_key])
  revealOrHide(flags, 'Recovery codes (all eight)', staged.recovery_codes)
  console.log(`handle: ${finalHandle}`)
  console.log(`resident_id: ${confirmed.resident_id}`)
  console.log(`stored: ${location}`)
}

async function rotate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }

  const staged = await postJson(origin, '/api/rotate', { action: 'begin', resident_key: residentKey })

  // Stage the replacement under a DISTINCT vault target first -- never
  // overwrite the live entry before confirm succeeds. If confirm below
  // fails for any reason, the live entry (still the OLD, still-valid key)
  // is never touched; only this staging copy exists, and it is deleted.
  const stagingLabel = pendingLabel(staged.handle, 'rotation')
  storeSecret(origin, stagingLabel, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/rotate', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/rotate', staged.stage_token)
    throw error
  }

  // Promote: merge the now-confirmed replacement key with whatever the live
  // entry already held (client_class), so rotation never silently drops
  // fields that only the pre-rotation entry carried. recovery_codes are
  // deliberately NOT carried forward: the city invalidates every recovery
  // code the moment a rotation confirms (front door: "Confirmation ...
  // invalidates ... every ... recovery code atomically"), so copying the
  // old set forward would leave the vault claiming eight codes that are
  // already dead. A recovery_codes_invalidated_at marker records that fact
  // instead, so `key show` can refuse to print them (see revealOrHide's
  // caller in key.mjs) and point at `recover generate`. Only now does the
  // live entry change; the staging copy is then deleted -- unless the
  // read-back of the live entry fails, in which case promoteReplacementKey
  // refuses to overwrite it and leaves the staging copy in place. See
  // promoteReplacementKey's own doc comment above.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    recovery_codes_invalidated_at: new Date().toISOString(),
  }))

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'your recovery codes were invalidated by this rotation (the city invalidates every recovery code on ' +
    'confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this rotation also revoked every connector session, authorization code, and delegated grant this ' +
    `resident had (the city invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function recoverGenerate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }
  const generated = await postJson(origin, '/api/recovery', { action: 'generate', resident_key: residentKey })

  // Write the fresh codes into the LIVE `handle` entry, not a sibling
  // `${handle}-recovery` label: a caller resuming later (rotate, recover
  // begin, key show) reads back the vault entry for `handle` and only that
  // entry, so a set stored anywhere else is invisible to them and the live
  // entry keeps claiming whatever (possibly invalidated) codes it already
  // had. If the live entry cannot be read back, this refuses to guess at
  // its other fields (client_class) rather than silently dropping them --
  // the city already holds the new codes as the only valid set regardless.
  let previous
  try {
    previous = readSecret(origin, generated.handle)
  } catch (error) {
    throw new Error(
      `the city already generated new recovery codes for "${generated.handle}", but the existing vault ` +
      `entry could not be read back to merge them in: ${error.message}. Resolve the unreadable entry, ` +
      'then re-run this command; it is safe to run again.',
    )
  }
  const location = storeSecret(origin, generated.handle, {
    kind: 'resident',
    handle: generated.handle,
    ...(previous.found && previous.value?.client_class ? { client_class: previous.value.client_class } : {}),
    resident_key: residentKey,
    recovery_codes: generated.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })
  // Best-effort cleanup of the sibling-label location a prior version of
  // this command used to write to, so a stale duplicate never lingers.
  deleteSecret(origin, `${generated.handle}-recovery`)
  revealOrHide(flags, 'New recovery codes (replace every earlier set)', generated.recovery_codes)
  console.log(`handle: ${generated.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverBegin(flags) {
  const origin = originOf(flags)
  const recoveryCode = await resolveSecretArg(flags, 'recovery-code')
  if (!recoveryCode || !RECOVERY_CODE_RE.test(recoveryCode)) {
    throw new Error('--recovery-code-file must point to a valid, unused recovery code')
  }

  const staged = await postJson(origin, '/api/recovery', { action: 'begin', recovery_code: recoveryCode })

  // Same staging discipline as rotate() above, and for the same reason: the
  // old key still works until confirm below actually succeeds, so the live
  // vault entry must not be touched before that.
  const stagingLabel = pendingLabel(staged.handle, 'recovery')
  storeSecret(origin, stagingLabel, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/recovery', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/recovery', staged.stage_token)
    throw error
  }

  // Same promote-or-refuse discipline as rotate() above -- see
  // promoteReplacementKey's doc comment. Recovery codes are dropped here
  // too and replaced with an invalidation marker, for the same reason as
  // rotate(): the front door confirms that using one recovery code
  // invalidates every sibling code atomically, not just the one spent.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    recovery_codes_invalidated_at: new Date().toISOString(),
  }))

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'every remaining recovery code was invalidated by this recovery (the city invalidates every sibling ' +
    'code on confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this recovery also revoked every connector session, authorization code, and delegated grant the old ' +
    `key had (the city invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function pair(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }
  const minted = await postAuthed(origin, '/api/pair', residentKey, {})
  // The pairing code is meant to be read by a human, not stored -- it is
  // single-use, expires in ten minutes, and never substitutes for the key.
  // Printing it is the entire point of this command, so it is not gated
  // behind --reveal the way the resident key and recovery codes are above.
  console.log('Pairing code (shown once, give it to the human completing hosted-chat sign-in):')
  console.log(minted.pairing_code)
  console.log(`expires_at: ${minted.expires_at}`)
}

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
  HANDLE_RE,
}
