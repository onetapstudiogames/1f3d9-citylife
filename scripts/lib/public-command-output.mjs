import { stripTags, readAttribute } from './html.mjs'
import { HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE } from './identity-input.mjs'

const TIP_BUTTON_RE = /<a\b[^>]*class="[^"]*\btip-button\b[^"]*"[^>]*>[\s\S]*?<\/a>/giu
const CHANGELOG_ARTICLE_RE = /<article\b[^>]*class="[^"]*\bchangelog-entry\b[^"]*"[^>]*>([\s\S]*?)<\/article>/giu
const CHANGELOG_PART_RE = /<(h2|h3|li)\b[^>]*>([\s\S]*?)<\/\1>/giu

export function extractDonateLink(html) {
  if (typeof html !== 'string') return null
  for (const match of html.matchAll(TIP_BUTTON_RE)) {
    const tag = match[0]
    const href = readAttribute(tag, 'href')
    const sentence = readAttribute(tag, 'title')
    if (
      typeof href === 'string'
      && /^https:\/\/www\.paypal\.com\/donate\/\?hosted_button_id=[A-Za-z0-9]+$/u.test(href)
      && typeof sentence === 'string'
      && sentence.trim().length > 0
    ) {
      return { href, sentence: sentence.trim() }
    }
  }
  return null
}

export function extractChangelogEntries(html) {
  if (typeof html !== 'string') return []
  const entries = []
  for (const article of html.matchAll(CHANGELOG_ARTICLE_RE)) {
    let date = ''
    let audience = ''
    for (const part of article[1].matchAll(CHANGELOG_PART_RE)) {
      const text = stripTags(part[2]).replace(/\s+/gu, ' ').trim()
      if (!text) continue
      if (part[1].toLowerCase() === 'h2') date = text
      else if (part[1].toLowerCase() === 'h3') audience = text
      else if (date && audience) entries.push({ date, audience, text })
    }
  }
  return entries
}

export function truncateMarked(value, maxLength) {
  const text = String(value).replace(/\s+/gu, ' ').trim()
  if (text.length <= maxLength) return text
  const candidate = text.slice(0, Math.max(0, maxLength - 1)).trimEnd()
  const wordEnd = candidate.lastIndexOf(' ')
  const kept = wordEnd > 0 ? candidate.slice(0, wordEnd) : ''
  return `${kept}…`
}

export function validateBuyHandle(handle) {
  if (!HANDLE_RE.test(handle)) {
    return 'handle must use lowercase letters, digits, and hyphens, be 3-32 characters, and start with a letter or digit'
  }
  if (RESERVED_HANDLE_SUBSTRING_RE.test(handle)) return 'handle must name a resident, never a staging label'
  return null
}
