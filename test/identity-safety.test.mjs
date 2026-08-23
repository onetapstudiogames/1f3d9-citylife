import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rootSkill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
const packagedSkill = await readFile(
  new URL('../skills/1f3d9-citylife/SKILL.md', import.meta.url),
  'utf8',
)
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const wallet = await readFile(new URL('../references/wallet.md', import.meta.url), 'utf8')
const packagedWallet = await readFile(
  new URL('../skills/1f3d9-citylife/references/wallet.md', import.meta.url),
  'utf8',
)

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

test('Wave 14 replaces automatic memory with deliberate body-free discovery', () => {
  for (const [name, value] of [['root', rootSkill], ['packaged', packagedSkill]]) {
    assert.doesNotMatch(value, /use the city itself as durable\s+memory/iu, `${name}: automatic memory`)
    assert.doesNotMatch(value, /read (?:the )?(?:resident(?:'s)? )?house/iu, `${name}: automatic house read`)
    assert.doesNotMatch(value, /luggage-room/iu, `${name}: automatic luggage read`)
    assert.doesNotMatch(value, /inherit/iu, `${name}: inheritance framing`)
    assert.match(
      value,
      /An earlier holder of this resident identity marked 1\s+public item for later holders\. View the index\?/u,
      `${name}: exact singular notice`,
    )
    assert.match(value, /zero[^\n]{0,100}count[^\n]{0,40}no question/iu, `${name}: zero-count behavior`)
    assert.match(value, /only after[\s\S]{0,120}choice[\s\S]{0,160}body-free index/iu, `${name}: choice before index`)
    assert.match(
      value,
      /stable public ID[\s\S]{0,180}type[\s\S]{0,180}(?:writer-supplied|writer) title[\s\S]{0,180}place[\s\S]{0,180}date[\s\S]{0,180}(?:exact UTF-8 body size|body_text_bytes)/iu,
      `${name}: body-free index fields`,
    )
    assert.match(
      value,
      /The city stores no record of whether the notice or index was opened\. The host may retain short-lived technical request records\./u,
      `${name}: honest read-record policy`,
    )
  }
})

test('Wave 14 explains current reading, provenance, orientation, and snapshots', () => {
  for (const [name, value] of [['root', rootSkill], ['packaged', packagedSkill]]) {
    assert.match(value, /look[\s\S]{0,240}read-only[\s\S]{0,180}(?:never|does not)[\s\S]{0,80}(?:wake|resolve)[\s\S]{0,40}timers/iu, `${name}: passive look`)
    assert.match(value, /ordinary[\s\S]{0,80}`?me`?[\s\S]{0,80}wakes due timers/iu, `${name}: ordinary me timer behavior`)
    assert.match(value, /`made_by`[\s\S]{0,160}`current_owner`/u, `${name}: maker and current owner`)
    assert.match(value, /(?:gift|transfer|sale)[\s\S]{0,180}current owner[\s\S]{0,100}maker never changes/iu, `${name}: maker permanence`)
    assert.match(value, /one optional owner-written purpose/iu, `${name}: room purpose`)
    assert.match(value, /front matter[\s\S]{0,180}exactly two or three/iu, `${name}: front-matter bounds`)
    assert.match(value, /front matter[\s\S]{0,260}body-free/iu, `${name}: body-free front matter`)
    assert.match(value, /GET \/api\/search|official anonymous MCP `search` tool/u, `${name}: bounded search guidance`)
    assert.match(value, /change_marker/u, `${name}: caller-held change guidance`)
    assert.match(value, /city-snapshot-v1-/u, `${name}: public snapshot discovery`)
    assert.match(value, /public snapshots[\s\S]{0,220}not\s+(?:private\s+)?recovery backups/iu, `${name}: snapshot boundary`)
  }
})

test('Wave 14 keeps ChatGPT access and private payment recovery honest', () => {
  for (const [name, value] of [['root', rootSkill], ['packaged', packagedSkill]]) {
    assert.match(value, /https:\/\/developers\.openai\.com\/plugins\/deploy\/connect-chatgpt/u, `${name}: current OpenAI guide`)
    assert.match(value, /Settings -> Security and login -> Developer mode/u, `${name}: documented developer mode`)
    assert.match(value, /ChatGPT Plugins -> \+/u, `${name}: documented plugin page`)
    assert.doesNotMatch(value, /(?:web only|mobile[^\n]{0,80}unsupported|not supported on mobile)/iu, `${name}: unsupported surface claim`)
    assert.match(value, /https:\/\/1f3d9\.com\/mcp\/connect/u, `${name}: hosted connector`)
    assert.match(value, /\/mcp[\s\S]{0,120}key-capable local clients/iu, `${name}: local connector distinction`)
    assert.match(value, /founder-issued city fee credit/iu, `${name}: credit name`)
    assert.match(value, /city fee credit[\s\S]{0,180}not a token/iu, `${name}: credit is not a token`)
    assert.match(value, /private[\s\S]{0,120}(?:balance|history)/iu, `${name}: private credit facts`)
    assert.match(value, /at most two hours/iu, `${name}: bounded payment recovery`)
    assert.match(value, /late real payment[\s\S]{0,180}founder review[\s\S]{0,180}(?:cannot|never)[\s\S]{0,80}automatically/iu, `${name}: late-payment outcome`)
    assert.doesNotMatch(value, /automatic(?:ally)? refund/iu, `${name}: no automatic-refund promise`)
  }
})

test('the packaged wallet stays identical and does not promise raw city-payment proof', () => {
  assert.equal(packagedWallet, wallet)
  assert.match(wallet, /city claim routes[\s\S]{0,180}signed\s+`?X-PAYMENT`?/iu)
  assert.match(wallet, /raw[\s\S]{0,40}transaction hash[\s\S]{0,120}not accepted/iu)
  assert.match(wallet, /1F3EA direct market proof[\s\S]{0,260}fresh, short-lived intent[\s\S]{0,260}payer signature/iu)
  assert.match(wallet, /transaction hash[\s\S]{0,80}alone[\s\S]{0,80}(?:is|are) rejected/iu)
})
