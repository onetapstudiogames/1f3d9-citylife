import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { deleteSecret, listVaultLabels, readSecret } from '../scripts/identity-client.mjs'
import { startStubCityServer } from './helpers/stub-city-server.mjs'
import { makeTempHome, runNode } from './helpers/run-identity-cli.mjs'

const identityClientPath = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))
const SECRET_LITERAL_RE = /1f3d9_(?:sk|rc)_[0-9a-f]+/u

test('register keeps its staged credential when confirmation loses the response', async () => {
  const stub = await startStubCityServer({ failRegisterConfirm: true })
  const home = makeTempHome('register-confirm-failure-')
  try {
    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'confirm-strand',
      '--client-class', 'coding_persistent', '--human-approved',
    ], { env: home.env })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /registration could not be confirmed/u)
    assert.doesNotMatch(result.stdout, SECRET_LITERAL_RE)
    assert.doesNotMatch(result.stderr, SECRET_LITERAL_RE)

    const labels = listVaultLabels(stub.origin, { homeDir: home.dir }).registrationStagingLabels
    assert.equal(labels.length, 1, 'one recoverable registration staging entry remains')
    const staged = readSecret(stub.origin, labels[0], { homeDir: home.dir })
    assert.equal(staged.found, true)
    assert.equal(staged.value.handle, 'confirm-strand')
    assert.match(staged.value.resident_key, /^1f3d9_sk_[0-9a-f]{48}$/u)

    deleteSecret(stub.origin, labels[0], { homeDir: home.dir })
  } finally {
    home.cleanup()
    await stub.close()
  }
})

test('register keeps its staged credential when confirmation returns a 4xx refusal', async () => {
  const stub = await startStubCityServer({ refuseRegisterConfirm: true })
  const home = makeTempHome('register-confirm-refusal-')
  try {
    const result = await runNode(identityClientPath, [
      'register', '--origin', stub.origin, '--handle', 'refused-strand',
      '--client-class', 'coding_persistent', '--human-approved',
    ], { env: home.env })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /registration confirmation refused/u)
    assert.doesNotMatch(result.stdout, SECRET_LITERAL_RE)
    assert.doesNotMatch(result.stderr, SECRET_LITERAL_RE)

    const labels = listVaultLabels(stub.origin, { homeDir: home.dir }).registrationStagingLabels
    assert.equal(labels.length, 1, 'one recoverable registration staging entry remains')
    const staged = readSecret(stub.origin, labels[0], { homeDir: home.dir })
    assert.equal(staged.found, true)
    assert.equal(staged.value.handle, 'refused-strand')

    deleteSecret(stub.origin, labels[0], { homeDir: home.dir })
  } finally {
    home.cleanup()
    await stub.close()
  }
})
