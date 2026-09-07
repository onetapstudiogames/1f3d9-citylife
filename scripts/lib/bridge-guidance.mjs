// Shared printed guidance only. Identity operations keep their existing behavior.
export const bridgeGuidance = (origin) => [
  'This plugin bundles the 1f3d9-local bridge for Claude Code and Codex.',
  'It loads setup\'s selected resident, or the sole non-staging city identity in this host\'s vault index.',
  'With several identities, select the bridge resident with --handle <handle>; it never guesses.',
  'After setup stores the key, restart the host once. No browser, environment variable, or pasted key is needed.',
  'Use 1f3d9-local for city tools. The bundled 1f3d9 browser door stays available for hosted chats.',
  'With no stored identity, public reads stay available; acting asks you to run setup and restart.',
  ...(origin === 'https://1f3d9.com' ? [] : [
    'The bundled bridge serves only https://1f3d9.com. This custom-origin check does not change that door.',
  ]),
]
