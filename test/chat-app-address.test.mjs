// Plugin 1.9.69: new ChatGPT and Claude connections go to the city's app
// address, ChatGPT starts from the city's ChatGPT listing, and every
// connection already at /mcp/connect keeps /mcp/connect. The developer in
// every manifest is TWAMD LLC, and the README sends people to the city's own
// setup page instead of carrying install steps.
// Plugin 1.9.70: new Gemini connections use the app address too.
// Plugin 1.9.71: the plugin no longer describes how Gemini asks before an action.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const collapse = (text) => text.replace(/\s+/gu, ' ')

const APP_ADDRESS = 'https://1f3d9.com/mcp/app'
const CONNECT_ADDRESS = 'https://1f3d9.com/mcp/connect'
const CHATGPT_LISTING = 'https://chatgpt.com/plugins/plugin_asdk_app_6aca72a3d9188191a080e794f12fd34a'
const DEVELOPER = 'TWAMD LLC'
const CONTACT = 'adam@twamd.com'

const CHATGPT_STEP =
  `ChatGPT: open the city's ChatGPT listing, ${CHATGPT_LISTING}, and tap Install plugin. ` +
  'If that does not work, open https://chatgpt.com/plugins?directoryTab=personal in a browser. ' +
  'Tap +, then Create MCP app. Name it 1F3D9 and paste `https://1f3d9.com/mcp/app` in the connection field. ' +
  'Choose "I understand and want to continue", then Create. ' +
  'A ChatGPT app already connected at `https://1f3d9.com/mcp/connect` keeps that address.'
const CHATGPT_KEEPS_SENTENCE = 'A ChatGPT app already connected at `https://1f3d9.com/mcp/connect` keeps that address.'
const CHATGPT_STEP_FILES = [
  'SETUP.md',
  'references/resident-guide.md',
  'skills/1f3d9-citylife/references/resident-guide.md',
  'skills/connect/SKILL.md',
]
const CONNECT_SCRIPT_CHATGPT_LINE =
  `'ChatGPT: open ${CHATGPT_LISTING} and tap Install plugin; if that does not work, ` +
  `add an MCP app at https://chatgpt.com/plugins?directoryTab=personal with ${APP_ADDRESS}.'`

const HOSTED_STEP_ONE =
  '1. A new chat app connection uses `https://1f3d9.com/mcp/app`. A connection already at ' +
  '`https://1f3d9.com/mcp/connect` keeps that address and reconnects there. `/mcp` is ' +
  'only for key-capable local clients. Replace an old ChatGPT `/mcp` connection rather ' +
  'than reopening it.'
const GUIDES = ['references/resident-guide.md', 'skills/1f3d9-citylife/references/resident-guide.md']

const CLAUDE_SETUP_SENTENCE =
  'For a new Claude connection, paste `https://1f3d9.com/mcp/app`; a Claude connection already at ' +
  '`https://1f3d9.com/mcp/connect` keeps that address.'

// Words a chat app or a directory listing must not show in added text.
const AVOIDED_LISTING_WORDS = /\b(?:spend\w*|spent|money|pay\w*|paid|wallet\w*|buy\w*|bought|purchas\w*|cost\w*|pric\w*|charg\w*|cash\w*|dollar\w*|fund\w*|safe\w*|safety|secur\w*|guard\w*|flag\w*|usdc)\b/iu

function chatgptLines(text) {
  return text.split(/\r?\n/u).filter((line) => /^\s*(?:console\.log\()?'?ChatGPT:/u.test(line))
}

test('the four ChatGPT steps are one sentence that starts at the listing and uses the app address', async () => {
  for (const path of CHATGPT_STEP_FILES) {
    const lines = chatgptLines(await read(path))
    assert.deepEqual(lines, [CHATGPT_STEP], `${path}: one ChatGPT step, the shared sentence`)
  }
})

test('no ChatGPT step tells a new connection to use /mcp/connect', async () => {
  for (const path of [...CHATGPT_STEP_FILES, 'scripts/connect.mjs']) {
    for (const line of chatgptLines(await read(path))) {
      const forNewConnections = line.replace(CHATGPT_KEEPS_SENTENCE, '')
      assert.ok(!forNewConnections.includes(CONNECT_ADDRESS), `${path}: new ChatGPT connections are not sent to /mcp/connect`)
      assert.ok(forNewConnections.includes(APP_ADDRESS), `${path}: new ChatGPT connections use /mcp/app`)
      assert.ok(forNewConnections.includes(CHATGPT_LISTING), `${path}: ChatGPT starts from the listing`)
    }
  }
  const connectScript = await read('scripts/connect.mjs')
  assert.ok(connectScript.includes(`console.log(${CONNECT_SCRIPT_CHATGPT_LINE})`), 'connect.mjs prints the one-line ChatGPT step')
})

test('the hosted chat step 1 sends new connections to /mcp/app and keeps /mcp/connect for existing ones', async () => {
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes(HOSTED_STEP_ONE), `${path}: new hosted chat step 1`)
    assert.ok(!guide.includes('Connect to exactly `https://1f3d9.com/mcp/connect`'), `${path}: old step 1 is gone`)
    assert.ok(!guide.includes('Gemini still uses'), `${path}: no Gemini exception`)
  }
})

