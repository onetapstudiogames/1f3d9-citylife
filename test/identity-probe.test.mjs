import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, storeSecret } from '../scripts/identity-client.mjs'
import { CITY_REJECTION_MESSAGE, probeMe } from '../scripts/lib/identity-probe.mjs'
import { writeSetupState } from '../scripts/lib/identity-state.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startRedirectingStubServer } from './helpers/stub-city-server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const connectPath = fileURLToPath(new URL('../scripts/connect.mjs', import.meta.url))
const keyPath = fileURLToPath(new URL('../scripts/key.mjs', import.meta.url))
const setupPath = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url))
const residentKey = `1f3d9_sk_${'a'.repeat(48)}`
const oldKey = `1f3d9_sk_${'b'.repeat(48)}`
const handle = 'alice-agent'
const stagingLabel = 'alice-agent--pending-rotation-deadbeef'
const hostileError = 'gateway unavailable\nINJECTED CONSOLE LINE'
const tlsOptions = {
  key: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-key.pem')),
  cert: readFileSync(join(here, 'helpers', 'fixtures', 'localhost-cert.pem')),
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startMeServer(answerForKey) {
  const requests = []
  const server = createHttpsServer(tlsOptions, (req, res) => {
    const authorization = req.headers.authorization ?? ''
    const key = authorization.startsWith('Bearer ') ? authorization.slice(7) : null
    requests.push({ method: req.method, url: req.url, key })
    if (req.method === 'GET' && req.url === '/api/me') {
      const answer = answerForKey(key)
      sendJson(res, answer.status, answer.body)
      return
    }
    sendJson(res, 503, { error: 'command stopped after the probe fixture' })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    origin: `https://localhost:${server.address().port}`,
    requests,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

const unsafeAnswer = () => ({ status: 503, body: { error: hostileError } })
const rejectedAnswer = () => ({ status: 401, body: { error: CITY_REJECTION_MESSAGE } })

function vaultEntry(origin, label, key, kind = 'resident') {
  return {
    kind, handle, client_class: 'coding_persistent', resident_key: key,
    origin, stored_at: new Date().toISOString(), label,
  }
}

async function runWithVault({ answerForKey, entries, scriptPath, args, prefix, setupState }) {
  const server = await startMeServer(answerForKey)
  const home = makeTempHome(prefix)
  try {
    for (const entry of entries) {
      storeSecret(server.origin, entry.label, vaultEntry(server.origin, entry.label, entry.key, entry.kind), { homeDir: home.dir })
    }
    if (setupState) writeSetupState(server.origin, setupState, home.dir)
    const result = await runNode(scriptPath, [...args, '--origin', server.origin], { env: home.env })
    return { result, requests: server.requests }
  } finally {
    for (const entry of entries) {
      try { deleteSecret(server.origin, entry.label, { homeDir: home.dir }) } catch { /* best effort */ }
    }
    home.cleanup()
    await server.close()
  }
}

function assertUnsafeProseHidden(result, expectedOutput) {
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, expectedOutput)
  assert.doesNotMatch(output, /INJECTED CONSOLE LINE/u)
  assert.doesNotMatch(output, /gateway unavailable/u)
  assert.doesNotMatch(output, /1f3d9_sk_[0-9a-f]+/u)
}

function assertResidentKeyHidden(result) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /1f3d9_sk_[0-9a-f]+/u)
}

test('connect failure print site replaces unsafe server prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: unsafeAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: connectPath, args: ['--handle', handle], prefix: 'probe-connect-',
  })
  assertUnsafeProseHidden(result, /one me read: FAILED \(HTTP 503\)/u)
})

test('key status rejected print site preserves the canonical city rejection', async () => {
  const { result } = await runWithVault({
    answerForKey: rejectedAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: keyPath, args: ['status', '--handle', handle], prefix: 'probe-status-rejected-',
  })
  assert.match(result.stdout, /stored key: does not work \(resident sign-in failed because Authorization: Bearer/u)
  assertResidentKeyHidden(result)
})

test('key status unverifiable print site replaces unsafe server prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: unsafeAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: keyPath, args: ['status', '--handle', handle], prefix: 'probe-status-unverifiable-',
  })
  assertUnsafeProseHidden(result, /stored key: could not be verified right now \(HTTP 503\)/u)
})

