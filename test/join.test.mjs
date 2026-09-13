import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { readSecret, storeSecret } from '../scripts/identity-client.mjs'
import { writeRecoveryCodes } from '../scripts/lib/recovery-file.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'

const joinPath = fileURLToPath(new URL('../scripts/join.mjs', import.meta.url))
const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))
const cliStub = fileURLToPath(new URL('./helpers/join-cli-stub.mjs', import.meta.url))

test('join saves only key in vault, codes only in chosen folder, and selected connector handle', async () => {
  const home = makeTempHome('city-join-')
  const addMarker = join(home.dir, 'connector-added')
  const door = await startStubCityServer({ meAfterFile: addMarker })
  const codesDir = join(home.dir, 'human chosen codes')
  mkdirSync(codesDir)
  const recordFile = join(home.dir, 'connector.json')
  const env = { ...home.env, AGENT_1F3D9_JOIN_CLI_STUB: cliStub, JOIN_CLI_RECORD_FILE: recordFile, JOIN_CLI_ADD_MARKER: addMarker }
  writeFileSync(recordFile, JSON.stringify({ entries: { '1f3d9-agent-join': ['old', 'wrong', 'entry'] }, calls: [] }))
  const args = ['--host', 'codex', '--handle', 'agent-join', '--codes-dir', codesDir, '--origin', door.origin]
  try {
    const first = await runNode(joinPath, args, { env })
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.equal(first.status, 1)
    assert.ok(token, first.stderr)
    assert.equal(door.residents.size, 0)
    const second = await runNode(joinPath, [...args, '--human-approved', token], { env })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(door.requestUrls.filter(url => url === '/api/me').length, 1)
    assert.equal(second.stdout.trim(), `handle: agent-join\nconnector: 1f3d9-agent-join\ncodes: ${join(codesDir, '1f3d9-agent-join-recovery-codes.txt')}`)
    assert.doesNotMatch(second.stdout + second.stderr, /1f3d9_(?:sk|rc)_[0-9a-f]+/u)
    const codes = readFileSync(join(codesDir, '1f3d9-agent-join-recovery-codes.txt'), 'utf8').trim().split('\n')
    assert.deepEqual(codes, door.residents.get('agent-join').recovery_codes)
    const stored = readSecret(door.origin, 'agent-join', { homeDir: home.dir })
    assert.equal(stored.value.resident_key, door.residents.get('agent-join').resident_key)
    assert.equal(Object.hasOwn(stored.value, 'recovery_codes'), false)
    const cli = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.deepEqual(cli.entries['1f3d9-agent-join'].slice(-3), [joinPath.replace('join.mjs', 'mcp-bridge.mjs'), '--handle', 'agent-join'])
    assert.equal(cli.entries['1f3d9-agent-join'].at(-1), 'agent-join')
    assert.equal(cli.calls.some(call => call.args[1] === 'add'), true)
    assert.equal(cli.calls.some(call => call.args[1] === 'remove'), true)
    const repeated = await runNode(joinPath, args, { env })
    assert.equal(repeated.status, 1)
    assert.match(repeated.stderr, /key status --handle agent-join/u)
    assert.equal(door.residents.size, 1)
    const repair = await runNode(joinPath, [...args, '--repair'], { env })
    assert.equal(repair.status, 0, repair.stderr)
    assert.equal(door.requestUrls.filter(url => url === '/api/me').length, 2)
    assert.equal(door.residents.size, 1)
  } finally {
    await door.close()
    home.cleanup()
  }
})

test('join refuses an existing codes file before contacting the registration door', async () => {
  const door = await startStubCityServer()
  const home = makeTempHome('city-join-collision-')
  const codesDir = join(home.dir, 'codes')
  mkdirSync(codesDir)
  writeFileSync(join(codesDir, '1f3d9-agent-join-recovery-codes.txt'), 'existing\n')
  try {
    const result = await runNode(joinPath, ['--host', 'codex', '--handle', 'agent-join', '--codes-dir', codesDir, '--origin', door.origin], { env: home.env })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to overwrite/u)
    assert.equal(door.residents.size, 0)
  } finally {
    await door.close()
    home.cleanup()
  }
})

test('join reports a created resident and saved codes when connector installation fails', async () => {
  const door = await startStubCityServer()
  const home = makeTempHome('city-join-cli-fail-')
  const codesDir = join(home.dir, 'codes')
  mkdirSync(codesDir)
  const env = {
    ...home.env,
    AGENT_1F3D9_JOIN_CLI_STUB: cliStub,
    JOIN_CLI_RECORD_FILE: join(home.dir, 'connector.json'),
    JOIN_CLI_FAIL_ADD: '1',
  }
  const args = ['--host', 'codex', '--handle', 'agent-fail', '--codes-dir', codesDir, '--origin', door.origin]
  try {
    const first = await runNode(joinPath, args, { env })
    const token = /--human-approved ([0-9a-f]{32})/u.exec(first.stderr)?.[1]
    assert.ok(token, first.stderr)
    const second = await runNode(joinPath, [...args, '--human-approved', token], { env })
    assert.equal(second.status, 1)
    assert.match(second.stderr, /Resident agent-fail was created/u)
    assert.match(second.stderr, /codes are at/u)
    assert.equal(door.residents.has('agent-fail'), true)
    assert.equal(door.requestUrls.filter(url => url === '/api/me').length, 0)
  } finally {
    await door.close()
    home.cleanup()
  }
})

