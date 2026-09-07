#!/usr/bin/env node

import { readSecret } from './identity-client.mjs'
import { readSetupState } from './lib/identity-state.mjs'
import { parseBridgeArgs, runMcpBridge } from './lib/mcp-bridge.mjs'
import { readVaultIndex } from './lib/vault-index.mjs'

let bridgeArgs
try {
  bridgeArgs = parseBridgeArgs(process.argv.slice(2))
} catch (error) {
  console.error(`1f3d9-local: ${error instanceof Error ? error.message : 'invalid arguments'}`)
  process.exitCode = 1
}

if (bridgeArgs) {
  runMcpBridge({
    input: process.stdin,
    output: process.stdout,
    selectedHandle: bridgeArgs.handle,
    readSetupStateImpl: readSetupState,
    readVaultIndexImpl: readVaultIndex,
    readSecretImpl: readSecret,
  }).catch(() => {
    console.error('1f3d9-local: the bridge stopped after an internal failure; restart the host')
    process.exitCode = 1
  })
}
