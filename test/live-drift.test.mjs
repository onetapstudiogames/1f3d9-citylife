import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkLiveTruth,
  validateLiveTruth,
} from '../scripts/check-live-truth.mjs'

const reviewedOfficialFacts = {
  domain: 'https://1f3d9.com',
  treasury: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  network: 'base',
  usdc_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  claim_fee_usdc: 1,
}

const reviewedLlmsClaims = `
- Open https://1f3d9.com/join in a first-party browser; the key and the first eight one-use recovery codes are shown once.
- ChatGPT browser sign-in uses exactly https://1f3d9.com/mcp/connect; https://1f3d9.com/mcp is only for key-capable local clients.
- The exact city fee is 1.000000 USDC on Base, using USDC contract \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` and treasury recipient \`0x3b9d230c9b995fb1a10add2d63ce37437916dcfd\`; it pays only for the reviewed claims.
`

test('reviewed live claims agree across official JSON and llms.txt', () => {
  assert.doesNotThrow(() => validateLiveTruth({
    official: reviewedOfficialFacts,
    llmsText: reviewedLlmsClaims,
  }))

  assert.throws(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, claim_fee_usdc: 2 },
      llmsText: reviewedLlmsClaims,
    }),
    /claim fee/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace(
        'ChatGPT browser sign-in uses exactly https://1f3d9.com/mcp/connect; https://1f3d9.com/mcp is only for key-capable local clients.',
        'ChatGPT uses https://1f3d9.com/mcp and local clients use https://1f3d9.com/mcp/connect.',
      ),
    }),
    /connector direction/iu,
  )
})

test('offline live checks skip honestly only outside required-network CI', async () => {
  const offlineFetch = async () => {
    throw new TypeError('fetch failed')
  }

  const result = await checkLiveTruth({ fetchImpl: offlineFetch, requireNetwork: false })
  assert.equal(result.skipped, true)
  assert.match(result.notice, /SKIP[\s\S]*llms\.txt[\s\S]*api\/official/iu)

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: offlineFetch, requireNetwork: true }),
    /live truth is required/iu,
  )
})

test('a missing fetch implementation fails instead of pretending the network is offline', async () => {
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: null, requireNetwork: false }),
    /requires a fetch implementation/iu,
  )
})

test('the served city facts still match the skill release baseline', async (t) => {
  const result = await checkLiveTruth({
    requireNetwork: process.env.REQUIRE_LIVE_TRUTH === '1',
  })

  if (result.skipped) {
    t.skip(result.notice)
    return
  }

  assert.equal(result.valid, true)
})
