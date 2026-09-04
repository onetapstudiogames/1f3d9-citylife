import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import {
  credentialsFilePath, readVaultIndex, splitStagingLabels, updateVaultIndex,
  vaultIndexEntriesToMap, vaultTarget, withRegistrationStagingLabels,
} from './vault-index.mjs'

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
  // Recorded into the non-secret index below so listVaultLabels can tell a
  // staging entry from a real resident without decoding the secret store
  // itself -- see the "Non-secret vault index" comment above.
  const staging = payload?.kind === 'staging'
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    writeWindowsCredential(execImpl, target, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
    return `Windows Credential Manager (target "${target}", value base64-encoded JSON)`
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    writeMacKeychainCredential(execImpl, service, label, encoded)
    updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
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
  // Recorded in the same non-secret vault index the win32/darwin backends
  // use, so listVaultLabels below can tell a staging entry from a real
  // resident without ever opening or parsing a credentials bundle -- see
  // the "Non-secret vault index" comment above.
  updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.set(thisLabel, { staging }))
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
  updateVaultIndex(origin, label, deps.homeDir, (labels, thisLabel) => labels.delete(thisLabel))
}

/**
 * Un-escapes one `security dump-keychain` attribute-value string: octal
 * BYTE escapes (`\NNN`, three digits) and a handful of backslash-escaped
 * literal characters (`\"`, `\\`). `security` emits `\NNN` per raw UTF-8
 * BYTE of the underlying string, not per UTF-16 code unit -- a non-ASCII
 * character like "é" (U+00E9, UTF-8 bytes 0xC3 0xA9) prints as two
 * consecutive escapes, `\303\251`. Decoding each escape independently with
 * `String.fromCharCode` (treating the octal value as a whole code point)
 * would turn that into "Ã©" -- mojibake, not "é" -- because it builds two
 * separate UTF-16 characters from what is actually one multi-byte UTF-8
 * sequence. This instead collects every byte (decoded octal escapes AND
 * the raw UTF-8 bytes of any literal/other-escaped text in between) into
 * one buffer and decodes the WHOLE thing as UTF-8 once at the end, so a
 * multi-byte character split across consecutive `\NNN` triplets round-trips
 * correctly. Any other `\X` sequence is left as `X` -- this plugin's own
 * service names are plain ASCII (see vaultTarget), so nothing beyond this
 * ever needs to round-trip through here in practice; a stray unrecognized
 * escape from some OTHER application's entry merely fails to match
 * darwinKeychainServiceLabels's own prefix test below, not a parse error.
 */
