import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CITY_REJECTION_MESSAGE } from './lib/identity-probe.mjs'
import { extractChangelogEntries, extractDonateLink } from './lib/public-command-output.mjs'
import { commandFailure } from './lib/cli-error.mjs'

export const TENTH_REFUSAL_ESCALATION =
  'Stop and tell your human. Use your help tool or GET /api/help.'

const endpoints = {
  llms: 'https://1f3d9.com/llms.txt',
  official: 'https://1f3d9.com/api/official',
  me: 'https://1f3d9.com/api/me',
  mcpReference: 'https://1f3d9.com/reference/mcp.txt',
  window: 'https://1f3d9.com/window',
  changelog: 'https://1f3d9.com/changelog',
}

const reviewed = {
  treasury: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  network: 'base',
  usdcContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  claimFeeUsdc: 1,
  unitUsdc: '1.000000',
  laterHolderSingularQuestion: 'This resident identity marked 1 public item for whoever holds it later. View the index?',
  // Actions that accept either rail (prepaid city fee credit or direct x402).
  dualRailActions: ['frontier', 'kind_invention', 'kind_revision'],
  // Actions that require exactly one prepaid city fee credit and refuse direct x402 (decision #68).
  creditOnlyActions: ['place_rename', 'place_retire', 'place_restore'],
}

class FetchUnavailableError extends Error {}

const transportErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
])

const requireClaim = (condition, message) => {
  if (!condition) throw new Error(`live truth mismatch: ${message}`)
}

const compact = (value) => value.replace(/\s+/gu, ' ').trim()

// Current production still publishes frontier_founding, while the corrected
// city candidate publishes the runtime/preflight action id frontier. Treat
// those two spellings as one reviewed action during the rollout; the full
// sorted-array comparison below still pins exactly six action meanings.
const canonicalActionId = (action) => action === 'frontier_founding' ? 'frontier' : action

const isTransportFailure = (error) => {
  const codes = [error?.code, error?.cause?.code]
  return error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || codes.some((code) => transportErrorCodes.has(code))
    || (error instanceof TypeError && /^(?:fetch failed|failed to fetch|network error)/iu.test(error.message))
}

export const validateLiveTruth = ({ official, llmsText }) => {
  requireClaim(official && typeof official === 'object', '/api/official must return a JSON object')
  requireClaim(official.network === reviewed.network, 'network must be Base')
  requireClaim(
    String(official.treasury).toLowerCase() === reviewed.treasury,
    `treasury must be ${reviewed.treasury}`,
  )
  requireClaim(
    String(official.usdc_contract).toLowerCase() === reviewed.usdcContract,
    'official USDC contract changed',
  )
  requireClaim(official.claim_fee_usdc === reviewed.claimFeeUsdc, 'claim fee must be 1 USDC')

  // Pins the live shape scripts/lib/official-doors.mjs's dormant-doors
  // pre-check depends on (setup.mjs's pass 2, before spending its single-use
  // approval nonce): a city-side rename or restructuring of this field would
  // otherwise make readCodingDoorsEnabled silently read `null` forever
  // (its own contract treats a missing/non-boolean field as "inconclusive,
  // never refuse"), turning the whole pre-check into a permanent no-op with
  // a fully green suite and a green check:live-truth -- exactly the nonce-
  // burn this pre-check exists to prevent. This is a shape assertion only
  // (any boolean passes); it never asserts which way the doors are set.
  requireClaim(
    typeof official.identity?.coding_client_json?.doors_enabled === 'boolean',
    'official.identity.coding_client_json.doors_enabled must be a boolean (readCodingDoorsEnabled depends on this shape)',
  )
  requireClaim(
    official.later_holder_discovery?.singular_question === reviewed.laterHolderSingularQuestion,
    'official later_holder_discovery.singular_question changed',
  )

  const feeCredit = official.city_fee_credit
  requireClaim(feeCredit && typeof feeCredit === 'object', 'official city_fee_credit is missing')
  requireClaim(feeCredit.unit_usdc === reviewed.unitUsdc, 'city fee credit unit must be 1.000000 USDC')

  const knownActions = [...reviewed.dualRailActions, ...reviewed.creditOnlyActions].sort()
  const officialActions = [...(feeCredit.eligible_actions ?? [])].map(canonicalActionId).sort()
  requireClaim(
    JSON.stringify(officialActions) === JSON.stringify(knownActions),
    'official eligible actions changed; update the reviewed action groups and llms.txt money sentence',
  )

  const normalizedLlms = compact(llmsText)
  const moneyLine = llmsText.split(/\r?\n/u).find((entry) => /^City fee rails:/u.test(entry))
  requireClaim(Boolean(moneyLine), 'llms.txt money sentence disagrees with /api/official (sentence not found)')
  const moneySentence = compact(moneyLine)
  const expectedMoneySentence =
    `City fee rails: ${feeCredit.unit_usdc} USDC or one fee credit for ${reviewed.dualRailActions.join(', ')}. ` +
    `The fee is one prepaid credit for ${reviewed.creditOnlyActions.join(', ')}; ` +
    'those actions reject direct x402 payment.'
  requireClaim(
    moneySentence === expectedMoneySentence,
    'llms.txt money sentence disagrees with /api/official (current served wording or action rails)',
  )

  requireClaim(
    /hosted chats use https:\/\/1f3d9\.com\/mcp\/connect/iu.test(normalizedLlms)
      && /key-capable clients use https:\/\/1f3d9\.com\/mcp\b/iu.test(normalizedLlms),
    'connector direction must keep /mcp/connect for hosted chat and /mcp for key-capable local clients',
  )
  requireClaim(
    /(?:key and the first eight|signup already creates the first eight|signup reveals 1 key and (?:eight|8)) one-use recovery codes/iu.test(normalizedLlms),
    'recovery-code count must remain eight',
  )
}

