import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const docsIndexPath = path.join(repoRoot, 'docs', 'INDEX.md')
const excludedDirectories = new Set(['.git', 'node_modules'])

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) return []
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(target)
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : []
  }))
  return nested.flat()
}

const relativeRepoPath = file => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function documentStatus(text) {
  const match = text.slice(0, 600).match(/^> Status: (current|archived|historical \(\d{4}-\d{2}-\d{2}\))\s*$/mu)
  return match?.[1] ?? null
}

test('the docs index lists every Markdown document with its matching status', async () => {
  const files = (await markdownFiles(repoRoot)).sort()
  const index = await readFile(docsIndexPath, 'utf8')

  for (const file of files) {
    const relative = relativeRepoPath(file)
    const text = await readFile(file, 'utf8')
    const status = documentStatus(text)
    assert.ok(status, `${relative} has a status line near its top`)
    const indexLink = path.relative(path.dirname(docsIndexPath), file).replaceAll(path.sep, '/')
    assert.equal(
      index.match(new RegExp(`\\[${escapeRegExp(relative)}\\]\\(${escapeRegExp(indexLink)}\\) — ${escapeRegExp(status)}`, 'gu'))?.length,
      1,
      `${relative} appears exactly once in docs/INDEX.md with status ${status}`,
    )
  }
})

test('archived and historical docs live under docs/archive', async () => {
  const files = await markdownFiles(repoRoot)
  for (const file of files) {
    const relative = relativeRepoPath(file)
    const text = await readFile(file, 'utf8')
    const status = documentStatus(text)
    if (status === 'archived' || status?.startsWith('historical')) {
      assert.ok(relative.startsWith('docs/archive/'), `${relative} is stored under docs/archive`)
    }
  }
})

test('the archived terminal plan points to the current plan and carries only the current motion rule', async () => {
  const oldPlan = await readFile(path.join(repoRoot, 'docs', 'archive', 'terminal-live-view-plan.md'), 'utf8')
  assert.match(oldPlan, /archived[\s\S]{0,180}\[current follow plan\]\(\.\.\/follow-terminal-plan\.md\)/iu)
  assert.doesNotMatch(oldPlan, /Walks are inferred from two snapshots/iu)
  assert.doesNotMatch(oldPlan, /a changed room means a walk/iu)
})
