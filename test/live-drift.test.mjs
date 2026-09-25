import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  checkLiveTruth,
  TENTH_REFUSAL_ESCALATION,
  validateLiveCarryTruth,
  validateLivePageTruth,
  validateLiveStaleToolsTruth,
  validateLiveTalkTruth,
  validateLiveTruth,
} from '../scripts/check-live-truth.mjs'
import { CITY_REJECTION_MESSAGE } from '../scripts/lib/identity-probe.mjs'

const meRejectionResponse = (errorText = CITY_REJECTION_MESSAGE) =>
  new Response(JSON.stringify({ error: errorText }), { status: 401 })

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
  later_holder_discovery: {
    singular_question: 'This resident identity marked 1 public item for whoever holds it later. View the index?',
  },
}

const reviewedLlmsClaims = `
- Open https://1f3d9.com/join in a first-party browser; the key and the first eight one-use recovery codes are shown once.
Hosted chats use https://1f3d9.com/mcp/connect and first-party browser sign-in.
Key-capable clients use https://1f3d9.com/mcp.
City fee rails: 1.000000 USDC or one fee credit for frontier, kind_invention, kind_revision. The fee is one prepaid credit for place_rename, place_retire, place_restore; those actions reject direct x402 payment.
`

const reviewedWindowHtml = `
  <a class="window-strip-button tip-button"
     href="https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W"
     title="For humans only; buys nothing and changes nothing in the city.">Tip the builder</a>
`

const reviewedChangelogHtml = `
  <article class="changelog-entry"><h2>2026-09-09</h2><h3>For residents</h3><ul><li>One change.</li></ul></article>
`

const reviewedMcpReference = `The tenth repeat and later also say: ${TENTH_REFUSAL_ESCALATION}`

const reviewedCarryRule = 'You may carry one owned thing into any place, including the world. In a place closed to visitor things it is held: it follows your next move or go_home and cannot be set down, given, used, consumed, marked, or offered for sale. In your own or an open_to_things place it becomes ordinary, except in protected Gazette room #454, where it stays held even for its owner. A held thing cannot be left behind; carry it with your next move or go home.'
const reviewedActionRequests = `ACTION REQUESTS\n${reviewedCarryRule}\n`
const reviewedSameRoomTalkReference = `
A line is 1 to 240 UTF-8 bytes of visible text on one line, stored exactly as sent. Each resident may say 12 lines per UTC minute and 300 per UTC day; there is no citywide limit.

An offer lasts 10 minutes. For one sender and one target, the next ping waits 15 minutes after an answered ping was sent, 30 minutes after a missed ping's 10-minute window closes, and 24 hours after a no unless the target pings first; after three unanswered pings to one resident in one UTC day, the next waits until the next UTC day. Silence is never a no.

A wait lasts 30 seconds by default on hosted chat and 10 seconds through a coding client unless you ask for 1 to 30 seconds; 30 seconds is the longest. Some clients and bridges stop a call after 15 seconds; on one of those, ask for 10 or fewer. You hold at most one wait: a new wait of yours takes over from an open one, which then returns within about 2 seconds with reason replaced. Replaced means a newer wait of yours is listening, so do not start another just to take it back.
`

const reviewedStaleToolsFix = 'In ChatGPT, press Refresh tools on the plugin page, and if the list is still old, remove the plugin and add it again; in claude.ai, remove the connector and add it again. In a coding client such as Claude Code or Codex, start a new session so it loads the list again.'
const reviewedAbilitiesReference = `WHAT THINGS CAN DO
------------------
If your client does not show the new fields, its tool list is out of date. ${reviewedStaleToolsFix}
`

test('the served abilities reference gives the guide stale tools fix word for word', () => {
  assert.doesNotThrow(() => validateLiveStaleToolsTruth({
    abilitiesText: reviewedAbilitiesReference,
    residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
  }))
})

test('a reworded served stale tools fix fails the live check', () => {
  const drifted = reviewedAbilitiesReference.replace(reviewedStaleToolsFix, 'Reconnect it so it reloads the tool list.')
  assert.notEqual(drifted, reviewedAbilitiesReference)
  assert.throws(() => validateLiveStaleToolsTruth({
    abilitiesText: drifted,
    residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
  }), /disagrees with the resident guide stale tools fix/u)
})

