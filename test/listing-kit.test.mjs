import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildListingArtifacts, parseLedger } from '../scripts/lib/listing-kit.mjs'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('listing kit and machine metadata are regenerated from current sources', async () => {
  const generated = await buildListingArtifacts(new URL('..', import.meta.url))
  assert.equal(await read('docs/LISTING-KIT.md'), generated.markdown)
  assert.equal(await read('docs/listing-metadata.json'), generated.json)
  assert.match(generated.markdown, /1F3D9: City Life for AI Agents/)
  assert.match(generated.markdown, /https:\/\/1f3d9.com\/mcp\/connect/)
  assert.doesNotMatch(generated.markdown, /Join-1:/u)
  assert.ok(JSON.parse(generated.json).shortDescription.length <= 30)
})

test('ledger rows have five nonempty fields and valid status', async () => {
  const rows = parseLedger(await read('docs/LISTINGS.md'))
  assert.equal(rows.length, 14)
  assert.deepEqual(rows.map(row => row.directory), ['GitHub', 'ClawHub', 'skills.sh', 'SkillMD', 'SkillsDirectory', 'AgentSkill.sh', 'Toolify', '1F3D9 site', 'Smithery', 'MCP Registry', 'Glama', 'Licium', 'Claude directory', 'Codex directory'])
  for (const row of rows) {
    for (const field of ['directory', 'listingUrl', 'account', 'versionShown', 'lastChecked']) {
      assert.ok(row[field]?.trim(), `${row.directory}: ${field}`)
    }
    assert.ok(['listed', 'planned', 'owner submits'].includes(row.status))
  }
})

test('ledger rejects incomplete and duplicate directory rows', () => {
  const valid = '| Directory | Listing URL | Account | Version shown | Last checked | Status |\n| --- | --- | --- | --- | --- | --- |\n| GitHub | unknown | unknown | unknown | unknown | planned |'
  assert.throws(() => parseLedger(valid.replace('| GitHub | unknown |', '| GitHub | |')), /Incomplete listing row/u)
  assert.throws(() => parseLedger(`${valid}\n| GitHub | unknown | unknown | unknown | unknown | planned |`), /Duplicate listing directory/u)
})

test('links command prints only listed directories with known URLs', async () => {
  const { spawnSync } = await import('node:child_process')
  const output = spawnSync(process.execPath, ['scripts/links.mjs'], { encoding: 'utf8' })
  assert.equal(output.status, 0)
  const rows = parseLedger(await read('docs/LISTINGS.md'))
  for (const row of rows.filter(row => row.status === 'listed' && row.listingUrl !== 'unknown')) {
    assert.ok(output.stdout.includes(row.listingUrl), row.directory)
  }
})
