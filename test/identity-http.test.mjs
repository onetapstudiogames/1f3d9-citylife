import assert from 'node:assert/strict'
import test from 'node:test'

import { postAuthed, postJson, sanitizeServerProse } from '../scripts/lib/identity-http.mjs'
import { startRedirectingStubServer } from './helpers/stub-city-server.mjs'

const callers = [
  { name: 'postJson', call: () => postJson('https://example.invalid', '/api/example', {}), suffix: '.' },
  { name: 'postAuthed', call: () => postAuthed('https://example.invalid', '/api/example', 'test-only-key', {}), suffix: '' },
]

for (const { name, call, suffix } of callers) {
  for (const [description, value] of [
    ['a control character', 'Request failed.\nFabricated second line.'],
    ['more than 300 characters', 'x'.repeat(301)],
  ]) {
    test(`${name} replaces an error containing ${description} with the HTTP fallback`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response(
        JSON.stringify({ error: value }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ))

      await assert.rejects(call, {
        message: `/api/example refused: HTTP 400 with no readable JSON body${suffix}`,
      })
    })
  }
}

test('sanitizeServerProse rejects the empty string', () => {
  assert.equal(sanitizeServerProse(''), '')
})

test('sanitizeServerProse rejects a U+2028 line separator', () => {
  assert.equal(sanitizeServerProse('Request failed.\u2028Fabricated second line.'), '')
})

for (const sameOrigin of [false, true]) {
  test(`postAuthed refuses a 302 to ${sameOrigin ? 'the same origin' : 'another host'} without a second request`, async (t) => {
    const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    t.after(() => {
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
    })

    const target = sameOrigin ? null : await startRedirectingStubServer('/unexpected', { host: '127.0.0.2' })
    if (target) t.after(() => target.close())
    const location = `${target?.origin ?? ''}/private-path?token=private-query#private-fragment`
    const redirecting = await startRedirectingStubServer(location, { status: 302 })
    t.after(() => redirecting.close())

    let refusal
    try {
      await postAuthed(redirecting.origin, '/api/pair', 'test-only-key', {})
    } catch (error) {
      refusal = error
    }

    assert.deepEqual(redirecting.requests, [{ method: 'POST', url: '/api/pair', hasAuthorization: true }])
    if (target) assert.deepEqual(target.requests, [])
    assert.equal(refusal?.message,
      `${redirecting.origin}/api/pair: the city answered with a redirect to ${target?.origin ?? redirecting.origin}; ` +
      'the key was not sent on; check the city address and whether the action completed before retrying')
  })
}

test('redirect diagnostics hide private values reflected in the destination origin', async (t) => {
  const privateValue = 'Test-Only-Private-Value'
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302,
    headers: { location: `https://${privateValue}.example.invalid/private-path` },
  }))

  for (const field of ['resident_key', 'recovery_code', 'stage_token']) {
    await assert.rejects(() => postJson('https://example.invalid', '/api/recovery', { [field]: privateValue }), {
      message: 'https://example.invalid/api/recovery: the city answered with a redirect to ' +
        'an address containing a private value; the key was not sent on; ' +
        'check the city address and whether the action completed before retrying',
    })
  }
  await assert.rejects(() => postAuthed('https://example.invalid', '/api/pair', privateValue, {}), {
    message: 'https://example.invalid/api/pair: the city answered with a redirect to ' +
      'an address containing a private value; the key was not sent on; ' +
      'check the city address and whether the action completed before retrying',
  })
})

function networkFailure(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } })
}

test('an unmapped request reports that it was not sent when connection is refused', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkFailure('ECONNREFUSED')
  })

  await assert.rejects(() => postJson('https://example.invalid', '/api/example', {}), {
    message: 'could not reach https://example.invalid/api/example (network error: connection refused); ' +
      'the request was not sent; check the address and your connection, then retry',
  })
})

test('an unmapped request reports that its result is uncertain after a timeout', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkFailure('ETIMEDOUT')
  })

  await assert.rejects(() => postJson('https://example.invalid', '/api/example', {}), {
    message: 'could not reach https://example.invalid/api/example (network error: the connection timed out); ' +
      'the result could not be confirmed; check whether the action completed before retrying',
  })
})

test('a refused registration confirmation says the staged credential remains stored', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw networkFailure('ECONNREFUSED')
  })

  await assert.rejects(() => postJson('https://example.invalid', '/api/register', {
    action: 'confirm',
    stage_token: 'test-only-stage-token',
    resident_key: 'test-only-resident-key',
  }), {
    message: 'could not reach https://example.invalid/api/register (network error: connection refused); ' +
      'no resident was created; a staged credential entry was written locally and remains stored; ' +
      'check the address and your connection, then retry',
  })
})