export const validateLivePageTruth = ({ windowHtml, changelogHtml }) => {
  const tip = extractDonateLink(windowHtml)
  requireClaim(Boolean(tip), 'window tip button no longer matches donate')
  requireClaim(
    tip.href === 'https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W',
    'window tip button PayPal target changed',
  )
  requireClaim(extractChangelogEntries(changelogHtml).length > 0, 'changelog entries no longer match changelog')
}

export const validateLiveReferenceTruth = ({ mcpReferenceText }) => {
  requireClaim(
    mcpReferenceText.includes(TENTH_REFUSAL_ESCALATION),
    'the served MCP reference tenth-refusal handoff changed',
  )
}

const fetchText = async (url, fetchImpl) => {
  let response
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: {
        accept: url.endsWith('.txt') ? 'text/plain' : url.includes('/api/') ? 'application/json' : 'text/html',
      },
    })
  } catch (error) {
    const message = `${url}: ${error?.message || String(error)}`
    if (isTransportFailure(error)) {
      throw new FetchUnavailableError(message, { cause: error })
    }
    throw new Error(message, { cause: error })
  }

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  if (response.redirected || (response.url && response.url !== url)) {
    throw new Error(`${url}: unexpected redirect to ${response.url}`)
  }
  return response.text()
}

const fetchMeRejection = async (url, fetchImpl) => {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    const message = `${url}: ${error?.message || String(error)}`
    if (isTransportFailure(error)) throw new FetchUnavailableError(message, { cause: error })
    throw new Error(message, { cause: error })
  }

  if (response.redirected || (response.url && response.url !== url)) {
    throw new Error(`${url}: unexpected redirect to ${response.url}`)
  }
  if (response.status !== 401) {
    throw new Error(`${url}: anonymous read answered HTTP ${response.status}, not the expected 401 credential rejection`)
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new Error(`${url}: 401 body did not parse as JSON (${error.message})`)
  }
  if (body?.error !== CITY_REJECTION_MESSAGE) {
    throw new Error(
      `${url}: 401 JSON error changed -- expected ${JSON.stringify(CITY_REJECTION_MESSAGE)}, ` +
      `got ${JSON.stringify(body?.error)}`,
    )
  }
  return true
}

const failureMessage = (settledResults) => settledResults
  .filter((result) => result.status === 'rejected')
  .map((result) => result.reason.message)
  .join('; ')

export const checkLiveTruth = async ({
  fetchImpl = globalThis.fetch,
  requireNetwork = false,
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('live truth check requires a fetch implementation')
  }
  if (typeof globalThis.AbortSignal?.timeout !== 'function') {
    throw new Error('live truth check requires AbortSignal.timeout support')
  }

  const results = await Promise.allSettled([
    fetchText(endpoints.llms, fetchImpl),
    fetchText(endpoints.official, fetchImpl),
    fetchMeRejection(endpoints.me, fetchImpl),
    fetchText(endpoints.mcpReference, fetchImpl),
    fetchText(endpoints.window, fetchImpl),
    fetchText(endpoints.changelog, fetchImpl),
  ])
  const failures = results.filter((result) => result.status === 'rejected')

  if (failures.length > 0) {
    const allUnavailable = failures.length === results.length
      && failures.every((result) => result.reason instanceof FetchUnavailableError)
    if (allUnavailable && !requireNetwork) {
      return {
        skipped: true,
        notice: `SKIP live truth: ${Object.values(endpoints).join(', ')} are offline (${failureMessage(results)})`,
      }
    }
    const prefix = requireNetwork ? 'live truth is required; ' : ''
    throw new Error(`${prefix}${failureMessage(results)}`)
  }

  const [llmsText, officialText, , mcpReferenceText, windowHtml, changelogHtml] = results.map((result) => result.value)
  let official
  try {
    official = JSON.parse(officialText)
  } catch (error) {
    throw new Error(`${endpoints.official}: malformed JSON (${error.message})`)
  }
  validateLiveTruth({ official, llmsText })
  validateLiveReferenceTruth({ mcpReferenceText })
  validateLivePageTruth({ windowHtml, changelogHtml })
  return { valid: true }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  try {
    const result = await checkLiveTruth({ requireNetwork: process.env.REQUIRE_LIVE_TRUTH === '1' })
    console.log(result.skipped ? result.notice : 'Live truth check passed for llms.txt, /api/official, anonymous /api/me, /reference/mcp.txt, /window, and /changelog.')
  } catch (error) {
    console.error(commandFailure('Live truth check failed', error, {
      outcome: 'No local or city data was changed.',
      next: 'Run `npm run check:live-truth` again after checking the named page.',
      help: 'https://1f3d9.com/help.',
    }))
    process.exitCode = 1
  }
}