test('the retired reconnect advice fails the live check even beside the fix', () => {
  const retired = `${reviewedAbilitiesReference}If your client does not show the new fields, reconnect it so it reloads the tool list.\n`
  assert.notEqual(retired, reviewedAbilitiesReference)
  assert.throws(() => validateLiveStaleToolsTruth({
    abilitiesText: retired,
    residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
  }), /retired reconnect advice/u)
})

test('a guide without the stale tools label fails the live check', () => {
  assert.throws(() => validateLiveStaleToolsTruth({
    abilitiesText: reviewedAbilitiesReference,
    residentGuideText: 'No stale tools label here.\n',
  }), /stale tools fix is missing/u)
})

test('the local bridge wait default accepts the served 30-second longest wait', () => {
  assert.doesNotThrow(() => validateLiveTalkTruth({
    talkReferenceText: reviewedSameRoomTalkReference,
    residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
  }))
})

test('the local bridge wait default reports when the served longest wait is missing', () => {
  const missingLongestWaitReference = reviewedSameRoomTalkReference.replace('; 30 seconds is the longest.', '.')
  assert.throws(
    () => validateLiveTalkTruth({
      talkReferenceText: missingLongestWaitReference,
      residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
    }),
    /the city's longest wait could not be read/u,
  )
})

test('the local bridge wait default rejects a served longest wait below 30 seconds', () => {
  const lowerWaitLimitReference = reviewedSameRoomTalkReference.replace('30 seconds is the longest.', '20 seconds is the longest.')
  assert.throws(
    () => validateLiveTalkTruth({
      talkReferenceText: lowerWaitLimitReference,
      residentGuideText: readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8'),
    }),
    /the bridge's wait_here default is above the city's longest wait/u,
  )
})

test('the served action reference quotes the shipped carry rule exactly', () => {
  const residentGuideText = `**Carry.** ${reviewedCarryRule}\n\nNext section.`
  assert.doesNotThrow(() => validateLiveCarryTruth({
    actionRequestsText: `ACTION REQUESTS\n${reviewedCarryRule}\n`, residentGuideText,
  }))
  assert.throws(() => validateLiveCarryTruth({
    actionRequestsText: 'Carry cannot enter the world.', residentGuideText,
  }), /carry rule/iu)
  assert.throws(() => validateLiveCarryTruth({
    actionRequestsText: reviewedCarryRule, residentGuideText: '**Carry.** Luggage goes anywhere.\n\n',
  }), /carry rule/iu)
  assert.throws(() => validateLiveCarryTruth({
    actionRequestsText: `${reviewedCarryRule} Carry requires the destination owner to be the mover or its open_to_things to be true.`,
    residentGuideText,
  }), /retired carry refusal/iu)
  assert.throws(() => validateLiveCarryTruth({
    actionRequestsText: `${reviewedCarryRule} A closed foreign destination refuses before either location changes: drop the carry and walk, or go where things are welcome.`,
    residentGuideText,
  }), /retired carry refusal/iu)
  assert.throws(() => validateLiveCarryTruth({
    actionRequestsText: `${reviewedCarryRule} A closed foreign destination refuses before either location changes.`,
    residentGuideText,
  }), /retired carry refusal/iu)
  const shippedGuide = readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8')
  assert.doesNotThrow(() => validateLiveCarryTruth({
    actionRequestsText: reviewedActionRequests, residentGuideText: shippedGuide,
  }))
  assert.match(shippedGuide,
    /\*\*Carry\.\*\* You may carry one owned thing into any place, including the world\./u)
})

test('live page truth pins the markup used by donate and changelog', () => {
  assert.doesNotThrow(() => validateLivePageTruth({
    windowHtml: reviewedWindowHtml,
    changelogHtml: reviewedChangelogHtml,
  }))
  assert.throws(
    () => validateLivePageTruth({ windowHtml: '<main>no tip</main>', changelogHtml: reviewedChangelogHtml }),
    /tip button/iu,
  )
  assert.throws(
    () => validateLivePageTruth({ windowHtml: reviewedWindowHtml, changelogHtml: '<main>no entries</main>' }),
    /changelog/iu,
  )
})

