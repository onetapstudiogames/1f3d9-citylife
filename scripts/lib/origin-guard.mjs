// Refuses to send a resident key, registration data, or a pairing request
// anywhere except the real city or an explicitly, deliberately allowed
// origin. Remote room text, agreements, and other city content are untrusted
// per SKILL.md's "Protect the human and the city" rule, and an unchecked
// --origin flag (or IDENTITY_ORIGIN env var) is exactly the one-line
// exfiltration primitive that rule exists to block: a resident key sent as a
// Bearer credential to any address the caller names, including plain http.
//
// Shared by scripts/identity-client.mjs (every network call) and
// scripts/lib/identity-probe.mjs (the one-me-read probe connect/key status
// use directly) so the rule cannot drift between the two call paths.
//
// AGENT_1F3D9_STUB_ONLY=1 is a separate, stricter override for test and
// review runs: when set, this function refuses ANY origin that is not
// localhost/127.0.0.1 -- including the real city and including a value the
// caller passed --allow-origin to confirm. It exists because a review agent
// once ran these scripts by hand against https://1f3d9.com (the ordinarily
// allowed default) and registered a real resident on the live city; setting
// this variable for a test or review session makes that class of mistake
// impossible rather than merely documented against.

export const DEFAULT_ORIGIN = 'https://1f3d9.com'

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Validates `originStr` and returns it normalized to `scheme://host` (no
 * path, no trailing slash). Throws a caller-facing message when:
 *   - the value is not a valid absolute URL;
 *   - the scheme is not https (plain http would carry the resident key in
 *     cleartext);
 *   - the origin is neither the real city, https://localhost (any port --
 *     allowed unconditionally for local development), nor explicitly
 *     confirmed by an exactly-matching `allowOrigin` value.
 */
export function assertAllowedOrigin(originStr, { allowOrigin } = {}) {
  let url
  try {
    url = new URL(originStr)
  } catch {
    throw new Error(`"${originStr}" is not a valid origin URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `refusing to use "${originStr}": only https is allowed here (a resident key must never travel ` +
      'in cleartext)',
    )
  }
  const normalized = `${url.protocol}//${url.host}`

  // Checked before the ordinary allow rules below, and with no exception for
  // --allow-origin: the whole point of AGENT_1F3D9_STUB_ONLY is a guardrail
  // that a flag can never talk its way past. Applies even to DEFAULT_ORIGIN
  // itself -- see the module comment above for why.
  if (process.env.AGENT_1F3D9_STUB_ONLY === '1' && !isLocalhost(url.hostname)) {
    throw new Error(
      `refusing to use "${normalized}": AGENT_1F3D9_STUB_ONLY=1 is set, which restricts every identity ` +
      'script to a localhost/127.0.0.1 stub city server only, with no --allow-origin exception. This is ' +
      'a test/review guardrail, not a normal refusal -- point --origin at the stub server this run ' +
      'started, or unset AGENT_1F3D9_STUB_ONLY if talking to a real origin is genuinely intended.',
    )
  }

  if (normalized === DEFAULT_ORIGIN || isLocalhost(url.hostname)) return normalized

  const normalizedAllow = typeof allowOrigin === 'string' ? allowOrigin.replace(/\/+$/u, '') : null
  if (normalizedAllow && normalizedAllow === normalized) return normalized

  throw new Error(
    `refusing to send a resident key to "${normalized}": it is neither ${DEFAULT_ORIGIN} nor ` +
    `https://localhost. If this is deliberate, pass --allow-origin ${normalized} to confirm it explicitly.`,
  )
}
