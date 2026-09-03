// One real, read-only probe against the live coding-client identity doors
// (decision row 74) proving the transport this repo's setup/connect/key
// commands depend on actually behaves the way scripts/identity-client.mjs
// assumes: an invalid body gets a fast, structured 400 with a reason, never
// a hang, a 5xx, or a silently-accepted bad request. It never registers,
// rotates, or recovers anything real — every request below is deliberately
// malformed so the door refuses it before touching any resident.
//
// Gated the same way test/live-drift.test.mjs gates its own network test:
// skips honestly when offline and not required, fails loudly when
// REQUIRE_LIVE_TRUTH=1 (this repo's CI always sets it) and the network is
// unreachable.

import assert from 'node:assert/strict'
import test from 'node:test'

const ORIGIN = 'https://1f3d9.com'
const TIMEOUT_MS = 2_000

async function probeInvalidRegister({ fetchImpl = fetch } = {}) {
  const startedAt = Date.now()
  const response = await fetchImpl(`${ORIGIN}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Deliberately invalid: "stage" with no handle/client_class at all.
    body: JSON.stringify({ action: 'stage' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const elapsedMs = Date.now() - startedAt
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled by the assertions below
  }
  return { status: response.status, elapsedMs, body: parsed, reasonHeader: response.headers.get('x-1f3d9-reason') }
}

test('a deliberately invalid POST /api/register is refused with 400 and a reason, fast', async (t) => {
  const requireNetwork = process.env.REQUIRE_LIVE_TRUTH === '1'
  let result
  try {
    result = await probeInvalidRegister()
  } catch (error) {
    if (!requireNetwork) {
      t.skip(`SKIP: could not reach ${ORIGIN} (${error.message}); set REQUIRE_LIVE_TRUTH=1 to require this probe`)
      return
    }
    throw new Error(`live identity-door probe is required but the network is unreachable: ${error.message}`)
  }

  assert.equal(result.status, 400, 'an invalid register body is refused with 400, not a 5xx or a silent accept')
  assert.ok(result.elapsedMs < TIMEOUT_MS, `refusal took ${result.elapsedMs}ms, expected under ${TIMEOUT_MS}ms`)
  assert.ok(result.body, 'the refusal body parses as JSON')
  assert.equal(typeof result.body.reason, 'string', 'the refusal carries a machine-readable reason')
  assert.ok(result.body.reason.length > 0)
  assert.equal(typeof result.body.error, 'string', 'the refusal carries a human-readable error')
  assert.equal(typeof result.body.request_id, 'string', 'the refusal carries a request_id for support correlation')
})

test('a structurally invalid rotate body (unknown action) is refused with 400 and a reason, fast', async (t) => {
  const requireNetwork = process.env.REQUIRE_LIVE_TRUTH === '1'
  const startedAt = Date.now()
  let response
  try {
    // "action" values are enum-validated before any credential is ever
    // looked up, so this is refused as a 400 (bad request shape), distinct
    // from a wrong-but-well-formed credential, which the door answers with
    // 403 credential_rejected instead — confirmed against the live door
    // while writing this test.
    response = await fetch(`${ORIGIN}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not_a_real_action' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    if (!requireNetwork) {
      t.skip(`SKIP: could not reach ${ORIGIN} (${error.message})`)
      return
    }
    throw new Error(`live identity-door probe is required but the network is unreachable: ${error.message}`)
  }
  const elapsedMs = Date.now() - startedAt
  const body = await response.json().catch(() => null)
  assert.equal(response.status, 400)
  assert.ok(elapsedMs < TIMEOUT_MS, `refusal took ${elapsedMs}ms, expected under ${TIMEOUT_MS}ms`)
  assert.equal(typeof body?.reason, 'string')
})
