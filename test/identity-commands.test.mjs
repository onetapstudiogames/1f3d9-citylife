// Behavioral coverage for setup.mjs / connect.mjs / key.mjs beyond the
// file-exists / frontmatter checks in commands.test.mjs — driving them as
// real subprocesses against a stub city server (test/helpers/stub-city-server.mjs)
// and a throwaway per-test HOME/USERPROFILE, so the actual vault backend for
// this platform is exercised end to end: register, rotate, recover, adopt,
// and the honest two-pass human-approval gate.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

/** Extracts the token setup.mjs's refusal prints for the required second pass. */
function extractApprovalToken(stderr) {
  return /--human-approved ([0-9a-f]{32})/u.exec(stderr)?.[1] ?? null
}

const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
const connectPath = fileURLToPath(new URL('../scripts/connect.mjs', import.meta.url))
const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

const NO_SECRET_LITERAL = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

// runNode sets AGENT_1F3D9_STUB_ONLY=1 by default (see run-identity-cli.mjs)
// so a test driving these scripts can never reach the real city. The
// handful of tests below that deliberately drive a script against
// https://example.invalid instead of a real stub server -- to exercise flag
// parsing, printed output shape, or refusal wording unrelated to the origin
// guard itself -- override it back to '0' with this constant. That origin
// is reserved by RFC 2606 and can never resolve to anything, real city
// included, so the stricter guard is not needed there and would only mask
// the behavior actually under test.
const NOT_A_REAL_ORIGIN_ENV = { AGENT_1F3D9_STUB_ONLY: '0' }

function assertNoSecretLeaked(result, label) {
  assert.doesNotMatch(result.stdout ?? '', NO_SECRET_LITERAL, `${label}: stdout never carries a raw secret`)
  assert.doesNotMatch(result.stderr ?? '', NO_SECRET_LITERAL, `${label}: stderr never carries a raw secret`)
}

/**
 * Enumerates every RAW label this platform's vault backend currently holds
 * for `origin` under `homeDir` -- unlike identity-client.mjs's own exported
 * listVaultLabels, this never filters out staging entries. A test that wants
 * to assert "no staging copy was left behind, whatever it would have been
 * named" must not check that through listVaultLabels: that function's whole
 * job is to hide staging labels, so it would report an empty result whether
 * or not one actually leaked, making such an assertion vacuous regardless of
 * label format. This reads the same on-disk/index shapes storeSecret and
 * deleteSecret in identity-client.mjs maintain (vault-index.json on win32/
 * darwin, the credentials directory listing everywhere else).
 */
function listRawVaultLabels(origin, homeDir) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(homeDir, '.1f3d9', 'vault-index.json'), 'utf8'))
    } catch {
      parsed = {}
    }
    const entries = Array.isArray(parsed?.[origin]) ? parsed[origin] : []
    const fromIndex = entries
      .map(entry => (typeof entry === 'string' ? entry : entry?.label))
      .filter(label => typeof label === 'string')
    if (process.platform !== 'win32') return fromIndex
    // storeSecret's updateVaultIndex is explicitly best-effort (identity-
    // client.mjs) and deleteSecret on the file backend never touches the
    // index at all, so a credential that reached Windows Credential Manager
    // while its index write failed would be invisible to the index alone --
    // union it with a real `cmdkey /list` scrape, mirroring listVaultLabels'
    // own win32 union in identity-client.mjs, so this assertion covers the
    // store the credential actually lives in.
    const prefix = `1f3d9:${origin}:`
    const fromCmdkey = []
    try {
      const output = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
      for (const match of output.matchAll(/Target:\s*(.+)\s*$/gmu)) {
        const target = match[1].trim()
        const index = target.indexOf(prefix)
        if (index !== -1) fromCmdkey.push(target.slice(index + prefix.length))
      }
    } catch {
      // cmdkey unavailable or failed -- fall back to the index alone.
    }
    return [...new Set([...fromIndex, ...fromCmdkey])]
  }
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const dir = join(homeDir, '.1f3d9', 'credentials')
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
}

// --- register() vault safety: never silently overwrite an existing entry -

