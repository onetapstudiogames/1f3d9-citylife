// Behavioral coverage for setup.mjs / connect.mjs / key.mjs beyond the
// file-exists / frontmatter checks in commands.test.mjs — driving them as
// real subprocesses against a stub city server (test/helpers/stub-city-server.mjs)
// and a throwaway per-test HOME/USERPROFILE, so the actual vault backend for
// this platform is exercised end to end: register, rotate, recover, adopt,
// and the honest two-pass human-approval gate.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
const connectPath = fileURLToPath(new URL('../scripts/connect.mjs', import.meta.url))
const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))

const NO_SECRET_LITERAL = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

// --- Findings 1-4: the printed MCP connector commands are correct ---------

test('connect.mjs prints a single-quoted, unexpanded Claude Code header targeting /mcp, and the real Codex flag', async () => {
  const result = await runNode(connectPath, ['--origin', 'https://example.invalid', '--handle', 'nobody'])
  const out = result.stdout
  assert.match(out, /claude mcp add --transport http 1f3d9 https:\/\/example\.invalid\/mcp \\/u, 'targets /mcp, not /mcp/connect')
  assert.doesNotMatch(out, /\/mcp\/connect\s*\\/u, 'the bearer-header (Claude Code) line never names /mcp/connect')
  assert.match(out, /--header 'Authorization: Bearer \$\{AGENT_1F3D9_SECRET\}'/u, 'header value is single-quoted and unexpanded')
  assert.doesNotMatch(out, /--header "Authorization: Bearer \$\{/u, 'header is never double-quoted (that is what let the shell expand it)')
  assert.match(out, /codex mcp add 1f3d9 --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3D9_SECRET/u)
  assert.doesNotMatch(out, /--bearer_token_env_var/u, 'never the underscored flag spelling the real Codex CLI rejects')
  assert.match(out, /AGENT_1F3D9_SECRET/u)
  assertNoSecretLeaked(result, 'connect.mjs')
})

test('setup.mjs prints the same corrected MCP connector command shape in its own connect step', async () => {
  // Reached via the "no existing identity, no handle/client-class given"
  // refusal path, which still prints nothing about the connector — so drive
  // this through the repair branch instead by seeding setup-state directly,
  // which is enough to reach printConnectStep() without any network call.
  const home = makeTempHome('setup-print-')
  try {
    const stateDir = `${home.dir}/.1f3d9`
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      `${stateDir}/setup-state.json`,
      JSON.stringify({ 'https://example.invalid': { handle: 'nobody', client_class: 'coding_persistent' } }),
    )
    const result = await runNode(setupPath, ['--origin', 'https://example.invalid'], { env: home.env })
    const out = result.stdout
    assert.match(out, /claude mcp add --transport http 1f3d9 https:\/\/example\.invalid\/mcp \\/u)
    assert.match(out, /--header 'Authorization: Bearer \$\{AGENT_1F3D9_SECRET\}'/u)
    assert.match(out, /codex mcp add 1f3d9 --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3D9_SECRET/u)
    assert.doesNotMatch(out, /--bearer_token_env_var/u)
    assertNoSecretLeaked(result, 'setup.mjs (repair branch)')
  } finally {
    home.cleanup()
  }
})

// --- End-to-end against a stub city server ---------------------------------