test('recovery file refuses malformed codes without creating a file', () => {
  const home = makeTempHome('city-join-bad-codes-')
  try {
    assert.throws(() => writeRecoveryCodes(home.dir, 'agent-bad', Array(8).fill('not-a-recovery-code')), /eight recovery codes/u)
    assert.throws(() => readFileSync(join(home.dir, '1f3d9-agent-bad-recovery-codes.txt')), { code: 'ENOENT' })
  } finally {
    home.cleanup()
  }
})

test('recovery file requires a real chosen folder and never overwrites codes', () => {
  const home = makeTempHome('city-join-folder-')
  const codes = Array(8).fill(`1f3d9_rc_${'a'.repeat(64)}`)
  try {
    assert.throws(() => writeRecoveryCodes('relative-folder', 'agent-folder', codes), /absolute folder/u)
    assert.throws(() => writeRecoveryCodes(join(home.dir, 'missing'), 'agent-folder', codes), /existing folder/u)
    const file = writeRecoveryCodes(home.dir, 'agent-folder', codes)
    assert.equal(readFileSync(file, 'utf8'), `${codes.join('\n')}\n`)
    assert.throws(() => writeRecoveryCodes(home.dir, 'agent-folder', codes), /refusing to overwrite/u)
    assert.equal(readFileSync(file, 'utf8'), `${codes.join('\n')}\n`)
  } finally {
    home.cleanup()
  }
})

test('join refuses a non-city connector origin before registration', async () => {
  const home = makeTempHome('city-join-origin-')
  try {
    const result = await runNode(joinPath, [
      '--host', 'codex', '--handle', 'agent-origin', '--codes-dir', home.dir,
      '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    ], { env: { ...home.env, AGENT_1F3D9_STUB_ONLY: '0' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /production city bridge only/u)
    assert.equal(result.stdout, '')
  } finally {
    home.cleanup()
  }
})

test('join rejects valued repair flags and foreign origins even with a stub override', async () => {
  const home = makeTempHome('city-join-boundary-')
  try {
    const base = ['--host', 'codex', '--handle', 'agent-boundary', '--codes-dir', home.dir]
    const repair = await runNode(joinPath, [...base, '--repair=false'], { env: home.env })
    assert.equal(repair.status, 1)
    assert.match(repair.stderr, /bare --repair/u)
    const foreign = await runNode(joinPath, [
      ...base, '--origin', 'https://example.invalid', '--allow-origin', 'https://example.invalid',
    ], { env: home.env })
    assert.equal(foreign.status, 1)
    assert.match(foreign.stderr, /localhost|production city bridge/u)
    assert.equal(foreign.stdout, '')
  } finally {
    home.cleanup()
  }
})

test('repair leaves connector untouched when a vault label authenticates as another resident', async () => {
  const door = await startStubCityServer()
  const home = makeTempHome('city-join-mismatch-')
  const recordFile = join(home.dir, 'connector.json')
  const handle = 'agent-wrong'
  const actual = 'agent-actual'
  const key = `1f3d9_sk_${'b'.repeat(48)}`
  door.residents.set(actual, { resident_key: key, recovery_codes: [] })
  storeSecret(door.origin, handle, { kind: 'resident', handle, resident_key: key, origin: door.origin }, { homeDir: home.dir })
  writeFileSync(join(home.dir, `1f3d9-${handle}-recovery-codes.txt`), 'saved\n')
  writeFileSync(recordFile, JSON.stringify({ entries: { [`1f3d9-${handle}`]: ['old-entry'] }, calls: [] }))
  try {
    const result = await runNode(joinPath, [
      '--host', 'codex', '--handle', handle, '--codes-dir', home.dir, '--origin', door.origin, '--repair',
    ], { env: { ...home.env, AGENT_1F3D9_JOIN_CLI_STUB: cliStub, JOIN_CLI_RECORD_FILE: recordFile } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /did not authenticate as that handle/u)
    const cli = JSON.parse(readFileSync(recordFile, 'utf8'))
    assert.deepEqual(cli.entries[`1f3d9-${handle}`], ['old-entry'])
    assert.deepEqual(cli.calls, [])
  } finally {
    await door.close()
    home.cleanup()
  }
})

test('malformed confirmed handle keeps the key in staging and names the separate codes file', async () => {
  const door = await startStubCityServer({ corruptHandle: { registerConfirm: 'BAD-HANDLE' } })
  const home = makeTempHome('city-join-confirm-handle-')
  try {
    const result = await runNode(identityClientPath, [
      'register', '--origin', door.origin, '--handle', 'agent-malformed',
      '--client-class', 'coding_persistent', '--human-approved', '--codes-dir', home.dir,
    ], { env: home.env })
    assert.equal(result.status, 1)
    const codesFile = join(home.dir, '1f3d9-agent-malformed-recovery-codes.txt')
    assert.match(result.stderr, /confirmed key remains under staging label/u)
    assert.match(result.stderr, /recovery codes are at/u)
    assert.ok(result.stderr.includes(codesFile))
    const label = /agent-malformed--pending-registration-[0-9a-f]+/u.exec(result.stderr)?.[0]
    assert.ok(label, result.stderr)
    const staged = readSecret(door.origin, label, { homeDir: home.dir })
    assert.equal(staged.value.resident_key, door.residents.get('agent-malformed').resident_key)
    assert.equal(Object.hasOwn(staged.value, 'recovery_codes'), false)
    assert.deepEqual(readFileSync(codesFile, 'utf8').trim().split('\n'), door.residents.get('agent-malformed').recovery_codes)
  } finally {
    await door.close()
    home.cleanup()
  }
})
