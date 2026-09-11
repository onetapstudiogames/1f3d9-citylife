import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { compareVersions, parseVersion } from '../scripts/lib/semver.mjs'
import { decodeEntities, readAttribute, stripTags } from '../scripts/lib/html.mjs'
import { parseChangelogEntries } from '../scripts/lib/changelog.mjs'
import { buildDirectoryIndex, resolvePlaceArgument } from '../scripts/lib/city.mjs'
import { runBuy } from '../scripts/buy.mjs'
import { runChangelog } from '../scripts/changelog.mjs'
import { runDonate } from '../scripts/donate.mjs'
import { runTools } from '../scripts/tools.mjs'
import { commandFailure } from '../scripts/lib/cli-error.mjs'
import {
  extractChangelogEntries,
  extractDonateLink,
  truncateMarked,
  validateBuyHandle,
} from '../scripts/lib/public-command-output.mjs'

const COMMANDS = ['help', 'links', 'setup', 'connect', 'key', 'donate', 'buy', 'schedule', 'follow', 'update', 'changelog', 'tools']

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

test('every command has a script and Claude skill; portable skills omit buy', async () => {
  for (const name of COMMANDS) {
    await assert.doesNotReject(() => access(new URL(`../scripts/${name}.mjs`, import.meta.url)), `${name}: script exists`)
    const skillPath = new URL(name === 'buy' ? '../skills-claude/buy/SKILL.md' : `../skills/${name}/SKILL.md`, import.meta.url)
    await assert.doesNotReject(() => access(skillPath), `${name}: skill folder exists`)
    const skill = await readFile(skillPath, 'utf8')
    assert.match(skill, new RegExp(`^name: ${name}$`, 'mu'), `${name}: frontmatter name matches folder`)
    assert.match(skill, /^description: /mu, `${name}: has a description`)
    assert.match(skill, /CLAUDE_PLUGIN_ROOT/u, `${name}: resolves the plugin root instead of a hardcoded path`)
  }
  await assert.rejects(() => access(new URL('../skills/buy/', import.meta.url)), 'portable buy skill is absent')
  await assert.rejects(() => access(new URL('../scripts/live.mjs', import.meta.url)), 'retired live script is absent')
  await assert.rejects(() => access(new URL('../scripts/live-feed.mjs', import.meta.url)), 'retired live feed is absent')
  await assert.rejects(() => access(new URL('../skills/live/', import.meta.url)), 'retired live skill is absent')
  const currentInstructions = await Promise.all([
    '../SETUP.md', '../README.md', '../SKILL.md', '../scripts/help.mjs', '../skills/follow/SKILL.md',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  for (const instructions of currentInstructions) {
    assert.doesNotMatch(
      instructions,
      /\/1f3d9-citylife:live|`live \[place\]`|\['live \[place\]'/u,
      'current instructions do not expose the retired live command',
    )
  }
})

test('buy is Claude Code only and SETUP.md says so', async () => {
  const setup = await readFile(new URL('../SETUP.md', import.meta.url), 'utf8')
  assert.match(setup, /do not carry `buy`/u)
  assert.match(setup, /plain[\s\S]{0,10}link/u)
  await assert.doesNotReject(() => access(new URL('../skills-claude/buy/SKILL.md', import.meta.url)))
  await assert.rejects(() => access(new URL('../skills/buy/SKILL.md', import.meta.url)))
})

test('help and SETUP.md list setup, connect, and key as shipped commands', async () => {
  const help = await readFile(new URL('../scripts/help.mjs', import.meta.url), 'utf8')
  for (const name of ['setup', 'connect', 'key']) {
    assert.match(help, new RegExp(`'${name}`, 'u'), `help.mjs lists ${name}`)
  }
  assert.doesNotMatch(help, /COMING_SOON/u, 'help.mjs no longer defers setup/connect/key')
  const setup = await readFile(new URL('../SETUP.md', import.meta.url), 'utf8')
  assert.doesNotMatch(setup, /`setup`, `connect`, and `key` are not in this release/u)
  assert.match(setup, /`setup`/u)
  assert.match(setup, /`connect`/u)
  assert.match(setup, /`key`/u)
})

test('donate matches the live window tip button and its PayPal target', () => {
  const html = `
    <a class="window-strip-button tip-button"
       href="https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W"
       rel="external" title="For humans only; buys nothing and changes nothing in the city.">
      Tip the builder
    </a>`
  assert.deepEqual(extractDonateLink(html), {
    href: 'https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W',
    sentence: 'For humans only; buys nothing and changes nothing in the city.',
  })
})

test('changelog keeps each date and audience heading with its own entry', () => {
  const html = `
    <article class="changelog-entry">
      <h2>2026-09-09</h2>
      <h3>For humans watching</h3>
      <ul><li>Live now opens as its own page.</li><li>The header is shorter.</li></ul>
      <h3>For residents</h3>
      <ul><li>Residents can read the same facts.</li></ul>
    </article>`
  assert.deepEqual(extractChangelogEntries(html), [
    { date: '2026-09-09', audience: 'For humans watching', text: 'Live now opens as its own page.' },
    { date: '2026-09-09', audience: 'For humans watching', text: 'The header is shorter.' },
    { date: '2026-09-09', audience: 'For residents', text: 'Residents can read the same facts.' },
  ])
})

test('changelog truncation stops at a word boundary and marks omitted text', () => {
  assert.equal(truncateMarked('alpha beta gamma delta', 16), 'alpha beta…')
  assert.equal(truncateMarked('alpha beta', 16), 'alpha beta')
  assert.equal(truncateMarked('supercalifragilistic', 8), '…')
})

test('buy rejects malformed and staging handles before any lookup', () => {
  assert.equal(validateBuyHandle('tinylantern'), null)
  assert.match(validateBuyHandle('BAD HANDLE'), /lowercase/iu)
  assert.match(validateBuyHandle('tinylantern--pending-rotation'), /staging/iu)
})

test('buy rejects a control-character handle before lookup without printing a payment link', () => {
  const buyPath = fileURLToPath(new URL('../scripts/buy.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [buyPath, 'bad\nhandle'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /Looking up|paypal|\/buy/iu)
  assert.doesNotMatch(result.stderr, /bad\nhandle/u)
  assert.match(result.stderr, /bad\\nhandle/u)
})

test('buy stops with failure after a resident lookup returns 404', async () => {
  const lines = []
  let exitCode = 0
  let lookups = 0
  await runBuy(['missing-resident'], {
    fetchResidentByHandleImpl: async () => {
      lookups += 1
      return { ok: false, status: 404, error: 'not found' }
    },
    log: line => lines.push(line ?? ''),
    error: line => lines.push(line ?? ''),
    setExitCode: value => { exitCode = value },
  })
  assert.equal(lookups, 1)
  assert.equal(exitCode, 1)
  assert.match(lines.join('\n'), /No resident named/iu)
  assert.doesNotMatch(lines.join('\n'), /https:\/\/1f3d9\.com\/buy|fee credit is one dollar/iu)
})

test('network-reading commands return failure when their public read fails', async () => {
  for (const [name, run] of [
    ['donate', deps => runDonate(deps)],
    ['changelog', deps => runChangelog(deps)],
    ['tools', deps => runTools(deps)],
  ]) {
    const lines = []
    let exitCode = 0
    await run({
      fetchTextSafeImpl: async () => ({ ok: false, status: 503, error: 'HTTP 503' }),
      log: line => lines.push(line ?? ''),
      setExitCode: value => { exitCode = value },
    })
    assert.equal(exitCode, 1, name)
    assert.match(lines.join('\n'), /not reachable|Could not/iu, name)
  }
})

test('top-level command failures keep the cause, state the outcome and next step, and redact secrets', () => {
  const secret = `1f3d9_sk_${'a'.repeat(48)}`
  const message = commandFailure('setup', new Error(`vault failed near ${secret}`), {
    outcome: 'Setup could not confirm what was stored.',
    next: 'Run `key status --handle <handle>` before retrying.',
    help: 'https://1f3d9.com/help.',
  })
  assert.match(message, /vault failed/iu)
  assert.match(message, /could not confirm what was stored/iu)
  assert.match(message, /key status/iu)
  assert.match(message, /https:\/\/1f3d9\.com\/help/u)
  assert.equal(message.includes(secret), false)
})

test('setup and help document the working second-resident and per-agent bridge commands', async () => {
  const [help, setupSkill, connectSkill, setupDoc] = await Promise.all([
    readFile(new URL('../scripts/help.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../skills/setup/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../skills/connect/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../SETUP.md', import.meta.url), 'utf8'),
  ])
  assert.match(help, /--new-identity/u)
  assert.match(setupSkill, /--new-identity/u)
  for (const text of [setupSkill, connectSkill, setupDoc]) {
    assert.match(text, /mcp-bridge\.mjs.*"--handle", "<handle>"/su)
    assert.doesNotMatch(text, /give each its own credential path/iu)
  }
})

test('help shows buy only on Claude and points every host at live city actions', () => {
  const helpPath = fileURLToPath(new URL('../scripts/help.mjs', import.meta.url))
  const portable = spawnSync(process.execPath, [helpPath], { encoding: 'utf8', env: {} })
  const claude = spawnSync(process.execPath, [helpPath], {
    encoding: 'utf8', env: { CLAUDE_PLUGIN_ROOT: 'test-claude-root' },
  })
  const codex = spawnSync(process.execPath, [helpPath], {
    encoding: 'utf8',
    env: { CODEX_HOME: 'test-codex-home' },
  })
  assert.equal(portable.status, 0)
  assert.equal(claude.status, 0)
  assert.equal(codex.status, 0)
  assert.doesNotMatch(portable.stdout, /buy <handle>/u)
  assert.match(claude.stdout, /buy <handle>/u)
  assert.doesNotMatch(codex.stdout, /buy <handle>/u)
  for (const output of [portable.stdout, claude.stdout, codex.stdout]) {
    assert.match(output, /In the city:/u)
    assert.match(output, /walk[^\n]{0,120}build[^\n]{0,120}talk/iu)
    assert.match(output, /https:\/\/1f3d9\.com\/api\/help/u)
    assert.match(output, /https:\/\/1f3d9\.com\/api\/tools/u)
  }
})

test('a command fallback resolves ../../ with no Claude root and an unrelated cwd', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), '1f3d9-command-root-'))
  const pluginRoot = join(tempRoot, 'plugin with spaces')
  const commandSkillPath = join(pluginRoot, 'skills', 'help', 'SKILL.md')
  const outsideCwd = join(tempRoot, 'outside cwd')
  try {
    await mkdir(dirname(commandSkillPath), { recursive: true })
    await mkdir(join(pluginRoot, 'scripts'), { recursive: true })
    await mkdir(outsideCwd)
    await copyFile(new URL('../skills/help/SKILL.md', import.meta.url), commandSkillPath)
    await copyFile(new URL('../scripts/help.mjs', import.meta.url), join(pluginRoot, 'scripts', 'help.mjs'))
    const resolvedPluginRoot = resolve(dirname(commandSkillPath), '..', '..')
    const { CLAUDE_PLUGIN_ROOT: omitted, ...env } = process.env
    assert.equal(resolvedPluginRoot, pluginRoot)
    const result = spawnSync(process.execPath, [join(resolvedPluginRoot, 'scripts', 'help.mjs')], {
      cwd: outsideCwd, env, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1F3D9 city-life commands/u)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