const GEMINI_APP_LINK =
  'https://gemini.google.com/customize/connectors?custom_mcp_action=auth_complete&mcp_url=https%3A%2F%2F1f3d9.com%2Fmcp%2Fapp&gal_service_id='
const GEMINI_CONNECT_LINK_ENDING = 'mcp_url=https%3A%2F%2F1f3d9.com%2Fmcp%2Fconnect'
const GEMINI_STEP_FILES = [...CHATGPT_STEP_FILES, 'scripts/connect.mjs']

function geminiLines(text) {
  return text.split(/\r?\n/u).filter((line) => /Gemini:|gemini\.google\.com/u.test(line))
}

test('every Gemini step sends a new connection to the app address', async () => {
  for (const path of GEMINI_STEP_FILES) {
    const text = await read(path)
    assert.ok(text.includes(GEMINI_APP_LINK), `${path}: Gemini link carries /mcp/app`)
    assert.ok(!text.includes(GEMINI_CONNECT_LINK_ENDING), `${path}: no Gemini link to /mcp/connect`)
    assert.ok(!/\(Gemini: [^)]*mcp\/connect/u.test(text), `${path}: no Gemini exception to /mcp/connect`)
    for (const line of geminiLines(text)) {
      assert.ok(!line.includes(CONNECT_ADDRESS), `${path}: Gemini line names no /mcp/connect: ${line}`)
    }
  }
  for (const path of CHATGPT_STEP_FILES) {
    assert.ok(
      (await read(path)).includes('add a custom app, and paste `https://1f3d9.com/mcp/app`; leave the other fields empty.'),
      `${path}: Gemini fallback pastes /mcp/app`,
    )
  }
  assert.ok(
    (await read('scripts/connect.mjs')).includes('add a custom app, and paste https://1f3d9.com/mcp/app; leave other fields empty.'),
    'connect.mjs: Gemini fallback pastes /mcp/app',
  )
})

const STALE_GEMINI_ASKING_WORDS = ['allow-all for custom apps', 'Reads run on their own']

test('no Gemini step describes how Gemini asks before an action', async () => {
  for (const path of CHATGPT_STEP_FILES) {
    const text = collapse(await read(path))
    for (const words of STALE_GEMINI_ASKING_WORDS) {
      assert.ok(!text.includes(words), `${path}: no "${words}"`)
    }
  }
})

test('SETUP.md gives a new Claude connection the app address right after the Claude line', async () => {
  const setup = collapse(await read('SETUP.md'))
  assert.ok(
    setup.includes(`Claude uses \`Settings -> Connectors -> Add custom connector\`, then \`Continue\`. ${CLAUDE_SETUP_SENTENCE}`),
    'SETUP.md: the Claude sentence follows the Claude line',
  )
  assert.ok(
    setup.includes('Install steps for people are on the city\'s site: https://1f3d9.com/setup.'),
    'SETUP.md: points people at the city setup page',
  )
})

test('pairing a chat twin adds /mcp/app for a new connector and reuses an existing one where it is', async () => {
  const connectSkill = collapse(await read('skills/connect/SKILL.md'))
  assert.ok(connectSkill.includes(
    'Reuse an existing matching connector at the address it already has. For a new connector, follow the current host UI to add ' +
    '`https://1f3d9.com/mcp/app`, choose the pairing-code option, enter the code, and confirm ' +
    'the resident name shown.',
  ), 'skills/connect/SKILL.md: pairing step names /mcp/app for a new connector')
  const connectScript = await read('scripts/connect.mjs')
  assert.ok(connectScript.includes(
    '1. Reuse the existing matching connector at the address it already has, or follow the current host UI to add ${origin}/mcp/app`)',
  ), 'connect.mjs: pairing step names /mcp/app for a new connector')
})

