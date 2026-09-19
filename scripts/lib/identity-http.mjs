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

/** Describe a failed fetch without exposing runtime or transport-library prose. */
function networkFailureMessage(url, error, {
  notSentOutcome = 'the request was not sent',
  uncertainOutcome = 'the result could not be confirmed',
} = {}) {
  const causes = [error, error?.cause, ...(error?.cause?.errors ?? [])]
  const code = causes.find(cause => cause?.code)?.code
  const timedOut = causes.some(cause => cause?.name === 'TimeoutError')
  const detail = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' ? 'the server address could not be found'
    : code === 'EAI_AGAIN' ? 'the server address could not be looked up right now'
    : timedOut || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
      ? 'the connection timed out'
      : 'the connection ended before a response arrived'
  const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
  return `could not reach ${url} (network error: ${detail}); ` +
    `${notSent ? notSentOutcome : uncertainOutcome}; ` +
    (notSent ? 'check the address and your connection, then retry'
      : 'check whether the action completed before retrying')
}

function unreadableResponseMessage(status) {
  return `the city answered with HTTP ${status} but no readable message`
}

/**
 * Wraps a fetch failure (DNS, connection refused, timeout, TLS -- anything
 * before a response ever arrives) into a caller-facing message that names
 * the origin, explains the action-specific outcome, and suggests a next step.
 * Redirect refusals follow the city's reference client's wording.
 */
async function fetchOrExplain(url, init) {
  let response
  try {
    // Read redirects without following them: no key or secret request body
    // may be forwarded, even when the destination has the same origin.
    response = await fetch(url, { ...init, redirect: 'manual' })
  } catch (error) {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body ?? '{}') ?? {}
    const outcomes = {
      '/api/register': [
        body.action === 'confirm'
          ? 'no resident was created; a staged credential entry was written locally and remains stored'
          : 'nothing was created',
        'registration could not be confirmed',
      ],
      '/api/rotate': ['the key was not rotated', 'key rotation could not be confirmed'],
      '/api/recovery': ['no recovery was performed', 'recovery could not be confirmed'],
      '/api/pair': ['no pairing code was created', 'pairing code creation could not be confirmed'],
    }
    const [notSentOutcome, uncertainOutcome] = outcomes[path] ?? []
    throw new Error(networkFailureMessage(url, error, { notSentOutcome, uncertainOutcome }))
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
    const error = sanitizeServerProse(parsed?.error) || unreadableResponseMessage(response.status)
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
    const error = sanitizeServerProse(parsed?.error) || unreadableResponseMessage(response.status)
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


export {
  sanitizeServerProse,
  networkFailureMessage,
  unreadableResponseMessage,
  postJson,
  postAuthed,
  cancelStage,
}
