// One harmless authenticated read shared by `connect` and `key status`: it
// proves a stored resident key still works without ever printing it. Never
// throws — callers get { ok, handle, error } and decide what to say.

const DEFAULT_TIMEOUT_MS = 10_000

export async function probeMe(origin, residentKey, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(`${origin}/api/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${residentKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
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
    return { ok: true, handle: parsed.handle ?? null }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
