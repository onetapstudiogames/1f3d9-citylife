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
    assert.match(value, /https:\/\/1f3d9\.com\/rotate/u, `${name}: rotation URL`)
    assert.match(value, /https:\/\/1f3d9\.com\/mcp\/connect/u, `${name}: hosted connector`)
    assert.match(value, /re-?enter/u, `${name}: possession confirmation`)
    assert.match(value, /one-use recovery codes?/iu, `${name}: recovery codes`)
    assert.match(value, /never[^\n]{0,160}(?:chat|MCP|tool result)/iu, `${name}: transcript ban`)
    assert.match(value, /logs,?\s+(?:or\s+)?screenshots/iu, `${name}: durable-output ban`)
    assert.match(value, /carry either key/iu, `${name}: rotation-key ban`)
    assert.doesNotMatch(value, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/register/iu, `${name}: retired API`)
    assert.doesNotMatch(value, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/rotate/iu, `${name}: retired rotation API`)
    assert.doesNotMatch(value, /legacy MCP or JSON protocol/iu, `${name}: unsafe local flow`)
    assert.doesNotMatch(value, /returned `?1f3d9_sk_[^\n]*private tool output/iu, `${name}: tool-output capture`)
    assert.doesNotMatch(value, /(?:has no recovery path|lost key cannot be recovered)/iu, `${name}: stale recovery claim`)
  }
})

test('the skill matches the city truth release', () => {
  for (const [name, value] of [['root', rootSkill], ['packaged', packagedSkill]]) {
    // ChatGPT setup leads with the official OpenAI guide, not local menu paths
    assert.match(
      value,
      /https:\/\/developers\.openai\.com\/plugins\/deploy\/connect-chatgpt/u,
      `${name}: official connect guide`,
    )
    assert.doesNotMatch(
      value,
      /Scan Tools|Advanced Settings|Workspace settings -> Apps/iu,
      `${name}: retired ChatGPT menu paths`,
    )
    // the join page reveals the key and the first eight recovery codes together
    assert.match(
      value,
      /key and eight[\s\S]{0,40}one-use recovery codes/iu,
      `${name}: join reveals codes with the key`,
    )
    assert.doesNotMatch(
      value,
      /without first generating codes/iu,
      `${name}: stale pre-generation requirement`,
    )
  }
})

test('the install page names the safe identity doors', () => {
  assert.match(readme, /https:\/\/1f3d9\.com\/join/u)
  assert.match(readme, /https:\/\/1f3d9\.com\/recovery/u)
  assert.match(readme, /https:\/\/1f3d9\.com\/rotate/u)
  assert.match(
    readme,
    /Never put a current key, replacement key, or recovery\s+code in chat,\s+a tool result, logs, or screenshots\./u,
  )
})