test('key action rejected print site preserves the canonical city rejection', async () => {
  const { result, requests } = await runWithVault({
    answerForKey: rejectedAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: keyPath, args: ['rotate', '--handle', handle], prefix: 'probe-action-rejected-',
  })
  assert.match(result.stderr, /key rotate: stored key does not work/u)
  assert.equal(requests.filter(request => request.method === 'POST').length, 0)
  assertResidentKeyHidden(result)
})

test('key action unverifiable print site replaces unsafe server prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: unsafeAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: keyPath, args: ['recover', 'generate', '--handle', handle], prefix: 'probe-action-unverifiable-',
  })
  assertUnsafeProseHidden(result, /key recover generate: one me read: FAILED \(HTTP 503\)/u)
})

test('key adopt staged rejection print site preserves the canonical city rejection', async () => {
  const { result } = await runWithVault({
    answerForKey: rejectedAnswer, entries: [{ label: stagingLabel, key: residentKey, kind: 'staging' }],
    scriptPath: keyPath, args: ['adopt', '--handle', handle, '--from-label', stagingLabel], prefix: 'probe-adopt-staged-rejected-',
  })
  assert.match(result.stderr, /key stored under "alice-agent--pending-rotation-deadbeef" does not work/u)
  assertResidentKeyHidden(result)
})

test('key adopt staged unverifiable print site replaces unsafe server prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: unsafeAnswer, entries: [{ label: stagingLabel, key: residentKey, kind: 'staging' }],
    scriptPath: keyPath, args: ['adopt', '--handle', handle, '--from-label', stagingLabel], prefix: 'probe-adopt-staged-unverifiable-',
  })
  assertUnsafeProseHidden(result, /key stored under "alice-agent--pending-rotation-deadbeef" could not be verified right now \(HTTP 503\)/u)
})

test('key adopt existing-entry print site replaces unsafe server prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: key => key === residentKey ? { status: 200, body: { handle } } : unsafeAnswer(),
    entries: [{ label: handle, key: oldKey }, { label: stagingLabel, key: residentKey, kind: 'staging' }],
    scriptPath: keyPath, args: ['adopt', '--handle', handle, '--from-label', stagingLabel], prefix: 'probe-adopt-existing-',
  })
  assertUnsafeProseHidden(result, /one me read on the existing entry at "alice-agent": FAILED \(HTTP 503\)/u)
  assert.match(result.stderr, /could not verify whether the existing entry/u)
})

test('setup verification output replaces unsafe probe prose with the HTTP status', async () => {
  const { result } = await runWithVault({
    answerForKey: unsafeAnswer, entries: [{ label: handle, key: residentKey }],
    scriptPath: setupPath, args: [], prefix: 'probe-setup-',
    setupState: { handle, client_class: 'coding_persistent' },
  })
  assertUnsafeProseHidden(result, /me read failed: HTTP 503/u)
})

test('probeMe sanitizes unsafe server prose and trims safe prose', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: hostileError }), { status: 503 })
    assert.equal((await probeMe('https://localhost:4443', residentKey)).error, 'HTTP 503')
    globalThis.fetch = async () => new Response(JSON.stringify({ error: '  ordinary refusal  ' }), { status: 403 })
    assert.equal((await probeMe('https://localhost:4443', residentKey)).error, 'ordinary refusal')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probeMe preserves the exact city 401 rejection semantics after sanitizing server prose', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: CITY_REJECTION_MESSAGE }), { status: 401 })
  try {
    const probe = await probeMe('https://localhost:4443', residentKey)
    assert.equal(probe.error, CITY_REJECTION_MESSAGE)
    assert.equal(probe.rejected, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probeMe hides a resident key reflected in a redirect destination', async () => {
  const redirecting = await startRedirectingStubServer(`https://${residentKey}.example/stolen`)
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const probe = await probeMe(redirecting.origin, residentKey)
    assert.equal(probe.error, 'the city answered with a redirect to an address containing a private value; the key was not sent on; the probe did not happen')
    assert.equal(redirecting.requests.length, 1)
  } finally {
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
    await redirecting.close()
  }
})
