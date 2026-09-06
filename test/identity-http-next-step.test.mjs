import assert from 'node:assert/strict'
import test from 'node:test'

import { postJson } from '../scripts/lib/identity-http.mjs'

async function refusalMessage(nextStep) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'request failed', next_step: nextStep }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
  try {
    await postJson('https://example.invalid', '/api/example', {})
  } catch (error) {
    return error.message
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.fail('postJson should reject a refused response')
}

test('postJson omits a next_step containing a control character from its error line', async () => {
  const message = await refusalMessage('Retry later.\nFabricated second line.')

  assert.equal(message, '/api/example refused: request failed.')
})

test('postJson omits a next_step over 300 characters from its error line', async () => {
  const message = await refusalMessage('x'.repeat(301))

  assert.equal(message, '/api/example refused: request failed.')
})