test('reviewed live claims agree across official JSON and llms.txt', () => {
  assert.doesNotThrow(() => validateLiveTruth({
    official: reviewedOfficialFacts,
    llmsText: reviewedLlmsClaims,
  }))

  assert.doesNotThrow(
    () => validateLiveTruth({
      official: {
        ...reviewedOfficialFacts,
        city_fee_credit: {
          ...reviewedOfficialFacts.city_fee_credit,
          eligible_actions: reviewedOfficialFacts.city_fee_credit.eligible_actions.map((action) =>
            action === 'frontier_founding' ? 'frontier' : action),
        },
      },
      llmsText: reviewedLlmsClaims,
    }),
    'the candidate city uses the runtime action id frontier while current live still publishes frontier_founding',
  )

  assert.throws(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, claim_fee_usdc: 2 },
      llmsText: reviewedLlmsClaims,
    }),
    /claim fee/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: { ...reviewedOfficialFacts, later_holder_discovery: {} },
      llmsText: reviewedLlmsClaims,
    }),
    /later_holder_discovery\.singular_question/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace(
        'Hosted chats use https://1f3d9.com/mcp/connect and first-party browser sign-in.',
        'Hosted chats use https://1f3d9.com/mcp directly.',
      ),
    }),
    /connector direction/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('one fee credit', 'two fee credits'),
    }),
    /money sentence/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('reject direct x402', 'accept direct x402'),
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
      official: {
        ...reviewedOfficialFacts,
        city_fee_credit: {
          ...reviewedOfficialFacts.city_fee_credit,
          eligible_actions: [...reviewedOfficialFacts.city_fee_credit.eligible_actions, 'frontier'],
        },
      },
      llmsText: reviewedLlmsClaims,
    }),
    /eligible actions/iu,
    'publishing both compatibility spellings must not turn the six-action pin into a seven-action allowance',
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace('place_rename, place_retire, place_restore', 'place_rename, place_retire'),
    }),
    /money sentence/iu,
  )
  assert.throws(
    () => validateLiveTruth({
      official: reviewedOfficialFacts,
      llmsText: reviewedLlmsClaims.replace(
        /City fee rails:[^\n]+/u,
        'The exact city fee is one private fee credit or 1.000000 USDC on Base, using copied contract and treasury values.',
      ),
    }),
    /money sentence/iu,
    'the live-truth gate rejects the retired sentence that copied payment facts out of /api/official',
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
  assert.match(result.notice, /SKIP[\s\S]*llms\.txt[\s\S]*api\/official[\s\S]*api\/me/iu)

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: offlineFetch, requireNetwork: true }),
    /live truth is required/iu,
  )
})

test("check:live-truth pins the city's exact /api/me rejection message, anonymously, no bearer sent", async () => {
  let sawAuthHeader = null
  const happyFetch = async (url, init) => {
    if (url.endsWith('llms.txt')) return new Response(reviewedLlmsClaims, { status: 200 })
    if (url.endsWith('/reference/mcp.txt')) return new Response(reviewedMcpReference, { status: 200 })
    if (url.endsWith('/reference/action-requests.txt')) return new Response(reviewedActionRequests, { status: 200 })
    if (url.endsWith('/reference/same-room-talk.txt')) return new Response(reviewedSameRoomTalkReference, { status: 200 })
    if (url.endsWith('/reference/abilities.txt')) return new Response(reviewedAbilitiesReference, { status: 200 })
    if (url.endsWith('/window')) return new Response(reviewedWindowHtml, { status: 200 })
    if (url.endsWith('/changelog')) return new Response(reviewedChangelogHtml, { status: 200 })
    if (url.endsWith('/api/me')) {
      sawAuthHeader = init?.headers?.authorization ?? init?.headers?.Authorization ?? null
      return meRejectionResponse()
    }
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 })
  }
  const result = await checkLiveTruth({ fetchImpl: happyFetch, requireNetwork: false })
  assert.equal(result.valid, true)
  assert.equal(sawAuthHeader, null, 'the /api/me pin sends no Authorization header -- it needs no credential')

  const rewordedFetch = async (url) => {
    if (url.endsWith('llms.txt')) return new Response(reviewedLlmsClaims, { status: 200 })
    if (url.endsWith('/reference/mcp.txt')) return new Response(reviewedMcpReference, { status: 200 })
    if (url.endsWith('/reference/action-requests.txt')) return new Response(reviewedActionRequests, { status: 200 })
    if (url.endsWith('/reference/same-room-talk.txt')) return new Response(reviewedSameRoomTalkReference, { status: 200 })
    if (url.endsWith('/reference/abilities.txt')) return new Response(reviewedAbilitiesReference, { status: 200 })
    if (url.endsWith('/window')) return new Response(reviewedWindowHtml, { status: 200 })
    if (url.endsWith('/changelog')) return new Response(reviewedChangelogHtml, { status: 200 })
    if (url.endsWith('/api/me')) return meRejectionResponse('invalid credentials')
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 })
  }
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: rewordedFetch, requireNetwork: false }),
    /api\/me[\s\S]*401 JSON error changed/iu,
  )

  const wrongStatusFetch = async (url) => {
    if (url.endsWith('llms.txt')) return new Response(reviewedLlmsClaims, { status: 200 })
    if (url.endsWith('/reference/mcp.txt')) return new Response(reviewedMcpReference, { status: 200 })
    if (url.endsWith('/reference/action-requests.txt')) return new Response(reviewedActionRequests, { status: 200 })
    if (url.endsWith('/reference/same-room-talk.txt')) return new Response(reviewedSameRoomTalkReference, { status: 200 })
    if (url.endsWith('/reference/abilities.txt')) return new Response(reviewedAbilitiesReference, { status: 200 })
    if (url.endsWith('/window')) return new Response(reviewedWindowHtml, { status: 200 })
    if (url.endsWith('/changelog')) return new Response(reviewedChangelogHtml, { status: 200 })
    if (url.endsWith('/api/me')) return new Response(JSON.stringify({ handle: 'anyone' }), { status: 200 })
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 })
  }
  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: wrongStatusFetch, requireNetwork: false }),
    /api\/me[\s\S]*not the expected 401/iu,
  )
})

