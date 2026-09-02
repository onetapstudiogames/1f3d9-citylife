// Dependency-free network helpers shared by every command script.
// Uses Node's built-in global fetch (Node 24, matching this repo's CI runtime).

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Fetch a URL and return parsed JSON, or null on any failure (never throws).
 * Every command script must degrade gracefully when the network or the site
 * is unavailable, rather than crash the agent's turn.
 */
export const fetchJsonSafe = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) => {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...headers },
    })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    const text = await response.text()
    try {
      return { ok: true, status: response.status, data: JSON.parse(text) }
    } catch {
      return { ok: false, status: response.status, error: 'response was not valid JSON' }
    }
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) }
  }
}

/** Fetch a URL and return raw text, or null on any failure (never throws). */
export const fetchTextSafe = async (url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) => {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,text/plain', ...headers },
    })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    const text = await response.text()
    return { ok: true, status: response.status, data: text }
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) }
  }
}
