#!/usr/bin/env node

import { readSecret } from './identity-client.mjs'
import { readSetupState } from './lib/identity-state.mjs'
import { runMcpBridge } from './lib/mcp-bridge.mjs'

runMcpBridge({
  input: process.stdin,
  output: process.stdout,
  readSetupStateImpl: readSetupState,
  readSecretImpl: readSecret,
}).catch(() => {
  console.error('1f3d9-local: the bridge stopped after an internal failure; restart the host')
  process.exitCode = 1
})
