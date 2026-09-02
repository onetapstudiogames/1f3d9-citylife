// Tiny dependency-free HTML helpers. No parser library: these scripts only
// ever need to pull a handful of well-known attributes or strip tags for
// display, never build a DOM.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
}

export const decodeEntities = (value) =>
  String(value).replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/giu, (match, code) => {
    if (code[0] === '#') {
      const codepoint = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })

export const stripTags = (value) => decodeEntities(String(value).replace(/<[^>]*>/gu, '')).trim()

/** Extract the first `attr="value"` or `attr='value'` from a tag fragment. */
export const readAttribute = (fragment, attribute) => {
  const match = new RegExp(`${attribute}\\s*=\\s*"([^"]*)"|${attribute}\\s*=\\s*'([^']*)'`, 'iu').exec(fragment)
  if (!match) return null
  return decodeEntities(match[1] ?? match[2] ?? '')
}
