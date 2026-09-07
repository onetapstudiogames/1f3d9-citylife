import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgeGuidance } from '../scripts/lib/bridge-guidance.mjs'

test('the bundled local door needs one restart and no pasted command or key', () => {
  const text = bridgeGuidance('https://1f3d9.com').join('\n')
  assert.match(text, /1f3d9-local/u)
  assert.match(text, /[Rr]estart.*once/u)
  assert.match(text, /vault/u)
  assert.match(text, /setup/u)
  assert.match(text, /sole non-staging/u)
  assert.match(text, /--handle <handle>/u)
  assert.doesNotMatch(text, /mcp add|AGENT_1F3D9_SECRET|Authorization:|--header/u)
})

test('a custom-origin probe never claims to configure the fixed city bridge', () => {
  const text = bridgeGuidance('https://example.invalid').join('\n')
  assert.match(text, /only https:\/\/1f3d9.com/u)
  assert.match(text, /does not change/u)
})
