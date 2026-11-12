// Plugin 1.9.69 word pass: where a sentence is about fee credit, what a city
// action takes, or the setup command's one-time approval token, the guide, the
// public reading reference and the setup command say "use" instead of spend,
// cost, pays or credit-funded. Real payment steps (USDC, x402, wallet, PayPal,
// dollar prices), fixed names and the city's own pinned rules keep their words.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFile(path.join(repoRoot, relative), 'utf8')
const collapse = (text) => text.replace(/\s+/gu, ' ')

const GUIDES = ['references/resident-guide.md', 'skills/1f3d9-citylife/references/resident-guide.md']
const READINGS = ['references/public-reading.md', 'skills/1f3d9-citylife/references/public-reading.md']

const NEW_SENTENCES = [
  [GUIDES, 'Fee credit is used for city fees; it cannot be transferred or cashed out.'],
  [GUIDES, 'later balance attention is awareness, not new authority to use fee credit.'],
  [GUIDES, 'Make up a new `request_id` for each new line; retry the same ID with the same place and body to get the same line, with no new line or allowance used.'],
  [GUIDES, 'and not one of those uses has been taken since; otherwise it renews'],
  [GUIDES, 'The public command uses one daily note, uses no weekly slot, does not restore the submission\'s used slot, and never prints.'],
  [GUIDES, 'Renaming, retiring, or restoring a place you own also use one fee credit each, but those three take only prepaid city fee credit and refuse direct x402.'],
  [GUIDES, 'A failed action that used fee credit can return only its exact debit.'],
  [GUIDES, 'Before any action that uses fee credit, call passive `credit_preflight` and show `fee_cost`, `balance_before`, `balance_after`, and `pending_gifts_count`,'],
  [GUIDES, 'At the deadline, the held name is released and the exact fee credit the action used is returned; uncertain x402 evidence never creates credit.'],
  [READINGS, 'Each returned `first_line` adds its UTF-8 bytes to `returned_text_bytes` without using that body budget, so it may be returned at limit 0.'],
  [READINGS, 'An end set only by uses reads at null until the uses are used up.'],
  [['skills/setup/SKILL.md'], 'Before using that single-use token, this second pass also reads `GET /api/official`, and refuses without using the token if the coding-client identity doors are off there; rerun the exact same second command, unedited, once they are back on.'],
  [['scripts/setup.mjs'], 'setup: refusing to use the approval token on'],
  [['scripts/setup.mjs'], '\'after using this single-use token, and the token must never be used on a registration the city \''],
]

const OLD_PHRASES = [
  'pays city fees',
  'not new spending authority',
  'allowance spent',
  'has been spent since',
  'spent slot',
  'also cost one fee credit each',
  'credit-funded action',
  'credit-funded fee action',
  'exact spent credit debit',
  'without spending that body budget',
  'uses are spent',
  'it is not money that can be transferred',
  'spending that single-use token',
  'without spending the token',
  'refusing to spend the approval token',
  'after spending this single-use token',
  'must never be spent on a registration',
]

// Left on purpose by the owner's choice: these sentences stay as they are.
const KEPT_SENTENCES = [
  'A mute never holds a credit gift: its buyer is secret.',
  'It is not a token, cryptocurrency, transferable balance, cash redemption, or promise of a refund.',
  'A revision must change something:',
]

// An en dash or an em dash, written as escapes so this file carries neither.
const LONG_DASH = new RegExp('[\\u2013\\u2014]', 'u')

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'test'])
const TEXT_FILE = /\.(?:md|mjs|js|json|ya?ml|txt)$/u

async function textFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    const relative = path.relative(repoRoot, target).replaceAll(path.sep, '/')
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || relative === 'docs/archive') return []
      return textFiles(target)
    }
    if (!entry.isFile() || relative === 'CHANGELOG.md' || !TEXT_FILE.test(entry.name)) return []
    return [relative]
  }))
  return nested.flat()
}

test('each new "use" sentence is in every copy', async () => {
  for (const [files, sentence] of NEW_SENTENCES) {
    for (const file of files) {
      assert.ok(collapse(await read(file)).includes(sentence), `${file}: ${sentence}`)
    }
  }
})

test('the old spend, cost and pays phrases are gone outside tests, the changelog and the archive', async () => {
  const files = await textFiles(repoRoot)
  assert.ok(files.includes('references/resident-guide.md'), 'the walk reaches the guide')
  for (const file of files) {
    const text = collapse(await read(file))
    for (const phrase of OLD_PHRASES) {
      assert.ok(!text.includes(phrase), `${file}: still says "${phrase}"`)
    }
  }
})

test('the changed lines carry no long dash', async () => {
  for (const file of GUIDES) {
    const line = (await read(file)).split(/\r?\n/u)
      .find((entry) => entry.includes('Renaming, retiring, or restoring a place you own also use one fee credit each'))
    assert.ok(line, `${file}: holds the place fee sentence`)
    assert.doesNotMatch(line, LONG_DASH, `${file}: no long dash on the place fee line`)
    assert.ok(line.includes('accept either rail: this credit or direct x402.'), `${file}: the old dash became a colon`)
  }
  const setupLines = (await read('skills/setup/SKILL.md')).split(/\r?\n/u)
  const start = setupLines.findIndex((entry) => entry.includes('Before using that single-use token'))
  assert.ok(start >= 0, 'skills/setup/SKILL.md: holds the token sentence')
  for (const line of setupLines.slice(start, start + 3)) {
    assert.doesNotMatch(line, LONG_DASH, `skills/setup/SKILL.md: no long dash on a changed line: ${line}`)
  }
})

test('the sentences the owner kept stay as they are', async () => {
  for (const file of GUIDES) {
    const guide = collapse(await read(file))
    for (const sentence of KEPT_SENTENCES) {
      assert.ok(guide.includes(sentence), `${file}: kept: ${sentence}`)
    }
  }
})
