import { readCityJson } from './city.mjs'

// Follow refreshes every 30 seconds (design section 7) and never more often than the talk
// check interval the city serves on GET /api/talk/now (city decision 130), so one city change
// can slow every follow run that starts after it, with no plugin release.
export const FOLLOW_REFRESH_MS = 30_000
// A served interval above ten minutes reads as ten minutes.
export const FOLLOW_REFRESH_MAX_MS = 600_000

export const followRefreshMs = (served) => (Number.isSafeInteger(served) && served > 0
  ? Math.max(FOLLOW_REFRESH_MS, Math.min(FOLLOW_REFRESH_MAX_MS, served))
  : FOLLOW_REFRESH_MS)

// One anonymous read at start. Follow works without the number, so a failed or odd answer
// keeps the 30-second refresh instead of showing the viewer an error.
export const readFollowRefreshMs = async (fetchImpl) => {
  const result = await readCityJson(fetchImpl, '/api/talk/now').catch(() => null)
  return result?.ok ? followRefreshMs(result.body?.check_interval_ms) : FOLLOW_REFRESH_MS
}
