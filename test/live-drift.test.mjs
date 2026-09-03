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
  identity: {
    coding_client_json: {
      doors_enabled: true,
    },
  },
  city_fee_credit: {
    unit_usdc: '1.000000',
    eligible_actions: [
      'frontier_founding',
      'kind_invention',
      'kind_revision',
      'place_rename',
      'place_retire',
      'place_restore',
    ],
  },
}

const reviewedLlmsClaims = `
- Open https://1f3d9.com/join in a first-party browser; the key and the first eight one-use recovery codes are shown once.
- Hosted chat with connector support uses exactly https://1f3d9.com/mcp/connect and keeps the key outside chat.
- Key-capable local clients POST JSON-RPC 2.0 to https://1f3d9.com/mcp and pass the bearer secret only in the HTTP Authorization header.
- The exact city fee is one private fee credit or 1.000000 USDC on Base, using USDC contract \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` and treasury recipient \`0x3b9d230c9b995fb1a10add2d63ce37437916dcfd\`; frontier founding, kind invention, and kind revision accept either rail, while place rename, retirement, and restoration require exactly one prepaid city fee credit and refuse direct x402
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
        'Hosted chat with connector support uses exactly https://1f3d9.com/mcp/connect and keeps the key outside chat.',
        'Hosted chat uses https://1f3d9.com/mcp directly.',
      ),
    }),
    /connector direction/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('one private fee credit or ', ''),
    }),
    /money sentence/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('refuse direct x402', 'accept direct x402'),
    }),
    /money sentence/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: {
        ...reviewedOfficialFacts,
        city_fee_credit: {
          ...reviewedOfficialFacts.city_fee_credit,
          eligible_actions: [...reviewedOfficialFacts.city_fee_credit.eligible_actions, 'place_relocate'],
        },
      },
      llmsText: reviewedLlmsClaims,
    }),
    /eligible actions/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('place rename, retirement, and restoration', 'place rename and retirement'),
    }),
    /money sentence/iu,
  )
  // Round-5 finding 4: a city-side rename or restructuring of
  // identity.coding_client_json.doors_enabled must fail this check, not
  // silently disable the dormant-doors pre-check readCodingDoorsEnabled
  // performs (see official-doors.mjs and setup.mjs's confirmHumanApproval).
  assert.throws(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, identity: { coding_client_json: {} } },
      llmsText: reviewedLlmsClaims,
    }),
    /doors_enabled/iu,
    'a missing doors_enabled field must fail the release gate',
  )
  assert.throws(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, identity: { coding_client_json: { doors_enabled: 'true' } } },
      llmsText: reviewedLlmsClaims,
    }),
    /doors_enabled/iu,
    'a non-boolean doors_enabled value must fail the release gate',
  )
  assert.doesNotThrow(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, identity: { coding_client_json: { doors_enabled: false } } },
      llmsText: reviewedLlmsClaims,
    }),
    'this is a shape assertion only -- doors_enabled: false is a valid boolean and must still pass',
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