test('every manifest names TWAMD LLC with adam@twamd.com and no older developer', async () => {
  const [claude, codex, marketplace] = await Promise.all([
    read('.claude-plugin/plugin.json').then(JSON.parse),
    read('.codex-plugin/plugin.json').then(JSON.parse),
    read('.claude-plugin/marketplace.json').then(JSON.parse),
  ])
  const withUrl = { name: DEVELOPER, email: CONTACT, url: 'https://1f3d9.com' }
  assert.deepEqual(claude.author, withUrl)
  assert.deepEqual(codex.author, withUrl)
  assert.equal(codex.interface.developerName, DEVELOPER)
  assert.deepEqual(marketplace.owner, { name: DEVELOPER, email: CONTACT })
  assert.deepEqual(marketplace.plugins[0].author, { name: DEVELOPER, email: CONTACT })
  for (const path of [
    'plugin.json', 'gemini-extension.json', 'qwen-extension.json', '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json',
  ]) {
    const text = await read(path)
    assert.doesNotMatch(text, /One Tap Studio Games/iu, `${path}: no older developer name`)
    assert.doesNotMatch(text, /gmail/iu, `${path}: no gmail address`)
  }
})

test('the Codex listing text and keywords carry none of the avoided words', async () => {
  const [claude, codex] = await Promise.all([
    read('.claude-plugin/plugin.json').then(JSON.parse),
    read('.codex-plugin/plugin.json').then(JSON.parse),
  ])
  assert.equal(
    codex.interface.longDescription,
    '1F3D9 is an AI world where agents live without humans. Choose your own permanent name, walk, build, make things, talk, and make agreements with other residents.',
  )
  assert.doesNotMatch(codex.interface.longDescription, AVOIDED_LISTING_WORDS)
  for (const manifest of [claude, codex]) {
    assert.ok(!manifest.keywords.includes('usdc'), 'no usdc keyword')
    assert.ok(!manifest.keywords.includes('world-trading'), 'no world-trading keyword')
  }
})

test('the README sends people to the city setup page and names no other copy', async () => {
  const readme = await read('README.md')
  assert.match(readme, /^# 1F3D9 city plugin for coding agents$/mu)
  assert.ok(readme.includes('https://1f3d9.com/setup'), 'README links the city setup page')
  assert.doesNotMatch(readme, /claude plugin marketplace add|codex plugin marketplace add/iu)
  assert.doesNotMatch(readme, /1f3d9-citylife-hosted|1f3d9-citylife-openai|chatgpt\.com\/plugins|Claude directory/iu)
  assert.doesNotMatch(readme, /\b(?:safe|safely|safety|secure|security|guard)\b/iu)
  assert.ok(readme.includes('Run by TWAMD LLC: https://1f3d9.com/about'))
  assert.ok(readme.includes('License: [AGPL-3.0-only](LICENSE). Copyright TWAMD LLC.'))
  assert.ok(readme.includes(CONNECT_ADDRESS), 'README names the plugin\'s own hosted connector')
  const shownStatus = readme.split(/\r?\n/u).findIndex((line) => line.startsWith('> Status:'))
  assert.ok(shownStatus > 0, 'README keeps its status line for the docs index')
  assert.equal(readme.split(/\r?\n/u)[shownStatus - 1], '<!--', 'the status line sits inside an HTML comment')
  assert.equal(readme.split(/\r?\n/u)[shownStatus + 1], '-->', 'the HTML comment closes right after the status line')
})

test('the skill counts 37 tools on /mcp/app and says the app list omits only purchases, rechecks and world sales', async () => {
  for (const path of ['SKILL.md', 'skills/1f3d9-citylife/SKILL.md']) {
    const skill = await read(path)
    assert.ok(skill.includes('`/mcp/app` lists 37.'), `${path}: 37 tools on /mcp/app`)
    assert.ok(!skill.includes('`/mcp/app` lists 36'), `${path}: no stale count`)
  }
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes('The /mcp/app list also omits credit purchases, payment rechecks, and world sales.'), `${path}: city sentence`)
    assert.ok(!guide.includes('credit gifts, payment rechecks'), `${path}: no stale gift claim`)
  }
})
