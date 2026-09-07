// One authenticated read shared by `connect`, `key status`, and setup.mjs's
// vault-adopt guard: it proves a stored resident key still works, and (via
// the returned handle) whether it actually authenticates as the resident
// the vault entry is labelled under, without ever printing the key itself.
// This is GET /api/me, not a side-effect-free probe: the served contract
// states plainly that "ordinary GET /api/me remains state-changing, wakes
// due timers, and advances its private fee-credit last-read marker" -- so
// every call site above says so too, rather than calling this "harmless".
// It stays GET /api/me (not the passive POST /api/me
// {"mode":"later_holder_notice"} read) because every current caller needs
// the handle this read returns to detect a mismatched vault label; the
// passive read's own contract does not return one. Never throws — callers
// get { ok, handle, error, status, rejected } and decide what to say.

import { assertAllowedOrigin } from './origin-guard.mjs'
import { sanitizeServerProse } from './identity-http.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

// The city server's exact GET /api/me credential refusal. check:live-truth
// pins this unpublished string anonymously so a server reword fails closed.
export const CITY_REJECTION_MESSAGE = 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>'

export async function probeMe(origin, residentKey, { timeoutMs = DEFAULT_TIMEOUT_MS, allowOrigin } = {}) {
  let safeOrigin
  try {
    safeOrigin = assertAllowedOrigin(origin, { allowOrigin })
  } catch (error) {
    return { ok: false, error: error.message, rejected: false }
  }
  try {
    const response = await fetch(`${safeOrigin}/api/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${residentKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // Read redirects without following them so the key is never sent on.
      redirect: 'manual',
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      let destination = 'an unspecified address'
      if (location) {
        try {
          const target = new URL(location, `${safeOrigin}/api/me`)
          destination = ['http:', 'https:'].includes(target.protocol) ? target.origin : 'an unreadable address'
          if (destination.toLowerCase().includes(residentKey.toLowerCase())) {
            destination = 'an address containing a private value'
          }
        } catch {
          destination = 'an unreadable address'
        }
      }
      await response.body?.cancel().catch(() => {})
      return {
        ok: false,
        error: `the city answered with a redirect to ${destination}; the key was not sent on; the probe did not happen`,
        rejected: false,
      }
    }
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      // handled below
    }
    if (!response.ok || !parsed) {
      const error = sanitizeServerProse(parsed?.error) || `HTTP ${response.status}`
      return {
        ok: false,
        error,
        status: response.status,
        rejected: response.status === 401 && parsed != null && parsed.error === CITY_REJECTION_MESSAGE,
      }
    }
    return {
      ok: true,
      handle: parsed.handle ?? null,
      sinceLastVisit: parsed.since_last_visit,
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), rejected: false }
  }
}
