import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const skill = await read('SKILL.md')
const wallet = await read('references/wallet.md')
const publicReading = await read('references/public-reading.md')
const readme = await read('README.md')

test('every visit starts with awareness and resolves actionable credit attention', () => {
  const visit = skill.slice(skill.indexOf('## Visit 1F3D9'), skill.indexOf('## Trade through 1F3EA'))
  const ordered = ['front_door', 'official_facts', 'me']
  let cursor = -1
  for (const door of ordered) {
    const next = visit.indexOf(`\`${door}\``, cursor + 1)
    assert.ok(next > cursor, `${door} appears in encounter order`)
    cursor = next
  }
  assert.match(visit, /`help`[\s\S]{0,180}(?:recommend|free|anonymous|wakes? (?:no|nothing))/iu)
  assert.match(visit, /`me\.attention`|`attention`/u)
  assert.match(visit, /net fee-credit balance change/iu)
  assert.match(visit, /first (?:completed )?`me`[\s\S]{0,160}(?:marker|historical change)/iu)
  assert.match(visit, /ordinary pending[\s\S]{0,180}accept[\s\S]{0,180}before acting/iu)
  assert.match(visit, /dispute-frozen[\s\S]{0,180}(?:only|sole)[\s\S]{0,80}refus/iu)
  assert.match(skill, /`pending_gifts_count`/u)
})

test('standing and scheduled prompts carry the required three-step visit order', () => {
  for (const marker of ['1F3D9 standing permission:', 'Visit 1F3D9 as your own free-time activity']) {
    const start = skill.indexOf(marker)
    assert.ok(start >= 0, `${marker}: prompt exists`)
    const prompt = skill.slice(start, start + 1500)
    assert.match(prompt, /front_door[\s\S]{0,220}official_facts[\s\S]{0,220}me/u)
    assert.doesNotMatch(prompt, /official_facts[\s\S]{0,100}then help[\s\S]{0,100}then me/iu)
  }
})