test('setup.mjs: honest two-pass human approval refuses on a non-interactive first run, then registers on the second', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-approve-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0, 'refuses without --human-approved on a non-interactive run')
    assert.match(firstPass.stderr, /put this exact question to the human/u)
    assert.match(firstPass.stderr, /"agent-one"/u)
    assert.match(firstPass.stderr, /register it now/iu)
    assert.match(firstPass.stderr, /decision row 74/u)
    assert.equal(stub.residents.size, 0, 'nothing was registered by the refused first pass')

    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved'],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.residents.size, 1, 'the second, approved pass actually registered')
    assert.ok(stub.residents.has('agent-one'))
    assertNoSecretLeaked(firstPass, 'setup.mjs first pass')
    assertNoSecretLeaked(secondPass, 'setup.mjs second pass')

    const stored = readSecret(stub.origin, 'agent-one', { homeDir: home.dir })
    assert.equal(stored.found, true)
    assert.equal(stored.value.resident_key, stub.residents.get('agent-one').resident_key)

    // Re-running with no flags at all reads the state file and repairs,
    // never registering a second identity.
    const repairPass = await runNode(setupPath, ['--origin', stub.origin], { env: home.env })
    assert.equal(repairPass.status, 0, repairPass.stderr)
    assert.equal(stub.residents.size, 1, 'a repair pass never creates a second resident')
    assertNoSecretLeaked(repairPass, 'setup.mjs repair pass')
  } finally {
    // On win32, storeSecret/readSecret always use the real Windows
    // Credential Manager regardless of `homeDir` -- it is not scoped to the
    // throwaway per-test home the way the plain-file backend is -- so this
    // test's CLI-driven `setup` registration must be cleaned up explicitly,
    // the same way test/vault-roundtrip-windows.test.mjs does for its own
    // fixture entries.
    deleteSecret(stub.origin, 'agent-one')
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs adopts an existing working vault entry instead of registering a duplicate (findings 7 & 13)', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-adopt-')
  try {
    // Simulate the stranding scenario: the city already has this resident
    // (confirm succeeded server-side) and the key is correctly vaulted, but
    // no setup-state.json was ever written (the response was lost).
    stub.residents.set('agent-two', { resident_key: `1f3d9_sk_${'c'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-two', {
      kind: 'resident',
      handle: 'agent-two',
      client_class: 'coding_persistent',
      resident_key: stub.residents.get('agent-two').resident_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /already exists/iu)
    assert.match(result.stdout, /[Aa]dopting it instead of registering a second one/u)
    assert.equal(stub.residents.size, 1, 'no second resident was registered')
    assertNoSecretLeaked(result, 'setup.mjs adopt')
  } finally {
    deleteSecret(stub.origin, 'agent-two')
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs: --new-identity bypasses adoption and attempts a real registration, which the city itself refuses as a duplicate handle', async () => {
  const stub = await startStubCityServer()
  // A fresh home with no setup-state.json at all -- this is the "vault entry
  // exists, but no repair state has ever been written" shape --new-identity
  // is actually meant to override (once a repair pass has run once, the
  // state file it writes takes over on every later run regardless of this
  // flag, which is exercised by the "adopts" test above).
  const home = makeTempHome('setup-new-identity-')
  try {
    stub.residents.set('agent-two-b', { resident_key: `1f3d9_sk_${'c'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-two-b', {
      kind: 'resident',
      handle: 'agent-two-b',
      client_class: 'coding_persistent',
      resident_key: stub.residents.get('agent-two-b').resident_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const forced = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two-b', '--client-class', 'coding_persistent', '--human-approved', '--new-identity'],
      { env: home.env },
    )
    assert.notEqual(forced.status, 0, '--new-identity still cannot create a real duplicate; the city itself refuses it')
    assert.match(forced.stdout + forced.stderr, /--new-identity was passed/u)
    assert.equal(stub.residents.size, 1, 'still exactly the one, pre-existing resident')
  } finally {
    deleteSecret(stub.origin, 'agent-two-b')
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs refuses to guess on a corrupt setup-state.json rather than silently registering a duplicate (finding 13)', async () => {
  const home = makeTempHome('setup-corrupt-')
  try {
    mkdirSync(`${home.dir}/.1f3d9`, { recursive: true })
    writeFileSync(`${home.dir}/.1f3d9/setup-state.json`, 'not valid json{{{')

    const result = await runNode(
      setupPath,
      ['--origin', 'https://example.invalid', '--handle', 'agent-three', '--client-class', 'coding_persistent', '--human-approved'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /could not be parsed as JSON/u)
    assert.match(result.stderr, /refusing to guess/u)
  } finally {
    home.cleanup()
  }
})

test('key rotate invalidates recovery codes instead of carrying them forward, and tells the agent to regenerate (finding 6)', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-rotate-')
  try {
    const originalKey = `1f3d9_sk_${'d'.repeat(48)}`
    const originalCodes = Array.from({ length: 8 }, (_unused, i) => `1f3d9_rc_${i.toString().padStart(2, '0')}${'e'.repeat(62)}`)
    stub.residents.set('agent-four', { resident_key: originalKey, recovery_codes: originalCodes, client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-four', {
      kind: 'resident', handle: 'agent-four', client_class: 'coding_persistent',
      resident_key: originalKey, recovery_codes: originalCodes, origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['rotate', '--origin', stub.origin, '--handle', 'agent-four'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /recovery codes were invalidated by this rotation/u)
    assert.match(result.stdout, /key recover generate/u)
    assertNoSecretLeaked(result, 'key rotate')

    const stored = readSecret(stub.origin, 'agent-four', { homeDir: home.dir })
    assert.equal(stored.found, true)
    assert.notEqual(stored.value.resident_key, originalKey, 'the live entry now holds the rotated key')
    assert.ok(!Array.isArray(stored.value.recovery_codes) || stored.value.recovery_codes.length === 0,
      'the stale pre-rotation codes are not carried forward')
    assert.equal(typeof stored.value.recovery_codes_invalidated_at, 'string',
      'the vault entry is marked so `key show` can refuse to print stale codes')
  } finally {
    deleteSecret(stub.origin, 'agent-four')
    home.cleanup()
    await stub.close()
  }
})

test('key recover generate writes the fresh codes into the live vault entry, not a sibling label (finding 6)', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-recover-gen-')
  try {
    const residentKey = `1f3d9_sk_${'f'.repeat(48)}`
    stub.residents.set('agent-five', { resident_key: residentKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-five', {
      kind: 'resident', handle: 'agent-five', client_class: 'coding_persistent',
      resident_key: residentKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['recover', 'generate', '--origin', stub.origin, '--handle', 'agent-five'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assertNoSecretLeaked(result, 'key recover generate')

    const live = readSecret(stub.origin, 'agent-five', { homeDir: home.dir })
    assert.equal(live.found, true)
    assert.equal(live.value.recovery_codes.length, 8, 'the live entry holds the fresh set of eight codes')
    assert.equal(live.value.client_class, 'coding_persistent', 'client_class survives the merge')

    const sibling = readSecret(stub.origin, 'agent-five-recovery', { homeDir: home.dir })
    assert.equal(sibling.found, false, 'no separate sibling-label entry is left behind')
  } finally {
    deleteSecret(stub.origin, 'agent-five')
    deleteSecret(stub.origin, 'agent-five-recovery')
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 11: --reveal is refused through a piped wrapper, not dropped -

test('key rotate/recover generate refuse --reveal outright when stdout is not a TTY, instead of silently dropping it', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-reveal-refuse-')
  try {
    const residentKey = `1f3d9_sk_${'1'.repeat(48)}`
    stub.residents.set('agent-six', { resident_key: residentKey, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-six', {
      kind: 'resident', handle: 'agent-six', client_class: 'coding_persistent',
      resident_key: residentKey, recovery_codes: [], origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const rotateResult = await runNode(keyPath, ['rotate', '--origin', stub.origin, '--handle', 'agent-six', '--reveal'], { env: home.env })
    assert.notEqual(rotateResult.status, 0)
    assert.match(rotateResult.stderr, /--reveal cannot work through this wrapper/u)
    assert.match(rotateResult.stderr, /identity-client\.mjs directly at an interactive terminal/u)
    // The refusal must happen before any network call: the stub never sees
    // a rotated key for this resident.
    assert.equal(stub.residents.get('agent-six').resident_key, residentKey)

    const recoverResult = await runNode(keyPath, ['recover', 'generate', '--origin', stub.origin, '--handle', 'agent-six', '--reveal'], { env: home.env })
    assert.notEqual(recoverResult.status, 0)
    assert.match(recoverResult.stderr, /--reveal cannot work through this wrapper/u)
  } finally {
    deleteSecret(stub.origin, 'agent-six')
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs refuses --reveal outright when stdout is not a TTY, instead of silently dropping it', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-reveal-refuse-')
  try {
    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-seven', '--client-class', 'coding_persistent', '--human-approved', '--reveal'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--reveal cannot work through this wrapper/u)
    assert.equal(stub.residents.size, 0, 'registration never proceeded once --reveal was refused')
  } finally {
    home.cleanup()
    await stub.close()
  }
})
