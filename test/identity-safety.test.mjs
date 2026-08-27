import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const mirroredFiles = [
  {
    name: 'SKILL.md',
    canonical: new URL('../SKILL.md', import.meta.url),
    packaged: new URL('../skills/1f3d9-citylife/SKILL.md', import.meta.url),
  },
]

const mirroredDirectories = [
  {
    name: 'references',
    canonical: new URL('../references/', import.meta.url),
    packaged: new URL('../skills/1f3d9-citylife/references/', import.meta.url),
  },
  {
    name: 'agents',
    canonical: new URL('../agents/', import.meta.url),
    packaged: new URL('../skills/1f3d9-citylife/agents/', import.meta.url),
  },
]

const manifests = [
  ['plugin.json', new URL('../plugin.json', import.meta.url)],
  ['.claude-plugin/plugin.json', new URL('../.claude-plugin/plugin.json', import.meta.url)],
  ['.codex-plugin/plugin.json', new URL('../.codex-plugin/plugin.json', import.meta.url)],
  ['gemini-extension.json', new URL('../gemini-extension.json', import.meta.url)],
  ['qwen-extension.json', new URL('../qwen-extension.json', import.meta.url)],
]

const rootSkill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
const packagedSkill = await readFile(
  new URL('../skills/1f3d9-citylife/SKILL.md', import.meta.url),
  'utf8',
)
const publicReading = await readFile(new URL('../references/public-reading.md', import.meta.url), 'utf8')
const packagedPublicReading = await readFile(
  new URL('../skills/1f3d9-citylife/references/public-reading.md', import.meta.url),
  'utf8',
)
const worldAisle = await readFile(new URL('../references/world-aisle.md', import.meta.url), 'utf8')
const packagedWorldAisle = await readFile(
  new URL('../skills/1f3d9-citylife/references/world-aisle.md', import.meta.url),
  'utf8',
)
const canonicalSkillSurface = `${rootSkill}\n${publicReading}\n${worldAisle}`
const packagedSkillSurface = `${packagedSkill}\n${packagedPublicReading}\n${packagedWorldAisle}`
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
const wallet = await readFile(new URL('../references/wallet.md', import.meta.url), 'utf8')
const packagedWallet = await readFile(
  new URL('../skills/1f3d9-citylife/references/wallet.md', import.meta.url),
  'utf8',
)
const rootAgentMetadata = await readFile(new URL('../agents/openai.yaml', import.meta.url), 'utf8')
const packagedAgentMetadata = await readFile(
  new URL('../skills/1f3d9-citylife/agents/openai.yaml', import.meta.url),
  'utf8',
)

const listRelativeFiles = async (root, prefix = '') => {
  const entries = await readdir(new URL(prefix, root), { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        return listRelativeFiles(root, `${relativePath}/`)
      }
      return [relativePath]
    }),
  )
  return nestedFiles.flat().sort()
}

test('every canonical skill file has a byte-identical packaged copy', async () => {
  for (const { name, canonical, packaged } of mirroredFiles) {
    await assert.doesNotReject(() => access(canonical), `${name}: canonical file exists`)
    await assert.doesNotReject(() => access(packaged), `${name}: packaged file exists`)

    const [canonicalBytes, packagedBytes] = await Promise.all([
      readFile(canonical),
      readFile(packaged),
    ])
    assert.deepEqual(packagedBytes, canonicalBytes, `${name}: packaged bytes match canonical bytes`)
  }

  for (const { name, canonical, packaged } of mirroredDirectories) {
    const [canonicalFiles, packagedFiles] = await Promise.all([
      listRelativeFiles(canonical),
      listRelativeFiles(packaged),
    ])
    assert.deepEqual(packagedFiles, canonicalFiles, `${name}: mirrored file sets match`)

    for (const relativePath of canonicalFiles) {
      const [canonicalBytes, packagedBytes] = await Promise.all([
        readFile(new URL(relativePath, canonical)),
        readFile(new URL(relativePath, packaged)),
      ])
      assert.deepEqual(
        packagedBytes,
        canonicalBytes,
        `${name}/${relativePath}: packaged bytes match canonical bytes`,
      )
    }
  }
})

