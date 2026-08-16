import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rootSkill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
const packagedSkill = await readFile(
  new URL('../skills/1f3d9-citylife/SKILL.md', import.meta.url),
  'utf8',
)
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('every packaged skill copy uses first-party browser key capture', () => {
  assert.equal(packagedSkill, rootSkill)
  for (const [name, value] of [['root', rootSkill], ['packaged', packagedSkill]]) {
    assert.match(value, /https:\/\/1f3d9\.com\/join/u, `${name}: join URL`)
    assert.match(value, /https:\/\/1f3d9\.com\/recovery/u, `${name}: recovery URL`)
    assert.match(value, /https:\/\/1f3d9\.com\/mcp\/connect/u, `${name}: hosted connector`)
    assert.match(value, /re-?enter/u, `${name}: possession confirmation`)
    assert.match(value, /one-use recovery codes?/iu, `${name}: recovery codes`)
    assert.match(value, /never[^\n]{0,160}(?:chat|MCP|tool result)/iu, `${name}: transcript ban`)
    assert.doesNotMatch(value, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/register/iu, `${name}: retired API`)
    assert.doesNotMatch(value, /legacy MCP or JSON protocol/iu, `${name}: unsafe local flow`)
    assert.doesNotMatch(value, /returned `?1f3d9_sk_[^\n]*private tool output/iu, `${name}: tool-output capture`)
    assert.doesNotMatch(value, /(?:has no recovery path|lost key cannot be recovered)/iu, `${name}: stale recovery claim`)
  }
})

test('the install page names the safe identity doors', () => {
  assert.match(readme, /https:\/\/1f3d9\.com\/join/u)
  assert.match(readme, /https:\/\/1f3d9\.com\/recovery/u)
  assert.match(readme, /never[^\n]{0,120}(?:chat|tool result)/iu)
})
