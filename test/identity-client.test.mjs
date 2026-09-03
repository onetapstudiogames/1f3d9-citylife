import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  deleteSecret,
  listVaultLabels,
  promoteReplacementKey,
  readSecret,
  SecretReadFailure,
  shouldReveal,
  storeSecret,
} from '../scripts/identity-client.mjs'
import { assertAllowedOrigin } from '../scripts/lib/origin-guard.mjs'
import { probeMe } from '../scripts/lib/identity-probe.mjs'
import { startRedirectingStubServer } from './helpers/stub-city-server.mjs'
import { runNode } from './helpers/run-identity-cli.mjs'

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
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'test-agent', '--client-class', 'hosted_browser', '--human-approved'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /client-class must be coding_persistent or coding_ephemeral/u)
})

test('register refuses to proceed without human approval on a non-interactive stdin', () => {
  const result = runCli(['register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'test-agent', '--client-class', 'coding_persistent'], '')
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

// --- Finding 8: AGENT_1F3D9_STUB_ONLY=1 refuses every non-loopback origin -
// (the guard that would have stopped the incident where a review agent ran
// these scripts against the real city by hand) -- including the real city
// itself, and including a value the caller confirmed with --allow-origin.

test('assertAllowedOrigin refuses the real city, https://1f3d9.com, when AGENT_1F3D9_STUB_ONLY=1 is set', () => {
  const previous = process.env.AGENT_1F3D9_STUB_ONLY
  process.env.AGENT_1F3D9_STUB_ONLY = '1'
  try {
    assert.throws(
      () => assertAllowedOrigin('https://1f3d9.com'),
      /AGENT_1F3D9_STUB_ONLY=1 is set/u,
      'the real city is refused even though it is ordinarily the allowed default origin',
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3D9_STUB_ONLY
    else process.env.AGENT_1F3D9_STUB_ONLY = previous
  }
})

test('assertAllowedOrigin refuses a foreign origin under AGENT_1F3D9_STUB_ONLY=1 even with a matching --allow-origin', () => {
  const previous = process.env.AGENT_1F3D9_STUB_ONLY
  process.env.AGENT_1F3D9_STUB_ONLY = '1'
  try {
    assert.throws(
      () => assertAllowedOrigin('https://evil.example', { allowOrigin: 'https://evil.example' }),
      /AGENT_1F3D9_STUB_ONLY=1 is set/u,
      '--allow-origin is not an escape hatch from this guardrail',
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3D9_STUB_ONLY
    else process.env.AGENT_1F3D9_STUB_ONLY = previous
  }
})

test('assertAllowedOrigin still allows localhost/127.0.0.1 when AGENT_1F3D9_STUB_ONLY=1 is set', () => {
  const previous = process.env.AGENT_1F3D9_STUB_ONLY
  process.env.AGENT_1F3D9_STUB_ONLY = '1'
  try {
    assert.equal(assertAllowedOrigin('https://localhost:4000'), 'https://localhost:4000')
    assert.equal(assertAllowedOrigin('https://127.0.0.1:4000'), 'https://127.0.0.1:4000')
  } finally {
    if (previous === undefined) delete process.env.AGENT_1F3D9_STUB_ONLY
    else process.env.AGENT_1F3D9_STUB_ONLY = previous
  }
})

test('setup.mjs refuses https://1f3d9.com before any network call when AGENT_1F3D9_STUB_ONLY=1 is set', async () => {
  const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
  const result = await runNode(setupPath, [
    '--origin', 'https://1f3d9.com', '--handle', 'should-never-register', '--client-class', 'coding_persistent',
  ], { env: { AGENT_1F3D9_STUB_ONLY: '1' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AGENT_1F3D9_STUB_ONLY=1 is set/u)
  assert.equal(result.stdout.trim(), '', 'nothing at all was printed before the guard refused')
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

// The prior version of this suite also carried a subprocess-driven "reveal"
// test pointed at https://example.invalid, which always died in
// fetchOrExplain before revealOrHide was ever reached -- it could not fail
// even with the reveal gate replaced by an unconditional print. Real
// coverage of "a secret never reaches captured stdout even with --reveal"
// now lives in shouldReveal above (the pure predicate) plus the
// stub-server-driven leak assertions in test/identity-commands.test.mjs
// (setup's second pass, key rotate, key recover generate), which actually
// exercise a real staged key and would go red if the gate broke.

// --- Redirects: never followed, even to another allowed-origin host -------
// (finding 7 / the redirect exfiltration primitive)

test('identity-client.mjs never follows a redirect from the (allowed) origin to another host', async () => {
  const { createServer } = await import('node:http')
  let attackerHit = false
  let attackerBody = null
  const attacker = createServer((req, res) => {
    attackerHit = true
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      attackerBody = data
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise(resolvePromise => attacker.listen(0, '127.0.0.1', resolvePromise))
  const attackerPort = attacker.address().port

  // https://localhost:<port> is allowed unconditionally (local development),
  // so no --allow-origin is needed to reach this stub -- exactly like a real
  // deployment pointed at the real city.
  const redirecting = await startRedirectingStubServer(`http://127.0.0.1:${attackerPort}/stolen`)
  try {
    // Must be runNode (async spawn), never spawnSync/runCli: this test's
    // stub HTTPS server runs in THIS process's own event loop, and a
    // synchronous child would block that loop -- starving the very server
    // the child is trying to reach -- exactly the pitfall runNode's own doc
    // comment in test/helpers/run-identity-cli.mjs describes.
    const result = await runNode(identityClientPath, [
      'register', '--origin', redirecting.origin,
      '--handle', 'test-agent', '--client-class', 'coding_persistent', '--human-approved',
    ])
    assert.notEqual(result.status, 0, 'register refuses rather than following the redirect')
    assert.equal(attackerHit, false, 'the redirect target never received any request at all')
    assert.equal(attackerBody, null)
    assert.doesNotMatch(result.stdout + result.stderr, /1f3d9_sk_|1f3d9_rc_/u, 'no secret literal anywhere in the CLI output either')
    assert.match(result.stderr, /redirect/iu, 'sanity: the failure is actually the redirect refusal (fetch\'s redirect: "error")')
  } finally {
    await redirecting.close()
    await new Promise(resolvePromise => attacker.close(resolvePromise))
  }
})

test('probeMe never follows a redirect from the origin to another host', async () => {
  const { createServer } = await import('node:http')
  let attackerHit = false
  const attacker = createServer((req, res) => {
    attackerHit = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolvePromise => attacker.listen(0, '127.0.0.1', resolvePromise))
  const attackerPort = attacker.address().port

  const redirecting = await startRedirectingStubServer(`http://127.0.0.1:${attackerPort}/stolen`)
  // probeMe runs in THIS process (unlike the subprocess test above), so the
  // self-signed fixture cert needs the same trust relaxation
  // test/helpers/run-identity-cli.mjs sets via env for subprocess callers --
  // set and restore it directly on this process so it never leaks into
  // other tests in this file.
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const probe = await probeMe(redirecting.origin, `1f3d9_sk_${'a'.repeat(48)}`)
    assert.equal(probe.ok, false, 'probeMe reports failure rather than following the redirect')
    // The definitive proof this is the redirect refusal (not, say, an
    // unrelated network hiccup): the redirect target genuinely never saw a
    // request. probe.error's exact text is not asserted here -- undici
    // reports a redirect-mode-error failure only as a bare "fetch failed" at
    // this level, with the real reason one level deeper in error.cause,
    // which probeMe's catch (unlike fetchOrExplain's) does not unwrap.
    assert.equal(attackerHit, false, 'the redirect target never received the bearer-authenticated request')
  } finally {
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
    await redirecting.close()
    await new Promise(resolvePromise => attacker.close(resolvePromise))
  }
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

test('promoteReplacementKey refuses to swallow a write failure after the server already confirmed the new key (finding 3)', () => {
  // Fully mocked via injected deps (execFileSync never runs a real `security`
  // binary), so this runs on every platform: the read side succeeds (a live
  // entry exists) and the write side fails (a locked keychain), exactly the
  // shape a caller must never see reported as a bare "could not write" with
  // no context -- by the time this function runs, the server already
  // confirmed the rotation/recovery, so the OLD key is already dead, and the
  // ONLY place the new one lives is the staging label.
  const origin = 'https://example.invalid'
  const handle = 'promote-write-fail'
  const stagingLabel = `${handle}--pending-rotation`
  const previousValue = { kind: 'resident', handle, client_class: 'coding_persistent', resident_key: 'old-key', origin }
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      return Buffer.from(JSON.stringify(previousValue), 'utf8').toString('base64')
    }
    if (command === 'security' && args[0] === '-i') {
      throw new Error('keychain is locked')
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // promoteReplacementKey now takes a per-(origin, handle) file lock (see
  // Finding 2 test block below) before ever calling readSecret/storeSecret,
  // so every call -- including this fully-mocked one -- needs a temp
  // homeDir or that lock file would land under the real ~/.1f3d9.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    assert.throws(
      () => promoteReplacementKey(origin, handle, stagingLabel, 'new-key', (previous) => ({
        ...(previous?.client_class ? { client_class: previous.client_class } : {}),
      }), deps),
      (error) => {
        assert.match(error.message, /old key.*no longer works/iu, 'names the old key as already dead')
        assert.match(
          error.message,
          new RegExp(stagingLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
          'names the staging label where the confirmed replacement key still lives',
        )
        assert.doesNotMatch(error.message, /new-key|old-key/u, 'never includes the raw key values')
        return true
      },
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Finding 2: register()'s overwrite guard is re-checked immediately ----
// before the final vault write, not only once before the stage/confirm
// network round trips -- closing the window where a concurrent run could
// create the same handle in between.

test('promoteReplacementKey with refuseIfPresent:true refuses to overwrite a live entry that now exists, and never touches the staging copy', () => {
  const origin = 'https://example.invalid'
  const handle = 'race-handle'
  const stagingLabel = `${handle}--pending-registration`
  const liveValue = { kind: 'resident', handle, client_class: 'coding_persistent', resident_key: 'won-the-race-key', origin }
  let storeCalled = false
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      return Buffer.from(JSON.stringify(liveValue), 'utf8').toString('base64')
    }
    if (command === 'security' && args[0] === '-i') {
      storeCalled = true
      throw new Error('this test must never reach a write attempt')
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // See the temp-homeDir comment on the write-failure test above -- same
  // reason: promoteReplacementKey's per-(origin, handle) lock file needs
  // somewhere that is not the real ~/.1f3d9.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    assert.throws(
      () => promoteReplacementKey(origin, handle, stagingLabel, 'new-confirmed-key', () => ({}), deps, { refuseIfPresent: true }),
      (error) => {
        assert.match(error.message, /now exists/u, 'names the race, not a generic write failure')
        assert.match(error.message, new RegExp(stagingLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), 'points at the staging label')
        assert.doesNotMatch(error.message, /won-the-race-key|new-confirmed-key/u, 'never includes a raw key value')
        return true
      },
    )
    assert.equal(storeCalled, false, 'the write is never even attempted once the live entry is found present')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey with refuseIfPresent:true still writes normally when nothing is there yet', () => {
  const origin = 'https://example.invalid'
  const handle = 'no-race-handle'
  const stagingLabel = `${handle}--pending-registration`
  const execFileSync = (command, args) => {
    if (command === 'security' && args[0] === 'find-generic-password') {
      throw new Error('not found') // readSecret treats a lookup failure as "not found"
    }
    if (command === 'security' && args[0] === '-i') {
      return '' // the write succeeds
    }
    throw new Error(`unexpected exec call in this test: ${command} ${args.join(' ')}`)
  }
  // A successful write here reaches storeSecret's darwin branch, which
  // also calls updateVaultIndex -- on top of the per-(origin, handle) lock
  // file every promoteReplacementKey call now takes (see the two tests
  // above), both need a temp homeDir or they would touch the real
  // ~/.1f3d9.
  const homeDir = mkdtempSync(join(tmpdir(), 'identity-client-promote-'))
  const deps = { execFileSync, platform: 'darwin', homeDir }

  try {
    const location = promoteReplacementKey(origin, handle, stagingLabel, 'brand-new-key', () => ({ client_class: 'coding_persistent' }), deps, { refuseIfPresent: true })
    assert.match(location, /macOS Keychain/u)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Finding 4: the non-secret vault index is now serialized with a -------
// short-retry, stale-aware lockfile, so two updates in close succession
// never clobber each other, and an abandoned lock is broken rather than
// honored forever.

test('storeSecret/listVaultLabels: an abandoned (stale) vault-index lock is broken rather than blocking the next update forever', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'identity-client-lock-'))
  try {
    const origin = 'https://example.invalid'
    const deps = { platform: 'win32', homeDir, execFileSync: () => {} } // no-op: never touches the real Windows Credential Manager
    const noop = { kind: 'resident', handle: 'agent-lock-a', client_class: 'coding_persistent', resident_key: 'k', origin }

    storeSecret(origin, 'agent-lock-a', noop, deps)
    assert.deepEqual(listVaultLabels(origin, deps), ['agent-lock-a'])

    // Simulate a process that acquired the vault-index lock and then died
    // before ever releasing it: create the lockfile directly and backdate
    // its mtime well past the staleness threshold.
    const lockDir = join(homeDir, '.1f3d9')
    mkdirSync(lockDir, { recursive: true })
    const lockPath = join(lockDir, 'vault-index.json.lock')
    writeFileSync(lockPath, '')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo)

    const startedAt = Date.now()
    storeSecret(origin, 'agent-lock-b', { ...noop, handle: 'agent-lock-b' }, deps)
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 3_000, `the stale lock was broken quickly (${elapsedMs}ms), not honored for the full wait budget`)

    const labels = listVaultLabels(origin, deps)
    assert.ok(labels.includes('agent-lock-a'), 'the entry from before the stale lock is still there')
    assert.ok(labels.includes('agent-lock-b'), 'the update behind the stale lock actually landed')

    deleteSecret(origin, 'agent-lock-a', deps)
    deleteSecret(origin, 'agent-lock-b', deps)
    assert.deepEqual(listVaultLabels(origin, deps), [])
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
})
