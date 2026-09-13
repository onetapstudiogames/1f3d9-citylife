// Directory listings rot silently: a renamed asset, a display name that grows
// past a store's 30-character field, or a legal URL that quietly becomes a
// relative path all still parse as valid JSON and still pass every other test
// here. This file is the guard for exactly that -- it walks every manifest
// this repo ships and checks the listing metadata itself, so the next edit
// cannot leave a submission field broken.
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const MANIFESTS = [
  'plugin.json',
  'gemini-extension.json',
  'qwen-extension.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  '.codex-plugin/plugin.json',
]
const OPENAI_YAML = [
  'agents/openai.yaml',
  'skills/1f3d9-citylife/agents/openai.yaml',
]

const NAME_LIMIT = 30
const SHORT_TEXT_FIELDS = ['displayName', 'shortDescription']
const IMAGE_FIELDS = ['composerIcon', 'logo', 'icon', 'image']
const LEGAL_URL_FIELDS = ['privacyPolicyURL', 'termsOfServiceURL', 'supportURL']

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** Every `[jsonPath, value]` pair in `node` whose key is one of `fields`. */
function collect(node, fields, path = '') {
  if (Array.isArray(node)) return node.flatMap((item, index) => collect(item, fields, `${path}[${index}]`))
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key
    if (fields.includes(key)) return [[here, value]]
    return collect(value, fields, here)
  })
}

const manifests = await Promise.all(
  MANIFESTS.map(async (path) => [path, JSON.parse(await read(path))]),
)

const yamlFields = await Promise.all(OPENAI_YAML.map(async (path) => {
  const source = await read(path)
  const field = (name) => source.match(new RegExp(`^\\s*${name}:\\s*"([^"]+)"\\s*$`, 'mu'))?.[1]
  return [path, { displayName: field('display_name'), shortDescription: field('short_description') }]
}))

test('every listing display name and short description fits a 30-character field', () => {
  let found = 0
  for (const [path, manifest] of manifests) {
    for (const [field, value] of collect(manifest, SHORT_TEXT_FIELDS)) {
      found += 1
      assert.equal(typeof value, 'string', `${path}: ${field} is a string`)
      assert.ok(value.trim().length > 0, `${path}: ${field} is not blank`)
      assert.ok(
        value.length <= NAME_LIMIT,
        `${path}: ${field} is ${value.length} characters, over the ${NAME_LIMIT}-character listing limit: ${value}`,
      )
    }
  }
  for (const [path, fields] of yamlFields) {
    for (const [field, value] of Object.entries(fields)) {
      found += 1
      assert.equal(typeof value, 'string', `${path}: ${field} is a string`)
      assert.ok(value.length <= NAME_LIMIT, `${path}: ${field} is ${value.length} characters, over ${NAME_LIMIT}`)
    }
  }
  assert.ok(found >= 3, `listing short-text fields are still present (found ${found})`)
})

test('listing names and short descriptions agree across manifests and OpenAI YAML', () => {
  const codex = manifests.find(([path]) => path === '.codex-plugin/plugin.json')?.[1]
  assert.ok(codex?.interface, 'Codex listing defines the store presentation')
  const names = manifests.flatMap(([path, manifest]) => collect(manifest, ['displayName']).map(([field, value]) => [`${path}: ${field}`, value]))
  const descriptions = manifests.flatMap(([path, manifest]) => collect(manifest, ['shortDescription']).map(([field, value]) => [`${path}: ${field}`, value]))
  for (const [path, fields] of yamlFields) {
    names.push([`${path}: display_name`, fields.displayName])
    descriptions.push([`${path}: short_description`, fields.shortDescription])
  }
  assert.ok(names.length >= 3)
  assert.ok(descriptions.length >= 3)
  for (const [where, value] of names) assert.equal(value, codex.interface.displayName, where)
  for (const [where, value] of descriptions) assert.equal(value, codex.interface.shortDescription, where)
})

test('every listing image path a manifest declares exists in the package', async () => {
  let found = 0
  for (const [path, manifest] of manifests) {
    for (const [field, value] of collect(manifest, IMAGE_FIELDS)) {
      found += 1
      assert.equal(typeof value, 'string', `${path}: ${field} is a string`)
      assert.match(value, /^\.\/[\w./-]+\.(?:png|jpg|jpeg|svg|webp)$/u, `${path}: ${field} is a packaged relative image path`)
      await access(new URL(`../${value.slice(2)}`, import.meta.url))
    }
  }
  assert.ok(found >= 2, `listing image fields are still present (found ${found})`)
})

test('the privacy, terms, and support URLs stay well-formed absolute https links', () => {
  const seen = new Set()
  for (const [path, manifest] of manifests) {
    for (const [field, value] of collect(manifest, LEGAL_URL_FIELDS)) {
      seen.add(field.split('.').at(-1))
      assert.equal(typeof value, 'string', `${path}: ${field} is a string`)
      let url
      assert.doesNotThrow(() => { url = new URL(value) }, `${path}: ${field} parses as an absolute URL`)
      assert.equal(url.protocol, 'https:', `${path}: ${field} uses https`)
      assert.ok(url.hostname.includes('.'), `${path}: ${field} names a real host`)
      assert.equal(url.hash, '', `${path}: ${field} carries no fragment`)
      assert.notEqual(url.pathname, '/', `${path}: ${field} points at its own page, not the site root`)
    }
  }
  assert.deepEqual([...seen].sort(), [...LEGAL_URL_FIELDS].sort(), 'all three listing legal URLs are declared')
})
