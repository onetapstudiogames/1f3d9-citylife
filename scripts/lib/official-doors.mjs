import { assertAllowedOrigin } from './origin-guard.mjs'

// A single, unauthenticated GET /api/official read, used only by setup.mjs's
// human-approval gate: before spending the single-use approval nonce (pass
// 2 -- see setup.mjs's own header comment on what that token is and is
// not), check whether the coding-client JSON identity doors are actually
// enabled on this deployment right now, so a registration that was always
// going to be refused (decision row 74's own default-off switch; see the
// real door's own comment on why registration deploys ahead of an
// operator turning these doors on) never burns that nonce first. This is
// deliberately NOT a replacement for the real /api/register call's own
// refusal -- a door that goes dormant in the gap between this check and
// that call is still caught there, verbatim, as the backstop.
//
// Carries no resident key or any other secret -- an ordinary public read,
// unlike probeMe (identity-probe.mjs), which authenticates. Never throws:
// a network failure, a non-JSON body, or a missing field is reported back
// as `{ ok: false }` rather than treated as "doors enabled" -- the caller
// must only ever refuse on an EXPLICIT `doorsEnabled === false`, never on a
// failed or inconclusive read (see setup.mjs's own call site).
//
// Runs its OWN assertAllowedOrigin check (not just trusting a caller to
// have already run one) -- the same discipline probeMe (identity-probe.mjs)
// applies to GET /api/me, so this stays a second, self-contained direct-
// fetch site rather than one whose safety depends entirely on setup.mjs
// happening to validate `origin` first. `allowOrigin` mirrors probeMe's own
// parameter of the same name.

const DEFAULT_TIMEOUT_MS = 10_000

export async function readCodingDoorsEnabled(origin, { timeoutMs = DEFAULT_TIMEOUT_MS, allowOrigin } = {}) {
  let safeOrigin
  try {
    safeOrigin = assertAllowedOrigin(origin, { allowOrigin })
  } catch (error) {
    return { ok: false, error: error.message }
  }
  try {
    const response = await fetch(`${safeOrigin}/api/official`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // A public reference-facts read has no reason to redirect anywhere;
      // refusing to follow one keeps this consistent with every other
      // identity-adjacent fetch in this repo (identity-probe.mjs,
      // identity-client.mjs's fetchOrExplain), even though this particular
      // call carries no secret to protect from a redirect target.
      redirect: 'error',
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      // handled below
    }
    if (!response.ok || !parsed) {
      return { ok: false, error: parsed?.error ?? `HTTP ${response.status}` }
    }
    const doorsEnabled = parsed?.identity?.coding_client_json?.doors_enabled
    return { ok: true, doorsEnabled: typeof doorsEnabled === 'boolean' ? doorsEnabled : null }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
