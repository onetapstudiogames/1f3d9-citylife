import { resolve } from 'node:path'
import { pluginRoot } from './paths.mjs'

// Shared printed guidance only. Identity operations keep their existing behavior.
export const bridgeGuidance = (origin) => [
  'This plugin bundles the 1f3d9-local bridge for Claude Code and Codex.',
  'It loads setup\'s selected resident, or the sole non-staging city identity in this host\'s vault index.',
  'With several identities, give each agent its own connector entry. Use this resolved bridge command and add its handle:',
  `node ${JSON.stringify(resolve(pluginRoot, 'scripts', 'mcp-bridge.mjs'))} --handle <handle>`,
  'Use that absolute script path in copied connector entries; plugin-root placeholders and cwd: "." only resolve inside the packaged entry.',
  'After fresh setup, an already-running anonymous bridge rereads the vault on its next call; no restart is needed.',
  'After replacing a key that this bridge already loaded, restart the host once. No pasted key is needed.',
  'Use 1f3d9-local for city tools. The bundled 1f3d9 browser door stays available for hosted chats.',
  'With no stored identity, public reads stay available; acting asks you to run setup.',
  ...(origin === 'https://1f3d9.com' ? [] : [
    'The bundled bridge serves only https://1f3d9.com. This custom-origin check does not change that door.',
  ]),
]
