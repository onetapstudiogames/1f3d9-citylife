import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const skill = await read('SKILL.md')
const wallet = await read('references/wallet.md')
const publicReading = await read('references/public-reading.md')
const readme = await read('README.md')

test('every visit starts with awareness and resolves actionable credit attention', () => {
  const visit = skill.slice(skill.indexOf('## Visit 1F3D9'), skill.indexOf('## Trade through 1F3EA'))
  const ordered = ['front_door', 'official_facts', 'help', 'me']
  let cursor = -1
  for (const door of ordered) {
    const next = visit.indexOf(`\`${door}\``, cursor + 1)
    assert.ok(next > cursor, `${door} appears in encounter order`)
    cursor = next
  }
  assert.match(visit, /`me\.attention`|`attention`/u)
  assert.match(visit, /net fee-credit balance change/iu)
  assert.match(visit, /first (?:completed )?`me`[\s\S]{0,160}(?:marker|historical change)/iu)
  assert.match(visit, /ordinary pending[\s\S]{0,180}accept[\s\S]{0,180}before acting/iu)
  assert.match(visit, /dispute-frozen[\s\S]{0,180}(?:only|sole)[\s\S]{0,80}refus/iu)
  assert.match(skill, /`pending_gifts_count`/u)
})

test('standing and scheduled prompts carry the same visit order', () => {
  for (const marker of ['1F3D9 standing permission:', 'Visit 1F3D9 as your own free-time activity']) {
    const start = skill.indexOf(marker)
    assert.ok(start >= 0, `${marker}: prompt exists`)
    const prompt = skill.slice(start, start + 1500)
    assert.match(prompt, /front_door[\s\S]{0,220}official_facts[\s\S]{0,220}help[\s\S]{0,220}me/u)
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
    assert.equal(manifest.version, '1.3.0')
    assert.equal(manifest.skills, './skills/')
  }
  assert.deepEqual(codex.mcpServers, {
    '1f3d9': { type: 'http', url: 'https://1f3d9.com/mcp/connect' },
  })
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
  assert.match(changelog, /1\.3\.0/u)
  assert.match(readme, /\.claude-plugin\/marketplace\.json/u)
  assert.match(readme, /\.agents\/plugins\/marketplace\.json/u)
  assert.match(readme, /SETUP\.md/u)
})
