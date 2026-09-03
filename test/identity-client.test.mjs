import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  promoteReplacementKey,
  readSecret,
  SecretReadFailure,
  shouldReveal,
  storeSecret,
} from '../scripts/identity-client.mjs'
import { assertAllowedOrigin } from '../scripts/lib/origin-guard.mjs'

const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

const runCli = (args, input) => spawnSync(process.execPath, [identityClientPath, ...args], {
  encoding: 'utf8',
  input,
  stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
})

// --- Refusals: every one of these must fail before any network call -------

test('rotate refuses a bare --resident-key flag', () => {
  const result = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--resident-key', '1f3d9_sk_' + 'a'.repeat(48)])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refused as a bare flag/u)
  assert.match(result.stderr, /--resident-key-file/u)
})

test('recover begin refuses a bare --recovery-code flag', () => {
  const result = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--recovery-code', '1f3d9_rc_' + 'b'.repeat(64)])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /refused as a bare flag/u)
  assert.match(result.stderr, /--recovery-code-file/u)
})

test('register refuses an invalid client_class before any network call', () => {
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'x', '--client-class', 'hosted_browser', '--human-approved'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /client-class must be coding_persistent or coding_ephemeral/u)
})

test('register refuses to proceed without human approval on a non-interactive stdin', () => {
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'x', '--client-class', 'coding_persistent'], '')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /needs human approval/u)
})

