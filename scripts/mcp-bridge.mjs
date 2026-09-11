#!/usr/bin/env node

import { readSecret } from './identity-client.mjs'
import { readSetupState } from './lib/identity-state.mjs'
import { formatBridgeStop, parseBridgeArgs, runMcpBridge } from './lib/mcp-bridge.mjs'
import { readVaultIndex } from './lib/vault-index.mjs'

let bridgeArgs
try {
  bridgeArgs = parseBridgeArgs(process.argv.slice(2))
} catch (error) {
  for (const line of formatBridgeStop(error)) console.error(line)
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
  }).catch(error => {
    for (const line of formatBridgeStop(error)) console.error(line)
    process.exitCode = 1
  })
}
