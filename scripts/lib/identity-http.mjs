// --- HTTP -----------------------------------------------------------------

const SERVER_PROSE_MAX_LENGTH = 300
const UNSAFE_SERVER_PROSE_RE = /[\x00-\x1f\x7f\u2028\u2029]/u

/** Returns server prose only when it is one short, non-empty line. */
function sanitizeServerProse(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed
    && trimmed.length <= SERVER_PROSE_MAX_LENGTH
    && !UNSAFE_SERVER_PROSE_RE.test(trimmed)
    ? trimmed
    : ''
}

/**
 * Wraps a fetch failure (DNS, connection refused, timeout, TLS -- anything
 * before a response ever arrives) into a caller-facing message that names
 * the origin, says nothing was created, and suggests a next step, instead of
 * letting the bare engine error ("fetch failed") escape unexplained.
 * Redirect refusals follow the city's reference client's wording.
 */
async function fetchOrExplain(url, init) {
  let response
  try {
    // Read redirects without following them: no key or secret request body
    // may be forwarded, even when the destination has the same origin.
    response = await fetch(url, { ...init, redirect: 'manual' })
  } catch (error) {
    // Node's fetch wraps the real failure in `error.cause`, which for a
    // connection failure is itself an AggregateError with an EMPTY top-level
    // message and the useful text one level deeper in `.errors[0].message`
    // (or just a `.code` like ECONNREFUSED/ENOTFOUND when even that is
    // absent) -- so fall through several levels rather than printing a bare
    // "(network error: )" with nothing after the colon.
    const cause = error?.cause
    const detail =
      cause?.message
      || cause?.errors?.[0]?.message
      || cause?.code
      || error?.message
      || String(error)
    throw new Error(
      `could not reach ${url} (network error: ${detail}); nothing was created -- check the address and ` +
      'your connection, then retry',
    )
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    let destination = 'an unspecified address'
    if (location) {
      try {
        const target = new URL(location, url)
        destination = ['http:', 'https:'].includes(target.protocol) ? target.origin : 'an unreadable address'
        const body = JSON.parse(init.body ?? '{}') ?? {}
        const privateValues = [body.resident_key, body.recovery_code, body.stage_token, init.headers.authorization?.slice(7)]
          .filter(value => typeof value === 'string' && value.length > 0)
        if (privateValues.some(value => destination.toLowerCase().includes(value.toLowerCase()))) {
          destination = 'an address containing a private value'
        }
      } catch {
        destination = 'an unreadable address'
      }
    }
    await response.body?.cancel().catch(() => {}) // Still report the redirect if cleanup fails.
    throw new Error(
      `${url}: the city answered with a redirect to ${destination}; the key was not sent on; ` +
      'check the city address and whether the action completed before retrying',
    )
  }
  return response
}

async function postJson(origin, path, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // Non-JSON response falls through with parsed === null below.
  }
  if (!response.ok || !parsed) {
    const error = sanitizeServerProse(parsed?.error) || `HTTP ${response.status} with no readable JSON body`
    const nextStep = sanitizeServerProse(parsed?.next_step)
    throw new Error(`${path} refused: ${error}.${nextStep ? ` next_step: ${nextStep}` : ''}`)
  }
  return parsed
}

async function postAuthed(origin, path, residentKey, body) {
  const response = await fetchOrExplain(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${residentKey}`,
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled below
  }
  if (!response.ok || !parsed) {
    const error = sanitizeServerProse(parsed?.error) || `HTTP ${response.status} with no readable JSON body`
    throw new Error(`${path} refused: ${error}`)
  }
  return parsed
}

// --- Commands ---------------------------------------------------------

/** Best effort: tells the city to release a stage it will otherwise just let expire on its own. */
async function cancelStage(origin, path, stageToken) {
  try {
    await postJson(origin, path, { action: 'cancel', stage_token: stageToken })
  } catch {
    // Best effort -- the stage expires on its own either way, and the
    // caller above is already reporting the real failure.
  }
}


export { sanitizeServerProse, postJson, postAuthed, cancelStage }