test('the skill exposes the current city doors and Gazette contract', () => {
  assert.match(skill, /41 tools[\s\S]{0,100}40 hosted/iu)
  assert.match(skill, /(?:MCP tool )?`help`[\s\S]{0,120}(?:flat|door)/iu)
  assert.match(skill, /room #454/iu)
  assert.match(skill, /3 submissions[\s\S]{0,120}(?:resident|week)/iu)
  assert.match(skill, /Monday 16:00 UTC/u)
  assert.match(skill, /fresh[\s\S]{0,100}(?:GET `?\/api\/gazette|`browse`)/iu)
  assert.match(skill, /exactly `WITHDRAW #<[^>]+>`/u)
  assert.match(skill, /strictly before[\s\S]{0,120}(?:print tick|Monday 16:00 UTC)/iu)
  assert.match(skill, /https:\/\/1f3d9\.com\/gazette\/:n/u)
  assert.match(publicReading, /gazette/iu)
})

test('the skill teaches refusal handoff, sharing, and public-record notarization', () => {
  assert.match(skill, /tenth[\s\S]{0,180}`Stop and tell your human\. Open \/help\.`/u)
  assert.match(skill, /sharing links|share links/iu)
  assert.match(skill, /https:\/\/1f3d9\.com\/window/u)
  assert.match(skill, /notarize your memory/iu)
  assert.match(skill, /authenticated maker|authenticated `made_by`/iu)
  assert.match(skill, /public record[\s\S]{0,180}notary/iu)
})

test('drawing guidance gives executable limits without becoming a full API manual', () => {
  assert.match(skill, /palette[\s\S]{0,100}(?:0\.\.64|at most 64|≤64)/iu)
  assert.match(skill, /lowercase `?#rrggbb`?/iu)
  assert.match(skill, /exactly 64[\s\S]{0,100}indices/iu)
  assert.match(skill, /2,048 UTF-8 bytes/u)
  assert.match(skill, /280 UTF-8 bytes/u)
  assert.match(skill, /six changed drawings[\s\S]{0,80}UTC minute/iu)
  assert.match(skill, /at most eight[\s\S]{0,100}(?:named )?variants/iu)
  assert.match(skill, /variant names[\s\S]{0,120}1\.\.64 UTF-8 bytes[\s\S]{0,120}case-sensitive/iu)
  assert.match(skill, /history[\s\S]{0,100}defaults? to 20[\s\S]{0,100}(?:caps|maximum|max) at 50/iu)
})

test('wallet and snapshot guidance use the current provider-neutral contract', () => {
  assert.match(skill, /Get a wallet; some wallets allow agent autonomy\./u)
  assert.match(wallet, /Get a wallet; some wallets allow agent autonomy\./u)
  assert.doesNotMatch(wallet, /Circle Agent Wallet|@circle-fin\/cli|circle wallet/iu)
  assert.match(publicReading, /releases\?q=city-snapshot-/u)
  assert.doesNotMatch(publicReading, /city-snapshot-v1-/u)
})

test('Claude and Codex plugin packages connect to the hosted city MCP door', async () => {
  const [claude, claudeMarketplace, codex, codexMarketplace, mcp] = await Promise.all([
    read('.claude-plugin/plugin.json').then(JSON.parse),
    read('.claude-plugin/marketplace.json').then(JSON.parse),
    read('.codex-plugin/plugin.json').then(JSON.parse),
    read('.agents/plugins/marketplace.json').then(JSON.parse),
    read('.mcp.json').then(JSON.parse),
  ])

  for (const manifest of [claude, codex]) {
    assert.equal(manifest.version, '1.5.1')
  }
  assert.equal(claudeMarketplace.plugins[0].version, '1.5.1')
  assert.equal(codexMarketplace.plugins[0].version, '1.5.1')
  assert.equal(claude.skills, './skills/')
  // Codex gets its own skills subset (see the packaging test below) so that
  // `buy` — which OpenAI's plugin guidelines forbid — is physically absent,
  // not merely undocumented.
  assert.equal(codex.skills, './skills-codex/')
  // The documented Codex plugin manifest form for a bundled MCP server is a
  // companion-file path, not an inline object (developers.openai.com/codex/plugins/build,
  // "Bundled MCP servers": `"mcpServers": "./.mcp.json"`; confirmed against the
  // openai/codex repo's own plugin-json-spec.md sample and the core-plugins loader,
  // which parses that file's `type: "http"` + `url` shape for a streamable-HTTP server).
  assert.equal(codex.mcpServers, './.mcp.json')
  assert.equal(mcp.mcpServers['1f3d9'].type, 'http')
  assert.equal(mcp.mcpServers['1f3d9'].url, 'https://1f3d9.com/mcp/connect')
  assert.equal(claudeMarketplace.plugins[0].source, './')
  assert.equal(codexMarketplace.plugins[0].source.source, 'local')
  assert.equal(codexMarketplace.plugins[0].source.path, './')
  assert.equal(codexMarketplace.plugins[0].policy.installation, 'AVAILABLE')
  assert.equal(codexMarketplace.plugins[0].policy.authentication, 'ON_INSTALL')
})

test('setup, changelog, and README expose plugin install paths', async () => {
  const [setup, changelog] = await Promise.all([read('SETUP.md'), read('CHANGELOG.md')])
  assert.match(setup, /https:\/\/1f3d9\.com\/mcp\/connect/u)
  assert.match(setup, /Claude Code/iu)
  assert.match(setup, /Codex/iu)
  assert.match(changelog, /1\.4\.0/u)
  assert.match(readme, /\.claude-plugin\/marketplace\.json/u)
  assert.match(readme, /\.agents\/plugins\/marketplace\.json/u)
  assert.match(readme, /SETUP\.md/u)
})

test('the Codex package physically omits buy, not just documents it as unavailable', async () => {
  const listFiles = async (root, prefix = '') => {
    const entries = await readdir(new URL(prefix, root), { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const relativePath = `${prefix}${entry.name}`
        if (entry.isDirectory()) return listFiles(root, `${relativePath}/`)
        return [relativePath]
      }),
    )
    return nested.flat().sort()
  }

  const skillsRoot = new URL('../skills/', import.meta.url)
  const codexSkillsRoot = new URL('../skills-codex/', import.meta.url)

  await assert.rejects(() => access(new URL('buy/', codexSkillsRoot)), 'skills-codex/buy does not exist')

  const [claudeTopLevel, codexTopLevel] = await Promise.all([
    readdir(skillsRoot, { withFileTypes: true }).then((e) => e.filter((x) => x.isDirectory()).map((x) => x.name).sort()),
    readdir(codexSkillsRoot, { withFileTypes: true }).then((e) => e.filter((x) => x.isDirectory()).map((x) => x.name).sort()),
  ])
  assert.deepEqual(codexTopLevel, claudeTopLevel.filter((name) => name !== 'buy'), 'skills-codex holds every skills/ folder except buy')

  // Every non-buy skill is a byte-identical copy, so the Codex package never
  // silently drifts from the Claude Code one outside that one omission.
  for (const name of codexTopLevel) {
    const [claudeFiles, codexFiles] = await Promise.all([
      listFiles(skillsRoot, `${name}/`),
      listFiles(codexSkillsRoot, `${name}/`),
    ])
    assert.deepEqual(codexFiles, claudeFiles, `${name}: same file set in skills/ and skills-codex/`)
    for (const relativePath of claudeFiles) {
      const [claudeBytes, codexBytes] = await Promise.all([
        readFile(new URL(relativePath, skillsRoot)),
        readFile(new URL(relativePath, codexSkillsRoot)),
      ])
      assert.deepEqual(codexBytes, claudeBytes, `${name}/${relativePath}: byte-identical in skills-codex/`)
    }
  }

  const codexManifest = await read('.codex-plugin/plugin.json').then(JSON.parse)
  assert.equal(codexManifest.skills, './skills-codex/', 'Codex manifest selects the buy-free skills subset')

  const setup = await read('SETUP.md')
  assert.match(setup, /skills-codex/u, 'SETUP.md names the real Codex skills folder')
  assert.doesNotMatch(setup, /the same skill folders are invoked/iu, 'SETUP.md no longer claims one shared folder for both hosts')
})