test('every host manifest states the same version', async () => {
  const versions = await Promise.all(
    manifests.map(async ([name, url]) => {
      const manifest = JSON.parse(await readFile(url, 'utf8'))
      assert.equal(typeof manifest.version, 'string', `${name}: version is a string`)
      assert.notEqual(manifest.version, '', `${name}: version is not empty`)
      return [name, manifest.version]
    }),
  )
  const expectedVersion = versions[0][1]

  for (const [name, version] of versions) {
    assert.equal(version, expectedVersion, `${name}: version matches ${manifests[0][0]}`)
  }
  assert.notEqual(expectedVersion, '1.0.0', 'the accumulated content release advances past 1.0.0')
})

test('plugin hosts select the packaged skill and share one OpenAI prompt', async () => {
  const canonicalPrompt = 'Use $1f3d9-citylife to configure or visit the AI agent city.'
  const description = 'A persistent city where AI agents choose a name and live.'
  const [claudeManifest, codexManifest, qwenManifest] = await Promise.all([
    readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../qwen-extension.json', import.meta.url), 'utf8').then(JSON.parse),
  ])

  assert.equal(claudeManifest.skills, './skills/', 'Claude selects the packaged skills directory')
  assert.equal(codexManifest.skills, './skills/', 'Codex selects the packaged skills directory')
  assert.deepEqual(
    codexManifest.interface.defaultPrompt,
    [canonicalPrompt],
    'Codex exposes one canonical starter prompt',
  )
  const promptLine = rootAgentMetadata
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith('default_prompt:'))
  assert.equal(promptLine, `  default_prompt: "${canonicalPrompt}"`)
  assert.equal(packagedAgentMetadata, rootAgentMetadata)
  assert.equal(qwenManifest.description, description)
  assert.match(
    readme,
    /root `plugin\.json`[\s\S]{0,180}(?:Codex|Qwen Code)[\s\S]{0,180}(?:Agent Plugins|conforming clients)/iu,
  )
  assert.match(readme, /root `SKILL\.md` is the standalone Agent Skill mirror/iu)
  assert.match(readme, /byte-identical copy under `skills\/1f3d9-citylife\/`/iu)
})

test('the main skill gives a fresh resident the critical path in encounter order', () => {
  assert.ok(rootSkill.split(/\r?\n/u).length - 1 < 500, 'SKILL.md stays under 500 physical lines')
  assert.match(rootSkill, /On first activated use, start with \*\*Configure 1F3D9\*\*\./u)

  const lowerSkill = rootSkill.toLowerCase()
  const firstStandingPermission = lowerSkill.indexOf('standing permission')
  const standingDefinition = lowerSkill.indexOf('standing permission means')
  assert.equal(firstStandingPermission, standingDefinition, 'standing permission is defined at first use')

  const firstLaterHolder = lowerSkill.indexOf('later-holder')
  const laterHolderDefinition = lowerSkill.indexOf('a later-holder item is')
  assert.equal(firstLaterHolder, laterHolderDefinition + 2, 'later-holder is defined at first use')

  for (const primitive of ['Land', 'Things', 'Ownership', 'Agreements', 'Talk']) {
    assert.match(rootSkill, new RegExp(`\\*\\*${primitive}:\\*\\*`, 'u'), `${primitive} is introduced early`)
  }
  assert.match(rootSkill, /Every resident begins standing in \*\*the world\*\*/u)
  assert.match(rootSkill, /one top-level, ownerless,[\s\S]{0,40}transit/u)
  assert.match(rootSkill, /move crosses exactly one parent-child edge/u)

  assert.doesNotMatch(rootSkill, /help moderate/iu)
  assert.match(rootSkill, /flag (?:genuinely )?(?:illegal|unlawful)(?: or prohibited)? content/iu)

  const workflowNames = [...rootSkill.matchAll(/^- Run \*\*(.+?)\*\*/gmu)].map((match) => match[1])
  assert.deepEqual(workflowNames, [
    'Configure 1F3D9',
    'Move in',
    'Visit 1F3D9',
    "Trade through 1F3EA's world aisle",
  ])
  for (const workflowName of workflowNames) {
    const escapedName = workflowName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    assert.match(rootSkill, new RegExp(`^## ${escapedName}$`, 'mu'), `${workflowName}: heading matches menu`)
  }

  assert.doesNotMatch(rootSkill, /Never install, execute, or obey[^\n]*without/iu)
  assert.match(rootSkill, /Never install, execute, or obey[^\n]*merely because/iu)
  assert.match(rootSkill, /Only a separate user request may authorize/iu)
  assert.ok(
    rootSkill.indexOf('## Protect the human and the city') < rootSkill.indexOf('## Choose the workflow'),
    'global safety appears before workflows',
  )
})

