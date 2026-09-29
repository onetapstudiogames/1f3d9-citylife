import assert from 'node:assert/strict'
import test from 'node:test'

import { gazetteLine } from '../scripts/lib/gazette-line.mjs'

const summary = 'This week\'s Gazette is issue 6, printed 2026-10-05 with 12 entries.'

test('gazetteLine points to the full issue for a new Gazette', () => {
  assert.equal(
    gazetteLine({ summary, issue_number: 6, new_issue: true }),
    `gazette: ${summary} This check does not print the headlines; read them with browse, view gazette, issue_number 6.`,
  )
})

test('gazetteLine prints only the summary for a later visit', () => {
  assert.equal(gazetteLine({ summary, issue_number: 6, new_issue: false }), `gazette: ${summary}`)
})

test('gazetteLine skips missing or malformed Gazette data', () => {
  for (const gazette of [
    null,
    {},
    { summary, issue_number: 0, new_issue: true },
    { summary, issue_number: 1.5, new_issue: false },
    { summary, issue_number: 6, new_issue: 'true' },
  ]) {
    assert.equal(gazetteLine(gazette), null)
  }
})

test('gazetteLine skips unsafe or oversized summary text', () => {
  assert.equal(gazetteLine({ summary: 'one line\nsecond line', issue_number: 6, new_issue: false }), null)
  assert.equal(gazetteLine({ summary: 'x'.repeat(1201), issue_number: 6, new_issue: false }), null)
})