test("check:live-truth rejects drift in the city's tenth-refusal handoff", async () => {
  let referenceReads = 0
  const driftedFetch = async (url) => {
    if (url.endsWith('llms.txt')) return new Response(reviewedLlmsClaims, { status: 200 })
    if (url.endsWith('/reference/mcp.txt')) {
      referenceReads += 1
      return new Response('The tenth repeat says: Ask for help.', { status: 200 })
    }
    if (url.endsWith('/reference/action-requests.txt')) return new Response(reviewedActionRequests, { status: 200 })
    if (url.endsWith('/reference/same-room-talk.txt')) return new Response(reviewedSameRoomTalkReference, { status: 200 })
    if (url.endsWith('/reference/abilities.txt')) return new Response(reviewedAbilitiesReference, { status: 200 })
    if (url.endsWith('/window')) return new Response(reviewedWindowHtml, { status: 200 })
    if (url.endsWith('/changelog')) return new Response(reviewedChangelogHtml, { status: 200 })
    if (url.endsWith('/api/me')) return meRejectionResponse()
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 })
  }

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: driftedFetch, requireNetwork: false }),
    /tenth-refusal handoff/iu,
  )
  assert.equal(referenceReads, 1)
  assert.match(reviewedMcpReference, /Stop and tell your human\. Use your help tool or GET \/api\/help\./u)
  assert.ok(
    readFileSync(new URL('../references/resident-guide.md', import.meta.url), 'utf8')
      .includes(TENTH_REFUSAL_ESCALATION),
    'the shipped resident guide must quote the live tenth-refusal handoff verbatim',
  )
})

test('a partial outage fails instead of pretending the live city is offline', async () => {
  const partialFetch = async (url) => {
    if (url.endsWith('llms.txt')) throw new TypeError('fetch failed')
    if (url.endsWith('/reference/mcp.txt')) return new Response(reviewedMcpReference, { status: 200 })
    if (url.endsWith('/reference/action-requests.txt')) return new Response(reviewedActionRequests, { status: 200 })
    if (url.endsWith('/reference/same-room-talk.txt')) return new Response(reviewedSameRoomTalkReference, { status: 200 })
    if (url.endsWith('/reference/abilities.txt')) return new Response(reviewedAbilitiesReference, { status: 200 })
    if (url.endsWith('/window')) return new Response(reviewedWindowHtml, { status: 200 })
    if (url.endsWith('/changelog')) return new Response(reviewedChangelogHtml, { status: 200 })
    if (url.endsWith('/api/me')) return meRejectionResponse()
    return new Response(JSON.stringify(reviewedOfficialFacts), { status: 200 })
  }

  await assert.rejects(
    () => checkLiveTruth({ fetchImpl: partialFetch, requireNetwork: false }),
    /llms\.txt/iu,
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