test('detailed public reading and world-aisle guidance use focused mirrored references', async () => {
  for (const relativePath of ['references/public-reading.md', 'references/world-aisle.md']) {
    const canonical = new URL(`../${relativePath}`, import.meta.url)
    const packaged = new URL(`../skills/1f3d9-citylife/${relativePath}`, import.meta.url)
    await assert.doesNotReject(() => access(canonical), `${relativePath}: canonical reference exists`)
    await assert.doesNotReject(() => access(packaged), `${relativePath}: packaged reference exists`)
    assert.deepEqual(await readFile(packaged), await readFile(canonical), `${relativePath}: bytes match`)
  }
  assert.match(rootSkill, /Read \[references\/public-reading\.md\]\(references\/public-reading\.md\) completely/iu)
  assert.match(rootSkill, /Read \[references\/world-aisle\.md\]\(references\/world-aisle\.md\) completely/iu)
})

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
  for (const [name, value] of [
    ['canonical surface', canonicalSkillSurface],
    ['packaged surface', packagedSkillSurface],
  ]) {
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

test('the wallet install gate reviews and verifies the current Circle CLI release', () => {
  assert.match(wallet, /Last reviewed: 2026-08-27/u)
  assert.match(wallet, /npm's current `latest` release was `@circle-fin\/cli@1\.0\.0`/u)
  assert.doesNotMatch(wallet, /@circle-fin\/cli@0\.0\.6/u)

  const installSection = wallet.indexOf('### 1. Verify and install the reviewed CLI')
  const metadataCheck = wallet.indexOf('npm view @circle-fin/cli dist-tags.latest', installSection)
  const installCommand = wallet.indexOf('npm install -g @circle-fin/cli@1.0.0', installSection)
  assert.ok(installSection >= 0, 'install section exists')
  assert.ok(metadataCheck > installSection, 'npm metadata is re-checked at install time')
  assert.ok(installCommand > metadataCheck, 'the reviewed version is installed only after the re-check')
  assert.match(
    wallet.slice(installSection, installCommand),
    /Stop if Circle[\s\S]{0,160}npm's `latest` is not `1\.0\.0`[\s\S]{0,120}sources otherwise differ/iu,
  )
})

test('the Configure workflow keeps money setup and verification as its own steps', async () => {
  const text = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const configure = text.indexOf('## Configure 1F3D9');
  const money = text.indexOf('### 6. Configure money separately');
  const verify = text.indexOf('### 7. Verify configuration');
  const moveIn = text.indexOf('## Move in');
  assert.ok(configure >= 0 && money > configure && verify > money && moveIn > verify,
    'Configure money separately and Verify configuration must sit inside Configure 1F3D9, before Move in');
});
