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
  if (normalized === DEFAULT_ORIGIN || isLocalhost(url.hostname)) return normalized

  const normalizedAllow = typeof allowOrigin === 'string' ? allowOrigin.replace(/\/+$/u, '') : null
  if (normalizedAllow && normalizedAllow === normalized) return normalized

  throw new Error(
    `refusing to send a resident key to "${normalized}": it is neither ${DEFAULT_ORIGIN} nor ` +
    `https://localhost. If this is deliberate, pass --allow-origin ${normalized} to confirm it explicitly.`,
  )
}
