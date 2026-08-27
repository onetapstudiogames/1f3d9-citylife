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

  const normalizedLlms = compact(llmsText)
  const exactMoneyClaim = compact(
    `The exact city fee is 1.000000 USDC on Base, using USDC contract \`${official.usdc_contract}\` and treasury recipient \`${official.treasury}\`;`,
  )
  requireClaim(normalizedLlms.includes(exactMoneyClaim), 'llms.txt money sentence disagrees with /api/official')
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
