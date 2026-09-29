const UNSAFE_SERVER_TEXT_RE = /[\x00-\x1f\x7f\u2028\u2029]/u
const SUMMARY_MAX_LENGTH = 1200

export function gazetteLine(gazette) {
  if (!gazette || typeof gazette !== 'object' || Array.isArray(gazette)) return null

  const summary = typeof gazette.summary === 'string' ? gazette.summary.trim() : ''
  if (!summary || [...summary].length > SUMMARY_MAX_LENGTH || UNSAFE_SERVER_TEXT_RE.test(summary)) return null
  if (!Number.isInteger(gazette.issue_number) || gazette.issue_number <= 0) return null
  if (typeof gazette.new_issue !== 'boolean') return null

  return `gazette: ${summary}${gazette.new_issue
    ? ` This check does not print the headlines; read them with browse, view gazette, issue_number ${gazette.issue_number}.`
    : ''}`
}
