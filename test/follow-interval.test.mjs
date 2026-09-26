import assert from 'node:assert/strict'
import test from 'node:test'
import { followRefreshMs, readFollowRefreshMs } from '../scripts/lib/follow-interval.mjs'

test('follow refresh is at least 30 seconds and at most ten minutes', () => {
  for (const [served, expected] of [
    [2_000, 30_000],
    [45_000, 45_000],
    [1_000_000_000, 600_000],
    ['45000', 30_000],
    [null, 30_000],
    [2.5, 30_000],
    [Number.NaN, 30_000],
    [-1, 30_000],
  ]) {
    assert.equal(followRefreshMs(served), expected)
  }
})

test('readFollowRefreshMs reads the public talk check once', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({
      line_marker: '0',
      check_interval_ms: 45_000,
      listening: [],
      listening_page: { total_items: 0, returned_items: 0, has_more: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  assert.equal(await readFollowRefreshMs(fetchImpl), 45_000)
  assert.deepEqual(calls.map(call => call.url), ['https://1f3d9.com/api/talk/now'])
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.authorization, undefined)
})

test('readFollowRefreshMs keeps the default after a failed city response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 })

  assert.equal(await readFollowRefreshMs(fetchImpl), 30_000)
})

test('readFollowRefreshMs keeps the default when the city read throws', async () => {
  const fetchImpl = async () => {
    throw new Error('offline')
  }

  assert.equal(await readFollowRefreshMs(fetchImpl), 30_000)
})