function unescapeSecurityDumpString(raw) {
  const chunks = []
  const escapeRe = /\\(\d{3}|.)/gsu
  let lastIndex = 0
  let match
  while ((match = escapeRe.exec(raw)) !== null) {
    if (match.index > lastIndex) chunks.push(Buffer.from(raw.slice(lastIndex, match.index), 'utf8'))
    const escaped = match[1]
    chunks.push(
      /^\d{3}$/u.test(escaped)
        ? Buffer.from([Number.parseInt(escaped, 8) & 0xff])
        : Buffer.from(escaped, 'utf8'),
    )
    lastIndex = escapeRe.lastIndex
  }
  if (lastIndex < raw.length) chunks.push(Buffer.from(raw.slice(lastIndex), 'utf8'))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Thrown by darwinKeychainServiceLabels (and surfaced through
 * listVaultLabels) when `security dump-keychain` truncated its output
 * (ENOBUFS) or was killed for running too long (ETIMEDOUT/timeout kill)
 * instead of actually finding nothing -- the enumeration is INCOMPLETE,
 * never "empty", and a caller like setup.mjs's duplicate-identity guard
 * must refuse rather than read that as "no other entry exists".
 */
class KeychainEnumerationIncomplete extends Error {}

/**
 * Parses raw `security dump-keychain` (metadata-only) output into every
 * `"svce"` (service name) value it finds -- no origin filtering, no prefix
 * stripping, just the correctly-decoded raw strings. Pulled out of
 * darwinKeychainServiceLabels below so a caller that needs every `1f3d9:`
 * entry across every origin (scripts/run-tests-with-home-guard.mjs, which
 * has no single `origin` to filter by) can share this exact parsing instead
 * of copying it -- a prior, now-fixed copy in that file did not run
 * unescapeSecurityDumpString, so it mojibake'd any non-ASCII label byte for
 * byte differently than this one. See unescapeSecurityDumpString's own doc
 * comment for why that decoding step matters.
 */
function parseSecurityDumpKeychainServiceNames(output) {
  if (typeof output !== 'string') return []
  const names = []
  // `security dump-keychain` prints a "svce" value two different ways: the
  // plain quoted form (group 1) when the whole string is printable, and
  // `0x<HEX>` -- optionally followed by a best-effort quoted/escaped
  // rendering, which this never needs to parse -- when it is not (group 2).
  // The earlier version of this regex only matched the plain form, so any
  // entry needing the hex form was silently dropped from the enumeration
  // rather than parsed; the hex bytes are authoritative here (raw UTF-8),
  // so they are decoded directly rather than round-tripped through the
  // escaped display text.
  const serviceRe = /"svce"<blob>=(?:"((?:[^"\\]|\\.)*)"|0x([0-9A-Fa-f]+)(?:\s+"(?:[^"\\]|\\.)*")?)/gsu
  for (const match of output.matchAll(serviceRe)) {
    const service = match[1] !== undefined
      ? unescapeSecurityDumpString(match[1])
      : Buffer.from(match[2], 'hex').toString('utf8')
    names.push(service)
  }
  return names
}

/**
 * Enumerates this plugin's own vault entries directly from the macOS
 * Keychain, rather than trusting only the non-secret vault-index.json that
 * lives under the same HOME a lost/reset profile can wipe (see the
 * "Non-secret vault index" comment above for the failure this closes).
 * Uses `security dump-keychain` -- METADATA ONLY, never the `-d` flag,
 * which would also decrypt and print the stored secret bytes -- and reads
 * only the `"svce"<blob>` (service name) attribute of each entry, filtered
 * to this plugin's own `1f3d9:<origin>:` service prefix; every other
 * attribute (including the account name and every timestamp) is ignored.
 *
 * Passes an explicit 64 MiB `maxBuffer` and a 10s `timeout` -- Node's
 * execFileSync default maxBuffer is 1 MiB, which a normal developer
 * keychain (a few thousand Safari/wifi/certificate/app-token items) can
 * exceed, throwing ENOBUFS. A bare `catch { return [] }` here cannot tell
 * that truncation apart from "no `security` binary on PATH", so it used to
 * silently answer "found nothing" on a keychain that is actually full of
 * entries -- re-opening exactly the fail-open this union was added to
 * close. ENOBUFS and a timeout kill (ETIMEDOUT, or `killed: true` with no
 * `code`) now throw KeychainEnumerationIncomplete instead, so the caller
 * can refuse rather than trust an incomplete read; every OTHER failure (no
 * such binary, a locked keychain, an unexpected output format) is still
 * treated as "found nothing", the same fail-open posture listVaultLabels
 * already documents for a missing setup-state.json or an empty cmdkey
 * scrape -- this enumeration is UNIONED with the vault index below, never
 * a replacement for it, so a caller is still protected by whichever source
 * actually has the answer.
 */
function darwinKeychainServiceLabels(execImpl, origin) {
  let output
  try {
    output = execImpl('security', ['dump-keychain'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    })
  } catch (error) {
    if (error?.code === 'ENOBUFS') {
      throw new KeychainEnumerationIncomplete(
        'security dump-keychain output exceeded the 64 MiB read limit -- the Keychain scan is incomplete, not empty',
      )
    }
    if (error?.code === 'ETIMEDOUT' || (error?.killed === true && !error?.code)) {
      throw new KeychainEnumerationIncomplete(
        'security dump-keychain did not finish within 10s -- the Keychain scan is incomplete, not empty',
      )
    }
    return []
  }
  const prefix = vaultTarget(origin, '')
  const labels = []
  for (const service of parseSecurityDumpKeychainServiceNames(output)) {
    if (service.startsWith(prefix)) labels.push(service.slice(prefix.length))
  }
  return labels
}

