const SECRET_RE = /1f3d9_(?:sk|rc)_[0-9a-f]+/giu

export function safeErrorText(error) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(SECRET_RE, '[REDACTED]').replace(/[\r\n\u2028\u2029]+/gu, ' ').trim()
    || 'unknown runtime failure'
}

export function commandFailure(command, error, { outcome, next, help }) {
  return `${command}: ${safeErrorText(error)}. ${outcome} ${next} Read ${help}`
}
