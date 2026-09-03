import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const endpoints = {
  llms: 'https://1f3d9.com/llms.txt',
  official: 'https://1f3d9.com/api/official',
}

const reviewed = {
  treasury: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  network: 'base',
  usdcContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  claimFeeUsdc: 1,
  unitUsdc: '1.000000',
  // Actions that accept either rail (prepaid city fee credit or direct x402).
  dualRailActions: ['frontier_founding', 'kind_invention', 'kind_revision'],
  // Actions that require exactly one prepaid city fee credit and refuse direct x402 (decision #68).
  creditOnlyActions: ['place_rename', 'place_retire', 'place_restore'],
}

// Human-readable phrasing the llms.txt money sentence is expected to use per action id.
const actionLabels = {
  frontier_founding: /frontier founding/iu,
  kind_invention: /kind invention/iu,
  kind_revision: /kind revision/iu,
  place_rename: /place rename/iu,
  place_retire: /retir(?:e|ement)/iu,
  place_restore: /restor(?:e|ation)/iu,
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

  const feeCredit = official.city_fee_credit
  requireClaim(feeCredit && typeof feeCredit === 'object', 'official city_fee_credit is missing')
  requireClaim(feeCredit.unit_usdc === reviewed.unitUsdc, 'city fee credit unit must be 1.000000 USDC')

  const knownActions = [...reviewed.dualRailActions, ...reviewed.creditOnlyActions].sort()
  const officialActions = [...(feeCredit.eligible_actions ?? [])].sort()
  requireClaim(
    JSON.stringify(officialActions) === JSON.stringify(knownActions),
    'official eligible actions changed; update the reviewed action groups and llms.txt money sentence',
  )

  const normalizedLlms = compact(llmsText)
  const moneyLine = llmsText.split(/\r?\n/u).find((entry) => /the exact city fee is/iu.test(entry))
  requireClaim(Boolean(moneyLine), 'llms.txt money sentence disagrees with /api/official (sentence not found)')
  const moneySentence = compact(moneyLine)

  requireClaim(
    moneySentence.includes(`\`${official.usdc_contract}\``),
    'llms.txt money sentence disagrees with /api/official (USDC contract)',
  )
  requireClaim(
    moneySentence.includes(`\`${official.treasury}\``),
    'llms.txt money sentence disagrees with /api/official (treasury)',
  )
  requireClaim(
    moneySentence.includes(`${feeCredit.unit_usdc} USDC`),
    'llms.txt money sentence disagrees with /api/official (unit)',
  )
  requireClaim(
    /one private fee credit/iu.test(moneySentence),
    'llms.txt money sentence disagrees with /api/official (prepaid credit rail)',
  )

  const [acceptClause = '', refuseClause = ''] = moneySentence.split(/,?\s+while\s+/iu)
  requireClaim(
    refuseClause.length > 0,
    'llms.txt money sentence disagrees with /api/official (missing credit-only clause)',
  )
  requireClaim(
    /accept either rail/iu.test(acceptClause),
    'llms.txt money sentence disagrees with /api/official (dual-rail actions must accept either rail)',
  )
  requireClaim(
    /refuses? direct x402/iu.test(refuseClause) && /prepaid city fee credit/iu.test(refuseClause),
    'llms.txt money sentence disagrees with /api/official (credit-only actions must refuse direct x402)',
  )
  for (const action of reviewed.dualRailActions) {
    requireClaim(
      actionLabels[action].test(acceptClause),
      `llms.txt money sentence disagrees with /api/official (missing dual-rail action ${action})`,
    )
  }
  for (const action of reviewed.creditOnlyActions) {
    requireClaim(
      actionLabels[action].test(refuseClause),
      `llms.txt money sentence disagrees with /api/official (missing credit-only action ${action})`,
    )
  }

  requireClaim(
    /connector support uses exactly https:\/\/1f3d9\.com\/mcp\/connect/iu.test(normalizedLlms)
      && /key-capable local clients.{0,160}?https:\/\/1f3d9\.com\/mcp\b/isu.test(normalizedLlms),
    'connector direction must keep /mcp/connect for hosted chat and /mcp for key-capable local clients',
  )
  requireClaim(
    /(?:key and the first|signup already creates the first) eight one-use recovery codes/iu.test(normalizedLlms),
    'recovery-code count must remain eight',
  )
}

const fetchText = async (url, fetchImpl) => {
  let response
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: { accept: url.endsWith('.txt') ? 'text/plain' : 'application/json' },
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
  ])
  const failures = results.filter((result) => result.status === 'rejected')

  if (failures.length > 0) {
    const bothUnavailable = failures.length === 2
      && failures.every((result) => result.reason instanceof FetchUnavailableError)
    if (bothUnavailable && !requireNetwork) {
      return {
        skipped: true,
        notice: `SKIP live truth: ${endpoints.llms} and ${endpoints.official} are offline (${failureMessage(results)})`,
      }
    }
    const prefix = requireNetwork ? 'live truth is required; ' : ''
    throw new Error(`${prefix}${failureMessage(results)}`)
  }

  const [llmsText, officialText] = results.map((result) => result.value)
  let official
  try {
    official = JSON.parse(officialText)
  } catch (error) {
    throw new Error(`${endpoints.official}: malformed JSON (${error.message})`)
  }
  validateLiveTruth({ official, llmsText })
  return { valid: true }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  try {
    const result = await checkLiveTruth({ requireNetwork: process.env.REQUIRE_LIVE_TRUTH === '1' })
    console.log(result.skipped ? result.notice : 'Live truth check passed for llms.txt and /api/official.')
  } catch (error) {
    console.error(`Live truth check failed: ${error.message}`)
    process.exitCode = 1
  }
}