test('rotate refuses a malformed resident key shape before any network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-client-'))
  try {
    const keyFile = join(dir, 'key.txt')
    await writeFile(keyFile, 'not-a-real-key\n')
    const result = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--resident-key-file', keyFile])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must point to the current, valid resident key/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recover begin refuses a malformed recovery code shape before any network call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-client-'))
  try {
    const codeFile = join(dir, 'code.txt')
    await writeFile(codeFile, 'not-a-real-code\n')
    const result = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--recovery-code-file', codeFile])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must point to a valid, unused recovery code/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown command refuses with a usage line', () => {
  const result = runCli(['bogus'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /usage: identity-client\.mjs/u)
})

test('the --name=value form of a bare secret flag is refused exactly like the space form', () => {
  // parseArgs must split "--resident-key=VALUE" into flags['resident-key'],
  // not a literal flag named "resident-key=1f3d9_sk_..." -- otherwise the
  // bare-flag refusal below never fires and the key sits in argv/history
  // with a misleading, unrelated error instead.
  const equalsForm = runCli(['rotate', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', `--resident-key=1f3d9_sk_${'a'.repeat(48)}`])
  assert.notEqual(equalsForm.status, 0)
  assert.match(equalsForm.stderr, /refused as a bare flag/u)
  assert.match(equalsForm.stderr, /--resident-key-file/u)
  assert.match(equalsForm.stderr, /treat that value as exposed now and rotate it/u)

  const equalsRecoveryForm = runCli(['recover', 'begin', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', `--recovery-code=1f3d9_rc_${'b'.repeat(64)}`])
  assert.notEqual(equalsRecoveryForm.status, 0)
  assert.match(equalsRecoveryForm.stderr, /refused as a bare flag/u)
  assert.match(equalsRecoveryForm.stderr, /--recovery-code-file/u)
})

// --- Origin allowlist: only the real city or an explicit, matching opt-in -

test('assertAllowedOrigin refuses plain http, even for localhost', () => {
  assert.throws(() => assertAllowedOrigin('http://1f3d9.com'), /only https is allowed/u)
  assert.throws(() => assertAllowedOrigin('http://localhost:3000'), /only https is allowed/u)
})

test('assertAllowedOrigin refuses a foreign https origin without a matching --allow-origin', () => {
  assert.throws(
    () => assertAllowedOrigin('https://evil.example'),
    /refusing to send a resident key to "https:\/\/evil\.example"/u,
  )
  assert.throws(
    () => assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://other.example' }),
    /refusing to send a resident key/u,
  )
})

test('assertAllowedOrigin allows the real city, https://localhost, and an exactly-matching --allow-origin', () => {
  assert.equal(assertAllowedOrigin('https://1f3d9.com'), 'https://1f3d9.com')
  assert.equal(assertAllowedOrigin('https://localhost:4000'), 'https://localhost:4000')
  assert.equal(assertAllowedOrigin('https://127.0.0.1:4000'), 'https://127.0.0.1:4000')
  assert.equal(
    assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://evil.example' }),
    'https://evil.example',
  )
})

test('every printed env-var name in the identity-client usage comment is a legal shell identifier', async () => {
  const source = await (await import('node:fs/promises')).readFile(identityClientPath, 'utf8')
  const envVarNames = [...source.matchAll(/\b([A-Z][A-Z0-9_]*_[A-Z0-9_]*SECRET|[A-Z][A-Z0-9_]*RESIDENT_KEY)\b/gu)]
    .map((match) => match[1])
  assert.ok(envVarNames.length > 0, 'sanity: found at least one candidate env-var name to check')
  for (const name of envVarNames) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/u, `${name} is a legal POSIX shell identifier`)
  }
})

// --- Reveal gating: a secret never reaches a captured (non-TTY) stdout ----

test('shouldReveal is true only when --reveal was passed AND stdout is a real TTY', () => {
  // This is the pure predicate revealOrHide is built on. It is tested
  // directly, in addition to (not instead of) the subprocess test below,
  // because a subprocess's own stdout can never be a real TTY either way --
  // asserting only through a spawned child can prove secrets stay hidden
  // when captured, but can never prove the reveal branch itself is wired up
  // correctly, or fail if it silently stopped being called at all.
  assert.equal(shouldReveal({ reveal: true }, true), true)
  assert.equal(shouldReveal({ reveal: true }, false), false)
  assert.equal(shouldReveal({ reveal: true }, undefined), false)
  assert.equal(shouldReveal({}, true), false)
  assert.equal(shouldReveal({ reveal: false }, true), false)
})

test('a captured (piped) run never prints resident_key or recovery_codes even with --reveal', () => {
  // We cannot force process.stdout.isTTY true from a spawned child whose
  // stdout is a pipe, which is exactly the point: this asserts that a
  // pipe/capture context (a subprocess, a log file, a CI runner) can never
  // exfiltrate a secret through --reveal, only an interactive terminal can.
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'x', '--client-class', 'coding_persistent', '--human-approved', '--reveal'])
  assert.doesNotMatch(result.stdout, /1f3d9_sk_/u)
  assert.doesNotMatch(result.stdout, /1f3d9_rc_/u)
})

// --- Vault round trip against the temp-file backend -----------------------
// The temp-file backend is the fallback used on any platform that is
// neither win32 nor darwin (see storeSecret/readSecret in
// identity-client.mjs); it depends on real POSIX permission-bit semantics
// (chmodSync narrowing an existing file, statSync reporting the narrowed
// mode) that NTFS does not provide. On a real Linux runner (this repo's own
// CI: ubuntu-latest) storeSecret narrows the file to mode 600 and this round
// trip passes; on a Windows dev machine, forcing the file backend still
// writes through real fs calls against NTFS, which cannot represent group/
// other permission bits the way POSIX can, so the safety check that refuses
// an over-open file is untestable here. This suite skips itself on win32
// rather than assert something NTFS cannot honor either way.
const posixFileBackend = process.platform !== 'win32'

test('vault round trip against the temp-file backend: store then read returns exactly what was written', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits; run on Linux/macOS or in this repo\'s CI' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const payload = {
      kind: 'resident',
      handle: 'roundtrip-tester',
      client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'a'.repeat(48)}`,
      recovery_codes: Array.from({ length: 8 }, (_unused, index) => `1f3d9_rc_${index.toString().padStart(2, '0')}${'b'.repeat(62)}`),
      origin: 'https://example.invalid',
      stored_at: new Date().toISOString(),
    }
    const deps = { platform: 'linux', homeDir }

    const location = storeSecret('https://example.invalid', 'roundtrip-tester', payload, deps)
    assert.match(location, /local file .*mode 600\)/u)

    const read = readSecret('https://example.invalid', 'roundtrip-tester', deps)
    assert.equal(read.found, true)
    assert.deepEqual(read.value, payload)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('vault round trip: reading a label that was never stored reports found:false, not an error', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const read = readSecret('https://example.invalid', 'never-stored', { platform: 'linux', homeDir })
    assert.deepEqual(read, { found: false, value: null })
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('vault round trip: a corrupted stored entry throws SecretReadFailure, never a silent empty read', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const deps = { platform: 'linux', homeDir }
    storeSecret('https://example.invalid', 'corrupt-me', { resident_key: 'x' }, deps)
    // identity-client.mjs does not export its internal path builder, so we
    // reconstruct the same deterministic path it documents (safeOrigin,
    // safeLabel) to corrupt the file it just wrote, exercising the decode
    // failure path exactly as a real corrupted vault entry would.
    const safeOrigin = 'https://example.invalid'.replace(/[^a-z0-9.-]/giu, '_')
    const safeLabel = 'corrupt-me'.replace(/[^a-z0-9._-]/giu, '_')
    const filePath = join(homeDir, '.1f3d9', 'credentials', `${safeOrigin}__${safeLabel}.json`)
    writeFileSync(filePath, 'not valid json{{{', { mode: 0o600 })

    assert.throws(() => readSecret('https://example.invalid', 'corrupt-me', deps), SecretReadFailure)
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey merges forward client_class and recovery_codes from the live entry', { skip: !posixFileBackend && 'temp-file backend depends on POSIX permission bits' }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-vault-'))
  try {
    const origin = 'https://example.invalid'
    const deps = { platform: 'linux', homeDir }
    storeSecret(origin, 'promote-me', {
      kind: 'resident',
      handle: 'promote-me',
      client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'0'.repeat(48)}`,
      recovery_codes: [`1f3d9_rc_${'1'.repeat(64)}`],
      origin,
    }, deps)

    const stagingLabel = 'promote-me--pending-rotation'
    storeSecret(origin, stagingLabel, {
      kind: 'resident',
      handle: 'promote-me',
      resident_key: `1f3d9_sk_${'2'.repeat(48)}`,
      origin,
    }, deps)

    const location = promoteReplacementKey(origin, 'promote-me', stagingLabel, `1f3d9_sk_${'2'.repeat(48)}`, (previous) => ({
      ...(previous?.client_class ? { client_class: previous.client_class } : {}),
      ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
    }), deps)
    assert.match(location, /local file/u)

    const promoted = readSecret(origin, 'promote-me', deps)
    assert.equal(promoted.found, true)
    assert.equal(promoted.value.resident_key, `1f3d9_sk_${'2'.repeat(48)}`)
    assert.equal(promoted.value.client_class, 'coding_persistent')
    assert.deepEqual(promoted.value.recovery_codes, [`1f3d9_rc_${'1'.repeat(64)}`])

    const staging = readSecret(origin, stagingLabel, deps)
    assert.equal(staging.found, false, 'the staging copy is deleted once promotion succeeds')
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})
