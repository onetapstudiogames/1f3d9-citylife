import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

import { compareVersions, parseVersion } from '../scripts/lib/semver.mjs'
import { decodeEntities, readAttribute, stripTags } from '../scripts/lib/html.mjs'
import { parseChangelogEntries } from '../scripts/lib/changelog.mjs'
import { buildDirectoryIndex, resolvePlaceArgument } from '../scripts/lib/city.mjs'
import { Grid, portraitRows, composeScene, toAnsi, toPlainText, DARK } from '../scripts/lib/grid.mjs'

const COMMANDS = ['help', 'links', 'donate', 'buy', 'schedule', 'follow', 'live', 'update', 'changelog', 'tools']

test('semver: parses and compares x.y.z versions', () => {
  assert.deepEqual(parseVersion('1.4.0'), [1, 4, 0])
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(compareVersions('1.3.0', '1.4.0'), -1)
  assert.equal(compareVersions('1.4.0', '1.3.0'), 1)
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0)
  assert.equal(compareVersions('x', '1.4.0'), null)
})

test('html: decodes entities and strips tags without a parser dependency', () => {
  assert.equal(decodeEntities('Solward&#39;s Wiki &amp; more'), "Solward's Wiki & more")
  assert.equal(stripTags('<p>hello <b>world</b></p>'), 'hello world')
  assert.equal(readAttribute('<a href="https://example.com" rel="external">', 'href'), 'https://example.com')
  assert.equal(readAttribute('<a rel="external">', 'href'), null)
})

test('changelog: splits versions into bullets and rejoins wrapped lines', () => {
  const sample = [
    '# Changelog',
    '',
    '## 1.4.0 - 2026-09-02',
    '',
    '- Add commands, so there is something to type.',
    '- A wrapped bullet that continues',
    '  onto a second physical line.',
    '',
    '## 1.3.0 - 2026-09-01',
    '',
    '- Older entry.',
    '',
  ].join('\n')
  const entries = parseChangelogEntries(sample)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].version, '1.4.0')
  assert.deepEqual(entries[0].bullets, [
    'Add commands, so there is something to type.',
    'A wrapped bullet that continues onto a second physical line.',
  ])
  assert.equal(entries[1].version, '1.3.0')
  assert.deepEqual(entries[1].bullets, ['Older entry.'])
})

test("changelog: this repo's own CHANGELOG.md parses into at least the 1.4.0 and 1.3.0 entries", async () => {
  const text = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const entries = parseChangelogEntries(text)
  const versions = entries.map((e) => e.version)
  assert.ok(versions.includes('1.4.0'))
  assert.ok(versions.includes('1.3.0'))
  for (const entry of entries) assert.ok(entry.bullets.length > 0, `${entry.version} has at least one bullet`)
})

test('city: directory index resolves ancestor chains and place-argument lookup', () => {
  const places = [
    { id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'the mainland' },
    { id: 3, parent_id: 2, name: 'first town' },
  ]
  const index = buildDirectoryIndex(places)
  assert.deepEqual(index.ancestorsOf(3), [3, 2, 1])
  assert.deepEqual(index.ancestorsOf(1), [1])
  assert.equal(resolvePlaceArgument('first town', places), 3)
  assert.equal(resolvePlaceArgument('mainland', places), 2)
  assert.equal(resolvePlaceArgument('42', places), 42)
  assert.equal(resolvePlaceArgument('nowhere', places), null)
  assert.equal(resolvePlaceArgument(undefined, places), null)
})

test('grid: portraitRows turns a 2x2-ish drawing into half-block cells without throwing', () => {
  const indices = Array(64).fill(null)
  indices[0] = 0
  indices[8] = 0
  const drawing = { palette: ['#ff0000'], indices }
  const rows = portraitRows(drawing, '#000000')
  assert.equal(rows.length, 4)
  assert.equal(rows[0].length, 8)
  assert.equal(rows[0][0][0], '▀')
  assert.equal(rows[0][0][1], '#ff0000')
})

test('grid: composeScene renders a small scene to both ANSI and plain text', () => {
  const room = {
    id: 1,
    name: 'the square',
    thingsCount: 2,
    residents: [{ id: 1, handle: 'kalani', has_drawing: false }],
    notes: [{ author: 'kalani', body: 'hello there' }],
  }
  const scene = composeScene({
    rooms: [room],
    theme: DARK,
    mode: 'desktop',
    followedHandle: null,
    followedPlaceName: null,
    totalResidents: 1,
    crumb: 'the world › the mainland',
    events: [],
    placeNameById: new Map([[1, 'the square']]),
  })
  assert.ok(scene instanceof Grid)
  const ansi = toAnsi(scene, DARK)
  assert.match(ansi, /\x1b\[38;2;/u)
  const plain = toPlainText(scene)
  assert.doesNotMatch(plain, /\x1b/u)
  assert.match(plain, /the square/u)
  assert.match(plain, /kalani/u)
})

test('every command has a scripts/<name>.mjs entry point and a skills/<name>/SKILL.md', async () => {
  for (const name of COMMANDS) {
    await assert.doesNotReject(() => access(new URL(`../scripts/${name}.mjs`, import.meta.url)), `${name}: script exists`)
    const skillPath = new URL(`../skills/${name}/SKILL.md`, import.meta.url)
    await assert.doesNotReject(() => access(skillPath), `${name}: skill folder exists`)
    const skill = await readFile(skillPath, 'utf8')
    assert.match(skill, new RegExp(`^name: ${name}$`, 'mu'), `${name}: frontmatter name matches folder`)
    assert.match(skill, /^description: /mu, `${name}: has a description`)
    assert.match(skill, /CLAUDE_PLUGIN_ROOT/u, `${name}: resolves the plugin root instead of a hardcoded path`)
  }
})

test('buy is Claude Code only and SETUP.md says so', async () => {
  const setup = await readFile(new URL('../SETUP.md', import.meta.url), 'utf8')
  assert.match(setup, /does not carry `buy`/u)
  assert.match(setup, /plain[\s\S]{0,10}link/u)
})

test('help and SETUP.md both name setup, connect, and key as not-yet-shipped', async () => {
  const help = await readFile(new URL('../scripts/help.mjs', import.meta.url), 'utf8')
  for (const name of ['setup', 'connect', 'key']) {
    assert.match(help, new RegExp(`'${name}'`, 'u'), `help.mjs lists ${name} as coming`)
  }
  const setup = await readFile(new URL('../SETUP.md', import.meta.url), 'utf8')
  assert.match(setup, /not in this release/u)
})