/**
 * Lists every label this host's vault currently holds for `origin`,
 * excluding staging labels -- never the exact-handle lookup readSecret
 * already does, but a genuine enumeration of "does anything else already
 * exist here", so setup.mjs's duplicate-identity guard can refuse a fresh
 * registration under a different handle instead of silently creating a
 * second, permanent, unrecoverable resident next to one that already
 * exists. An enumeration failure (no `cmdkey`/`security` on PATH, an
 * unreadable directory, a missing index) is treated as "found nothing",
 * the same fail-open behavior that guard already accepts for a missing
 * setup-state.json -- the guard exists to catch the common case (state
 * lost, vault intact), not to be a perfect audit. The one exception: on
 * darwin, a truncated or timed-out `security dump-keychain` scan (see
 * KeychainEnumerationIncomplete) is NOT "found nothing" -- this throws
 * KeychainEnumerationIncomplete rather than silently answering an
 * incomplete read as an empty one, and the caller must refuse rather than
 * treat that as "no other entry exists".
 *
 * The returned array also carries a non-enumerable `registrationStagingLabels`
 * property (see splitStagingLabels/withRegistrationStagingLabels above) --
 * the REGISTRATION-kind staging labels this call filtered out of the array
 * itself, never rotation or recovery ones. setup.mjs's duplicate-identity
 * guard reads that property (not the array) to refuse when an abandoned
 * registration staging entry means a resident may already be permanent
 * server-side; every other caller keeps seeing exactly the label array it
 * always has, with no staging label of any kind mixed in.
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
    const indexMap = vaultIndexEntriesToMap(Array.isArray(vaultIndex[origin]) ? vaultIndex[origin] : [])
    const labels = new Set([...fromCmdkey, ...indexMap.keys()])
    const { kept, registrationStaging } = splitStagingLabels(labels, indexMap)
    return withRegistrationStagingLabels(kept, registrationStaging)
  }
  if (os === 'darwin') {
    // Union the non-secret index with a real Keychain scan (see
    // darwinKeychainServiceLabels's own doc comment) -- never the index
    // alone, for the same reason win32 above never trusts a bare cmdkey
    // scrape alone: either source can independently go stale or missing.
    const fromKeychain = darwinKeychainServiceLabels(execImpl, origin)
    const index = readVaultIndex(deps.homeDir)
    const indexMap = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
    const labels = new Set([...fromKeychain, ...indexMap.keys()])
    const { kept, registrationStaging } = splitStagingLabels(labels, indexMap)
    return withRegistrationStagingLabels(kept, registrationStaging)
  }
  const dir = join(deps.homeDir ?? homedir(), '.1f3d9', 'credentials')
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const prefix = `${safeOrigin}__`
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return withRegistrationStagingLabels([], [])
  }
  const labels = entries
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => name.slice(prefix.length, -'.json'.length))
  // Same non-secret vault index the win32/darwin backends read above --
  // storeSecret/deleteSecret now maintain it for the file backend too, so
  // this enumeration stays label-only and never opens or parses a
  // credentials bundle just to answer "does this exist", matching the
  // "Non-secret vault index" comment's promise. A label this version never
  // indexed (a v1.5.0-era bundle predating this marker, or an index entry
  // lost to a crash) has no entry here and falls back to the
  // isPendingLabel suffix guess via isStagingLabel, same as win32/darwin.
  const index = readVaultIndex(deps.homeDir)
  const indexMap = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
  const { kept, registrationStaging } = splitStagingLabels(labels, indexMap)
  return withRegistrationStagingLabels(kept, registrationStaging)
}

export {
  storeSecret, readSecret, deleteSecret, listVaultLabels, SecretReadFailure,
  KeychainEnumerationIncomplete, parseSecurityDumpKeychainServiceNames,
}