test('register refuses to overwrite an existing vault entry under the confirmed handle, and cleans up the staging copy', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('register-collision-')
  try {
    storeSecret(stub.origin, 'agent-collide', {
      kind: 'resident', handle: 'agent-collide', client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'z'.repeat(48)}`, recovery_codes: [], origin: stub.origin,
    }, { homeDir: home.dir })

    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'agent-collide',
      '--client-class', 'coding_persistent', '--human-approved',
    ], { env: home.env })
    assert.notEqual(result.status, 0, 'refuses over an existing vault entry')
    assert.match(result.stderr, /refusing to register over the vault entry/u)
    assert.match(result.stderr, /--replace-vault-entry/u)
    assert.equal(stub.residents.size, 0, 'the city never confirmed a duplicate resident')
    assertNoSecretLeaked(result, 'register vault collision')

    const stillThere = readSecret(stub.origin, 'agent-collide', { homeDir: home.dir })
    assert.equal(stillThere.value.resident_key, `1f3d9_sk_${'z'.repeat(48)}`, 'the original entry is untouched')

    // register()'s pre-flight collision check throws BEFORE the staging
    // label is even computed, so no staging entry is ever written on this
    // path -- and since pendingLabel mints a random hex suffix for every
    // registration attempt, checking one fixed bare label (as this used to)
    // would never actually detect a leak. Enumerate the RAW vault contents
    // (never filtered through listVaultLabels, which hides staging entries
    // by design) instead, so this keeps meaning something if a future
    // change ever did leave a suffixed staging copy orphaned here.
    const rawLabels = listRawVaultLabels(stub.origin, home.dir)
    const stagingLabelPattern = /^agent-collide--pending-registration(-[0-9a-f]+)?$/u
    assert.ok(
      rawLabels.every(label => !stagingLabelPattern.test(label)),
      `no staging copy (bare or suffixed) was left behind for this collision path; found: ${JSON.stringify(rawLabels)}`,
    )
  } finally {
    deleteSecret(stub.origin, 'agent-collide', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-collide--pending-registration', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('register --replace-vault-entry deliberately overwrites an existing entry', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('register-replace-')
  try {
    storeSecret(stub.origin, 'agent-replace', {
      kind: 'resident', handle: 'agent-replace', client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'y'.repeat(48)}`, recovery_codes: [], origin: stub.origin,
    }, { homeDir: home.dir })

    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'agent-replace',
      '--client-class', 'coding_persistent', '--human-approved', '--replace-vault-entry',
    ], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    const now = readSecret(stub.origin, 'agent-replace', { homeDir: home.dir })
    assert.notEqual(now.value.resident_key, `1f3d9_sk_${'y'.repeat(48)}`, 'the old key was deliberately replaced')
    assertNoSecretLeaked(result, 'register --replace-vault-entry')
  } finally {
    deleteSecret(stub.origin, 'agent-replace', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- register()'s per-run staging label: two concurrent runs for the SAME
// handle must never share one staging label, or the winner's own cleanup
// would delete whatever the loser had just staged there (review finding
// "two concurrent register runs share one staging label").

test('two concurrent register runs for the same handle: the winner promotes, the loser refuses and still names its own untouched staging copy', { timeout: 20_000 }, async () => {
  // registerConfirmBarrier forces the actual overlap this test needs
  // instead of hoping two subprocess spawns happen to collide. Without it,
  // this was genuinely flaky: confirm is register()'s FIRST network call
  // AFTER its own local pre-flight vault check runs (see register()'s own
  // comment in identity-client.mjs), and that pre-flight check plus the
  // rest of a run's local vault work is fast enough -- especially on
  // POSIX, where it is a plain synchronous file read/write, no subprocess
  // spawn -- that a loaded CI runner could let one real subprocess finish
  // its ENTIRE run (stage, pre-flight, stage-write, confirm, promote,
  // live-vault write) before the other had even gotten its own stage()
  // response back. When that happened, the loser's pre-flight check (which
  // runs long before the race-decided path this test actually exercises,
  // promoteReplacementKey's locked refuseIfPresent re-check) was the one
  // that caught the now-existing handle instead, and failed this test's
  // assertions below on wording they never intended to cover ("... vault
  // entry that already exists for ..." instead of "... that now exists
  // ...") -- reproduced from a real ubuntu-latest CI failure log, not
  // theorized. Holding every 'confirm' for this handle until both are
  // outstanding guarantees, structurally, that neither subprocess's
  // pre-flight check can be racing against an already-finished other run:
  // by the time a confirm request reaches the server at all, that
  // process's own pre-flight check has already happened. What remains
  // racy -- and is exactly what this test means to cover -- is the two
  // real subprocesses' concurrent trip through promoteReplacementKey's
  // per-handle file lock immediately after both confirms release together.
  const stub = await startStubCityServer({
    registerConfirmBarrier: { handle: 'race-probe-handle', count: 2 },
  })
  const home = makeTempHome('register-race-')
  try {
    const args = [
      'register', '--origin', stub.origin, '--handle', 'race-probe-handle',
      '--client-class', 'coding_persistent', '--human-approved',
    ]
    // Two real, concurrent subprocesses racing the same requested handle
    // against the same stub server and the same shared vault home -- the
    // actual shape of the finding, not a mocked stand-in for it. The
    // barrier above is what makes the overlap deterministic; these are
    // still real, separate `node` processes actually racing each other
    // through the client's real vault-locking code once it releases them.
    const [first, second] = await Promise.all([
      runNode(identityClientPath, args, { env: home.env }),
      runNode(identityClientPath, args, { env: home.env }),
    ])

    const winner = first.status === 0 ? first : second
    const loser = first.status === 0 ? second : first
    assert.equal(winner.status, 0, `exactly one run must succeed (stderr: ${first.stderr}\n---\n${second.stderr})`)
    assert.notEqual(loser.status, 0, 'the other run must refuse rather than silently overwrite')
    assert.match(loser.stderr, /now exists/u, 'names the race, not a generic failure')

    const stagingLabelMatch = /staging label "([^"]+)"/u.exec(loser.stderr)
    assert.ok(stagingLabelMatch, `the refusal names the loser's own staging label (stderr: ${loser.stderr})`)
    const [, stagingLabel] = stagingLabelMatch
    assert.match(
      stagingLabel,
      /^race-probe-handle--pending-registration-[0-9a-f]+$/u,
      'the staging label is the per-run suffixed form, not the bare (shareable) one',
    )

    const staging = readSecret(stub.origin, stagingLabel, { homeDir: home.dir })
    assert.equal(staging.found, true, "the loser's own staging copy is still there -- the winner's cleanup never touched it")
    assert.equal(staging.value.handle, 'race-probe-handle')
    assert.ok(staging.value.resident_key, 'the confirmed replacement key is actually recoverable from the named label')

    assertNoSecretLeaked(winner, 'register race winner')
    assertNoSecretLeaked(loser, 'register race loser')

    deleteSecret(stub.origin, stagingLabel, { homeDir: home.dir })
  } finally {
    deleteSecret(stub.origin, 'race-probe-handle', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('register refuses a handle that does not match the city\'s handle rule, before any network call', async () => {
  const result = await runNode(identityClientPath, [
    'register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'AB', '--client-class', 'coding_persistent', '--human-approved',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the city's handle rule/u)
})

// --- The "--pending-" namespace is reserved: HANDLE_RE alone would accept -
// a handle like "agent--pending-rotation" (23 chars, lowercase letters and
// hyphens), which would then read to isPendingLabel's suffix guess as an
// abandoned staging entry rather than a real resident. register() must
// refuse it outright, before any network call, rather than let a real
// resident register under a handle its own vault machinery cannot
// distinguish from staging.

test('register refuses a handle containing the reserved "--pending-" sequence, before any network call', async () => {
  const result = await runNode(identityClientPath, [
    'register', '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'agent--pending-rotation', '--client-class', 'coding_persistent', '--human-approved',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /reserves.*--pending-|--pending-.*reserves/u)
})

test('setup.mjs refuses a handle that does not match the city\'s handle rule before ever asking for approval', async () => {
  const result = await runNode(setupPath, [
    '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'AB', '--client-class', 'coding_persistent',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the city's handle rule/u)
  assert.doesNotMatch(result.stderr, /put this exact question to the human/u, 'never reaches the approval gate')
})

// Same reservation as register()'s own check (see the "reserved '--pending-'
// sequence" test above) but on setup.mjs's own local pre-approval check --
// without this, HANDLE_RE alone would let such a handle reach the
// human-approval question, only for the second pass to fail once
// register() itself refuses it.
test('setup.mjs refuses a handle containing the reserved "--pending-" sequence before ever asking for approval', async () => {
  const result = await runNode(setupPath, [
    '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    '--handle', 'agent--pending-rotation', '--client-class', 'coding_persistent',
  ], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /reserves.*--pending-|--pending-.*reserves/u)
  assert.doesNotMatch(result.stderr, /put this exact question to the human/u, 'never reaches the approval gate')
})

// --- The `--flag=value` equals form works identically to the space form ---

test('setup.mjs accepts --human-approved=<token> in equals form, not just the space form', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-equals-token-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-equals', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the first pass prints a token')

    // The equals form, exactly as a caller who read the printed command
    // literally would paste it -- this used to be silently swallowed by
    // parseArgs (flags['human-approved=<token>'] instead of
    // flags['human-approved']), reaching the mint-a-new-nonce branch instead
    // of ever comparing the supplied token.
    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-equals', '--client-class', 'coding_persistent', `--human-approved=${token}`],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.residents.size, 1, 'the equals-form token actually registered')
    assertNoSecretLeaked(secondPass, 'setup.mjs equals-form token')
  } finally {
    deleteSecret(stub.origin, 'agent-equals', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('connect.mjs and key.mjs accept --handle=<value> in equals form, not just the space form', async () => {
  const connectResult = await runNode(connectPath, ['--origin=https://example.invalid', '--allow-origin=https://example.invalid', '--handle=agent-equals-connect'], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.match(connectResult.stdout, /agent-equals-connect/u, 'connect.mjs actually used the equals-form --handle, not a fallback')

  const keyResult = await runNode(keyPath, ['status', '--origin=https://example.invalid', '--allow-origin=https://example.invalid', '--handle=agent-equals-key'], { env: NOT_A_REAL_ORIGIN_ENV })
  assert.match(keyResult.stderr, /agent-equals-key/u, 'key.mjs actually used the equals-form --handle, not a fallback')
})

// --- Findings 1-4: the printed MCP connector commands are correct ---------

test('connect.mjs prints a single-quoted, unexpanded Claude Code header targeting /mcp on one line (PowerShell-safe), under a distinct server name, and the real Codex flag', async () => {
  const result = await runNode(connectPath, ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'nobody'], { env: NOT_A_REAL_ORIGIN_ENV })
  const out = result.stdout
  const claudeLine = out.split(/\r?\n/u).find(line => line.trimStart().startsWith('claude mcp add'))
  assert.ok(claudeLine, 'the Claude Code command line is present')
  assert.match(
    claudeLine,
    /^\s*claude mcp add --transport http 1f3d9-key https:\/\/example\.invalid\/mcp --header 'Authorization: Bearer \$\{AGENT_1F3D9_SECRET\}'\s*$/u,
    'the whole command fits on one line -- a POSIX `\\` continuation is a hard parse error in PowerShell',
  )
  assert.doesNotMatch(claudeLine, /\\\s*$/u, 'the line never ends with a line-continuation backslash')
  assert.doesNotMatch(out, /\/mcp\/connect/u, 'the bearer-header (Claude Code) line never names /mcp/connect')
  assert.doesNotMatch(out, /--header "Authorization: Bearer \$\{/u, 'header is never double-quoted (that is what let the shell expand it)')
  assert.match(out, /codex mcp add 1f3d9-key --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3D9_SECRET/u)
  assert.doesNotMatch(out, /--bearer_token_env_var/u, 'never the underscored flag spelling the real Codex CLI rejects')
  // The bundled .mcp.json server is separately named "1f3d9" (hosted-chat
  // browser sign-in) -- the printed commands above must never collide with
  // it under the same server name.
  assert.match(out, /bundles?[\s\S]{0,80}`?1f3d9`?/iu, 'names the distinction from the bundled `1f3d9` connector')
  assertNoSecretLeaked(result, 'connect.mjs')
})

test('connect.mjs refuses a disallowed http origin before printing any MCP command, and exits non-zero (finding 2)', async () => {
  const result = await runNode(connectPath, ['--origin', 'http://attacker.example', '--handle', 'victim-agent'])
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /mcp add/u, 'no connector command line was ever printed')
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'connect.mjs disallowed origin')
})

test('setup.mjs prints the same corrected MCP connector command shape, on one line, in its own connect step', async () => {
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
    const result = await runNode(setupPath, ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid'], { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } })
    const out = result.stdout
    const claudeLine = out.split(/\r?\n/u).find(line => line.trimStart().startsWith('claude mcp add'))
    assert.ok(claudeLine, 'the Claude Code command line is present')
    assert.match(
      claudeLine,
      /^\s*claude mcp add --transport http 1f3d9-key https:\/\/example\.invalid\/mcp --header 'Authorization: Bearer \$\{AGENT_1F3D9_SECRET\}'\s*$/u,
    )
    assert.doesNotMatch(claudeLine, /\\\s*$/u, 'the line never ends with a line-continuation backslash')
    assert.match(out, /codex mcp add 1f3d9-key --url https:\/\/example\.invalid\/mcp --bearer-token-env-var AGENT_1F3D9_SECRET/u)
    assert.doesNotMatch(out, /--bearer_token_env_var/u)
    assertNoSecretLeaked(result, 'setup.mjs (repair branch)')
  } finally {
    home.cleanup()
  }
})

test('setup.mjs refuses a disallowed http origin before printing anything at all, and exits non-zero (finding 2)', async () => {
  const result = await runNode(setupPath, ['--origin', 'http://attacker.example', '--handle', 'victim-agent', '--client-class', 'coding_persistent'])
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout.trim(), '', 'nothing at all was printed to stdout')
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'setup.mjs disallowed origin')
})

test('key.mjs refuses a disallowed http origin before running any command, and exits non-zero (finding 2)', async () => {
  const result = await runNode(keyPath, ['status', '--origin', 'http://attacker.example', '--handle', 'victim-agent'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /only https is allowed/iu)
  assertNoSecretLeaked(result, 'key.mjs disallowed origin')
})

// --- End-to-end against a stub city server ---------------------------------

test('setup.mjs: human approval needs two real passes -- a bare or fabricated --human-approved cannot self-approve in one call, only a token minted by a genuine first pass can', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-approve-')
  try {
    // A bare --human-approved (no token at all) is exactly what the SKILL
    // used to instruct in one shot -- it must still refuse.
    const bareAttempt = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(bareAttempt.status, 0, 'a bare --human-approved with no token still cannot self-approve in one call')
    assert.equal(stub.residents.size, 0)

    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0, 'refuses without a valid token on a non-interactive run')
    assert.match(firstPass.stderr, /put this exact question to the human/u)
    assert.match(firstPass.stderr, /"agent-one"/u)
    assert.match(firstPass.stderr, /register it now/iu)
    assert.match(firstPass.stderr, /decision row 74/u)
    assert.ok(extractApprovalToken(firstPass.stderr), 'the refused first pass prints the exact second command, with a derived token')
    assert.equal(stub.residents.size, 0, 'nothing was registered by the refused first pass')

    // A fabricated token -- something an unattended loop might try to guess
    // or construct without ever having seen a real refusal -- is refused
    // exactly like no token at all. Unlike the no-token case, this does NOT
    // mint a fresh nonce: a value WAS supplied for the pending handle/class,
    // just the wrong one, so the outstanding nonce from firstPass stays
    // alive and this refusal prints that SAME token back -- one wrong paste
    // must never destroy a still-valid, still-unused token.
    const fabricated = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', 'a'.repeat(32)],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(fabricated.status, 0, 'a fabricated token is refused')
    assert.equal(stub.residents.size, 0)
    const token = extractApprovalToken(fabricated.stderr)
    assert.ok(token, 'this refusal too prints the exact second command, with the still-pending token')
    assert.equal(
      token,
      extractApprovalToken(firstPass.stderr),
      'a fabricated/wrong token never re-mints and so never destroys the token firstPass already printed',
    )

    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.residents.size, 1, 'the second pass, carrying the token the most recent refusal minted, actually registered')
    assert.ok(stub.residents.has('agent-one'))
    assertNoSecretLeaked(bareAttempt, 'setup.mjs bare --human-approved attempt')
    assertNoSecretLeaked(firstPass, 'setup.mjs first pass')
    assertNoSecretLeaked(fabricated, 'setup.mjs fabricated-token attempt')
    assertNoSecretLeaked(secondPass, 'setup.mjs second pass')

    const stored = readSecret(stub.origin, 'agent-one', { homeDir: home.dir })
    assert.equal(stored.found, true)
    assert.equal(stored.value.resident_key, stub.residents.get('agent-one').resident_key)

    // The token is single-use: replaying it after a successful registration
    // must never register a second resident. (By now setup-state.json names
    // "agent-one" for this origin, so this reaches the repair path, which
    // never registers regardless -- proving the single-use property would
    // need a second handle's worth of state; the repair-path assertion
    // below already proves no second resident appears either way.)
    const replay = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-one', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(replay.status, 0, replay.stderr)
    assert.equal(stub.residents.size, 1, 'replaying the token never creates a second resident')

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
    deleteSecret(stub.origin, 'agent-one', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs: the approval token is genuinely single-use -- once consumed by a successful pass, it approves nothing else afterward, even for a fresh registration attempt', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-token-reuse-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse', '--client-class', 'coding_persistent'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token)

    const secondPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse', '--client-class', 'coding_persistent', '--human-approved', token],
      { env: home.env },
    )
    assert.equal(secondPass.status, 0, secondPass.stderr)
    assert.equal(stub.residents.size, 1)

    // The successful pass above already consumed pending_approval (set it
    // to null in setup-state.json). Simulate the "state lost, vault intact"
    // stranding shape for a SECOND, distinct handle -- the only way to reach
    // a fresh registration attempt at all, since a repair run ignores
    // --handle entirely once setup-state.json names one for this origin --
    // and confirm the already-spent token still cannot approve it.
    writeFileSync(`${home.dir}/.1f3d9/setup-state.json`, JSON.stringify({}))
    const replay = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-token-reuse-2', '--client-class', 'coding_persistent', '--human-approved', token, '--new-identity'],
      { env: home.env },
    )
    assert.notEqual(replay.status, 0, 'the already-consumed token cannot approve a later registration')
    assert.equal(stub.residents.size, 1, 'no second resident was registered by replaying a spent token')
  } finally {
    deleteSecret(stub.origin, 'agent-token-reuse', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-token-reuse-2', { homeDir: home.dir })
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
    deleteSecret(stub.origin, 'agent-two', { homeDir: home.dir })
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

    // Two real passes are still required even with --new-identity.
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two-b', '--client-class', 'coding_persistent', '--new-identity'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0)
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the refused first pass prints a token for the second run')

    const forced = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-two-b', '--client-class', 'coding_persistent', '--human-approved', token, '--new-identity'],
      { env: home.env },
    )
    assert.notEqual(forced.status, 0, '--new-identity still cannot create a real duplicate; the city itself refuses it')
    assert.match(forced.stdout + forced.stderr, /--new-identity was passed/u)
    assert.equal(stub.residents.size, 1, 'still exactly the one, pre-existing resident')
  } finally {
    deleteSecret(stub.origin, 'agent-two-b', { homeDir: home.dir })
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
      ['--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid', '--handle', 'agent-three', '--client-class', 'coding_persistent', '--human-approved'],
      { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } },
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
    deleteSecret(stub.origin, 'agent-four', { homeDir: home.dir })
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
    deleteSecret(stub.origin, 'agent-five', { homeDir: home.dir })
    deleteSecret(stub.origin, 'agent-five-recovery', { homeDir: home.dir })
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
    deleteSecret(stub.origin, 'agent-six', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('setup.mjs refuses --reveal outright when stdout is not a TTY, instead of silently dropping it', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-reveal-refuse-')
  try {
    const firstPass = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-seven', '--client-class', 'coding_persistent', '--reveal'],
      { env: home.env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.notEqual(firstPass.status, 0)
    const token = extractApprovalToken(firstPass.stderr)
    assert.ok(token, 'the refused first pass prints a token for the second run')

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-seven', '--client-class', 'coding_persistent', '--human-approved', token, '--reveal'],
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

// --- Finding 4: SecretReadFailure is caught everywhere, never an --------
// uncaught crash with a raw Node stack trace.

test('key/connect/setup refuse cleanly on a corrupt vault entry, never an uncaught stack trace', async () => {
  const origin = 'https://example.invalid'
  const handle = `corrupt-handle-${Date.now().toString(36)}`
  const STACK_TRACE_LINE = /^\s*at\s+\S+/mu

  if (process.platform === 'win32') {
    // Seed a genuinely undecodable Windows Credential Manager entry the
    // same way the finding's own reproduction did: cmdkey can write an
    // arbitrary password string that CredRead reads back as raw bytes this
    // script's JSON.parse(Buffer.from(...)) cannot decode.
    const target = `1f3d9:${origin}:${handle}`
    execFileSync('cmdkey', [`/generic:${target}`, `/user:${handle}`, '/pass:not-valid-base64-json{{{'], { stdio: 'ignore' })
    try {
      for (const [label, scriptPath, args] of [
        ['key status', keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['key show', keyPath, ['show', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['connect', connectPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle]],
        ['setup', setupPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle, '--client-class', 'coding_persistent']],
      ]) {
        const result = await runNode(scriptPath, args, { env: NOT_A_REAL_ORIGIN_ENV })
        assert.notEqual(result.status, 0, `${label}: exits non-zero on a corrupt vault entry`)
        assert.doesNotMatch(result.stderr, STACK_TRACE_LINE, `${label}: no raw stack trace`)
        assert.match(result.stderr, /could not be decoded/iu, `${label}: caller-words explanation`)
      }
    } finally {
      execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' })
    }
    return
  }

  // POSIX file backend: write a corrupt file directly at the deterministic
  // path storeSecret/readSecret compute, inside a throwaway HOME.
  const home = makeTempHome('corrupt-vault-')
  try {
    const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
    const safeLabel = handle.replace(/[^a-z0-9._-]/giu, '_')
    const dir = `${home.dir}/.1f3d9/credentials`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${safeOrigin}__${safeLabel}.json`, 'not valid json{{{')

    for (const [label, scriptPath, args] of [
      ['key status', keyPath, ['status', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['key show', keyPath, ['show', '--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['connect', connectPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle]],
      ['setup', setupPath, ['--origin', origin, '--allow-origin', origin, '--handle', handle, '--client-class', 'coding_persistent']],
    ]) {
      const result = await runNode(scriptPath, args, { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV } })
      assert.notEqual(result.status, 0, `${label}: exits non-zero on a corrupt vault entry`)
      assert.doesNotMatch(result.stderr, STACK_TRACE_LINE, `${label}: no raw stack trace`)
      assert.match(result.stderr, /could not be parsed as JSON/iu, `${label}: caller-words explanation`)
    }
  } finally {
    home.cleanup()
  }
})

// --- Finding 5: an adopted/checked vault entry must actually authenticate -
// as the handle it is labelled under, not just any working key.

test('setup.mjs refuses to adopt a vault entry whose stored key authenticates as a different resident', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-mismatch-')
  try {
    // The city knows "agent-beta"; the vault entry LABELLED "agent-alpha"
    // actually holds agent-beta's key (a stale label, a hand-copied entry,
    // or a handle the city normalized at registration).
    stub.residents.set('agent-beta', { resident_key: `1f3d9_sk_${'9'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-alpha', {
      kind: 'resident',
      handle: 'agent-alpha',
      client_class: 'coding_persistent',
      resident_key: stub.residents.get('agent-beta').resident_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-alpha', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses instead of adopting a mismatched entry')
    assert.match(result.stderr, /agent-alpha/u)
    assert.match(result.stderr, /agent-beta/u)
    assert.equal(stub.residents.size, 1, 'no new resident was registered, and the true resident is untouched')
    assertNoSecretLeaked(result, 'setup.mjs mismatch refusal')
  } finally {
    deleteSecret(stub.origin, 'agent-alpha', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('key status reports a mismatch instead of claiming success when the stored key authenticates as a different handle', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('key-mismatch-')
  try {
    stub.residents.set('agent-delta', { resident_key: `1f3d9_sk_${'8'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-gamma', {
      kind: 'resident',
      handle: 'agent-gamma',
      client_class: 'coding_persistent',
      resident_key: stub.residents.get('agent-delta').resident_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(keyPath, ['status', '--origin', stub.origin, '--handle', 'agent-gamma'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /agent-gamma/u)
    assert.match(result.stdout, /agent-delta/u)
    assert.doesNotMatch(result.stdout, /works \(one me read succeeded\)/u, 'never claims plain success on a mismatch')
    assertNoSecretLeaked(result, 'key status mismatch')
  } finally {
    deleteSecret(stub.origin, 'agent-gamma', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

test('connect.mjs reports a mismatch instead of claiming OK when the stored key authenticates as a different handle', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('connect-mismatch-')
  try {
    stub.residents.set('agent-zeta', { resident_key: `1f3d9_sk_${'6'.repeat(48)}`, recovery_codes: [], client_class: 'coding_persistent' })
    storeSecret(stub.origin, 'agent-epsilon', {
      kind: 'resident',
      handle: 'agent-epsilon',
      client_class: 'coding_persistent',
      resident_key: stub.residents.get('agent-zeta').resident_key,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(connectPath, ['--origin', stub.origin, '--handle', 'agent-epsilon'], { env: home.env })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /MISMATCH/u)
    assert.match(result.stdout, /agent-epsilon/u)
    assert.match(result.stdout, /agent-zeta/u)
    assert.doesNotMatch(result.stdout, /one me read: OK/u, 'never claims OK on a mismatch')
    assertNoSecretLeaked(result, 'connect.mjs mismatch')
  } finally {
    deleteSecret(stub.origin, 'agent-epsilon', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 8: the duplicate-identity guard enumerates the whole vault, --
// not just the exact handle requested.

test('setup.mjs refuses to register under a new handle when this origin already has a vault entry under a different label, without --new-identity', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-other-label-')
  try {
    storeSecret(stub.origin, 'agent-old', {
      kind: 'resident',
      handle: 'agent-old',
      client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'7'.repeat(48)}`,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-new', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.notEqual(result.status, 0, 'refuses without --new-identity when another entry exists for this origin')
    assert.match(result.stderr, /--new-identity/u)
    assert.match(result.stderr, /agent-old/u)
    assert.equal(stub.residents.size, 0, 'nothing was registered')
    assertNoSecretLeaked(result, 'setup.mjs other-label refusal')
  } finally {
    deleteSecret(stub.origin, 'agent-old', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// A leftover REGISTRATION staging label (a run that died between staging
// and promotion) is not a real second identity -- listVaultLabels must
// exclude it by the `kind: 'staging'` marker its bundle carries (see
// storeSecret/isStagingLabel in identity-client.mjs), covering the per-run
// suffixed registration form the same way it already covers rotation/
// recovery, or the guard above wrongly refuses a legitimate fresh
// registration because of a label this script itself created and never
// meant as anything but scratch space.

test('setup.mjs does not treat a leftover registration staging label as a second identity', async () => {
  const stub = await startStubCityServer()
  const home = makeTempHome('setup-stale-registration-staging-')
  try {
    // Simulates a register() run that staged a bundle and then died before
    // ever confirming or promoting it -- exactly the suffixed label shape
    // AND the `kind: 'staging'` marker pendingLabel's callers now write
    // (identity-client.mjs register()). Marking staging by data rather than
    // by label text alone is what lets a REAL resident's own handle end in
    // this same suffix shape without being hidden from listVaultLabels --
    // see the "listVaultLabels ... a real resident whose handle ends in
    // --pending-rotation is still listed" tests in identity-client.test.mjs.
    storeSecret(stub.origin, 'agent-abandoned--pending-registration-deadbeef', {
      kind: 'staging',
      handle: 'agent-abandoned',
      client_class: 'coding_persistent',
      resident_key: `1f3d9_sk_${'8'.repeat(48)}`,
      recovery_codes: [],
      origin: stub.origin,
      stored_at: new Date().toISOString(),
    }, { homeDir: home.dir })

    const result = await runNode(
      setupPath,
      ['--origin', stub.origin, '--handle', 'agent-fresh', '--client-class', 'coding_persistent'],
      { env: home.env },
    )
    assert.doesNotMatch(
      result.stderr,
      /already holds .* entr(?:y|ies) for this origin under a different/u,
      'a staging-only label must never trip the duplicate-identity guard',
    )
    assertNoSecretLeaked(result, 'setup.mjs leftover registration staging label')
  } finally {
    deleteSecret(stub.origin, 'agent-abandoned--pending-registration-deadbeef', { homeDir: home.dir })
    home.cleanup()
    await stub.close()
  }
})

// --- Finding 9: the test env overlay never leaks the real developer's own -
// AGENT_1F3D9_SECRET / IDENTITY_ORIGIN into a driven child process.

test('runNode does not leak the parent process\'s AGENT_1F3D9_SECRET or IDENTITY_ORIGIN into the child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-identity-cli-env-'))
  try {
    const probeScript = join(dir, 'env-probe.mjs')
    writeFileSync(
      probeScript,
      "process.stdout.write(JSON.stringify({ secret: process.env.AGENT_1F3D9_SECRET ?? null, origin: process.env.IDENTITY_ORIGIN ?? null }))\n",
    )
    const previousSecret = process.env.AGENT_1F3D9_SECRET
    const previousOrigin = process.env.IDENTITY_ORIGIN
    process.env.AGENT_1F3D9_SECRET = `1f3d9_sk_${'z'.repeat(48)}`
    process.env.IDENTITY_ORIGIN = 'https://leaked.invalid'
    try {
      const result = await runNode(probeScript, [])
      const seen = JSON.parse(result.stdout)
      assert.equal(seen.secret, null, 'the real AGENT_1F3D9_SECRET from this test-runner process never reaches the child')
      assert.equal(seen.origin, null, 'the real IDENTITY_ORIGIN from this test-runner process never reaches the child')
    } finally {
      if (previousSecret === undefined) delete process.env.AGENT_1F3D9_SECRET
      else process.env.AGENT_1F3D9_SECRET = previousSecret
      if (previousOrigin === undefined) delete process.env.IDENTITY_ORIGIN
      else process.env.IDENTITY_ORIGIN = previousOrigin
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Finding 12: `key show --reveal` never prints the literal word --------
// "undefined" when a stored bundle carries no resident_key field.

test('key show refuses to print "undefined" when a stored bundle has no resident_key field', async () => {
  const origin = 'https://example.invalid'
  const home = makeTempHome('key-show-no-key-')
  try {
    storeSecret(origin, 'no-key-handle', {
      kind: 'resident',
      handle: 'no-key-handle',
      origin,
      // deliberately missing resident_key -- a staging bundle, a hand-written
      // entry, or any future bundle shape without one.
    }, { homeDir: home.dir })

    const result = await runNode(
      keyPath,
      ['show', '--origin', origin, '--allow-origin', origin, '--handle', 'no-key-handle', '--reveal'],
      { env: { ...home.env, ...NOT_A_REAL_ORIGIN_ENV }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    assert.doesNotMatch(result.stdout, /undefined/u)
    assert.match(result.stdout, /carries no resident_key/u)
  } finally {
    deleteSecret(origin, 'no-key-handle', { homeDir: home.dir })
    home.cleanup()
  }
})
