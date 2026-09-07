import { once } from 'node:events'

import { HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE } from '../identity-client.mjs'
import { isPendingLabel } from './vault-index.mjs'

const MCP_ORIGIN = 'https://1f3d9.com'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const BRIDGE_NAME = '1f3d9-local'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304
const RESIDENT_KEY_RE = /^1f3d9_sk_[0-9a-f]{48}$/u

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function requestId(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && 'id' in value
    ? value.id
    : null
}

function hasValidRequestId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'id')) return true
  return value.id === null
    || typeof value.id === 'string'
    || (typeof value.id === 'number' && Number.isSafeInteger(value.id))
}

function isResidentHandle(handle) {
  return typeof handle === 'string'
    && HANDLE_RE.test(handle)
    && !RESERVED_HANDLE_SUBSTRING_RE.test(handle)
    && !isPendingLabel(handle)
}

function parseBridgeArgs(argv) {
  if (argv.length === 0) return { handle: null }
  let handle
  if (argv.length === 1 && argv[0].startsWith('--handle=')) {
    handle = argv[0].slice('--handle='.length)
  } else if (argv.length === 2 && argv[0] === '--handle') {
    handle = argv[1]
  } else {
    throw new Error('usage: mcp-bridge.mjs [--handle <handle>]')
  }
  if (!isResidentHandle(handle)) {
    throw new Error('--handle must be a resident handle, never a staging label')
  }
  return { handle }
}

function indexedResidentHandles(index) {
  const entries = Array.isArray(index?.[MCP_ORIGIN]) ? index[MCP_ORIGIN] : []
  const handles = new Set()
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (isResidentHandle(entry) && !isPendingLabel(entry)) handles.add(entry)
      continue
    }
    if (
      entry
      && typeof entry === 'object'
      && entry.staging === false
      && isResidentHandle(entry.label)
    ) {
      handles.add(entry.label)
    }
  }
  return [...handles].sort()
}

function readSelectedIdentity(handle, selection, readSecretImpl) {
  let stored
  try {
    stored = readSecretImpl(MCP_ORIGIN, handle)
  } catch {
    return { residentKey: null, status: 'key_unreadable', handle, selection }
  }
  if (!stored?.found) return { residentKey: null, status: 'key_missing', handle, selection }
  const residentKey = stored.value?.resident_key
  if (typeof residentKey !== 'string' || !RESIDENT_KEY_RE.test(residentKey)) {
    return { residentKey: null, status: 'key_unreadable', handle, selection }
  }
  return { residentKey, status: 'ready', handle, selection }
}

function loadIdentity({ selectedHandle, readSetupStateImpl, readVaultIndexImpl, readSecretImpl }) {
  if (selectedHandle !== null) {
    if (!isResidentHandle(selectedHandle)) {
      throw new TypeError('--handle must be a resident handle, never a staging label')
    }
    return readSelectedIdentity(selectedHandle, 'explicit', readSecretImpl)
  }

  let state
  try {
    state = readSetupStateImpl(MCP_ORIGIN)
  } catch {
    return { residentKey: null, status: 'setup_unreadable', handle: null, selection: null }
  }
  if (state !== null) {
    if (!state || typeof state !== 'object' || !isResidentHandle(state.handle)) {
      return { residentKey: null, status: 'setup_unreadable', handle: null, selection: null }
    }
    return readSelectedIdentity(state.handle, 'setup', readSecretImpl)
  }

  let index
  try {
    index = readVaultIndexImpl()
  } catch {
    return { residentKey: null, status: 'index_unavailable', handle: null, selection: null }
  }
  const handles = indexedResidentHandles(index)
  if (handles.length === 0) {
    return { residentKey: null, status: 'setup_missing', handle: null, selection: null }
  }
  if (handles.length > 1) {
    return { residentKey: null, status: 'index_ambiguous', handle: null, selection: null }
  }
  return readSelectedIdentity(handles[0], 'index', readSecretImpl)
}

function statusGuidance(identity) {
  if (identity.status === 'setup_missing') {
    return 'Setup has not run on this host. Run `node scripts/setup.mjs`, then restart the host before using resident tools.'
  }
  if (identity.status === 'setup_unreadable') {
    return 'The local setup state could not be read safely. Repair it with `node scripts/setup.mjs`, then restart the host before using resident tools.'
  }
  if (identity.status === 'index_unavailable') {
    return 'The local vault index could not be checked safely. Restart the host with this bridge configured as `--handle <handle>` to select a resident identity.'
  }
  if (identity.status === 'index_ambiguous') {
    return 'The local vault index has several resident labels. Restart the host with this bridge configured as `--handle <handle>` to select one; no resident key was read.'
  }
  if (identity.status === 'key_missing') {
    return `No usable resident key was found for "${identity.handle}" in this host's vault. Run ` +
      '`node scripts/setup.mjs`, then restart the host before using resident tools.'
  }
  if (identity.status === 'key_unreadable') {
    return `The resident key for "${identity.handle}" in this host's vault could not be read safely. Repair it with ` +
      '`node scripts/setup.mjs`, then restart the host before using resident tools.'
  }
  if (identity.selection === 'index') {
    return `This bridge selected vault-index identity "${identity.handle}" and loaded its resident key when the bridge started.`
  }
  if (identity.selection === 'explicit') {
    return `This bridge selected "${identity.handle}" from --handle and loaded its resident key when the bridge started.`
  }
  return `This bridge selected setup identity "${identity.handle}" and loaded its resident key when the bridge started.`
}

function bridgeInstructions(identity) {
  return (
    `${BRIDGE_NAME} is the local bridge for a resident stored in this host's vault. ` +
    'Do not use browser sign-in as a fallback for this local bridge. ' +
    statusGuidance(identity)
  )
}

function isHexCharacter(character) {
  return character !== undefined && (
    (character >= '0' && character <= '9')
    || (character >= 'a' && character <= 'f')
    || (character >= 'A' && character <= 'F')
  )
}

function decodedCharacterAt(value, start) {
  if (value[start] !== '\\') return { character: value[start], end: start + 1 }
  let slashEnd = start + 1
  while (value[slashEnd] === '\\') slashEnd += 1
  if (
    (value[slashEnd] === 'u' || value[slashEnd] === 'U')
    && isHexCharacter(value[slashEnd + 1])
    && isHexCharacter(value[slashEnd + 2])
    && isHexCharacter(value[slashEnd + 3])
    && isHexCharacter(value[slashEnd + 4])
  ) {
    return {
      character: String.fromCharCode(Number.parseInt(value.slice(slashEnd + 1, slashEnd + 5), 16)),
      end: slashEnd + 5,
    }
  }
  return { character: '\\', end: slashEnd }
}

function encodedSecretEnd(value, start, residentKey) {
  let cursor = start
  for (const expected of residentKey) {
    if (cursor >= value.length) return null
    const decoded = decodedCharacterAt(value, cursor)
    if (decoded.character !== expected) return null
    cursor = decoded.end
  }
  return cursor
}

function createSecretRedactor(residentKey) {
  if (!residentKey) return value => value
  return value => {
    const literalRedacted = value.replaceAll(residentKey, '[REDACTED]')
    const replacements = []
    let cursor = 0
    while (cursor < literalRedacted.length) {
      const first = decodedCharacterAt(literalRedacted, cursor)
      if (first.character !== residentKey[0]) {
        cursor = first.end
        continue
      }
      const end = encodedSecretEnd(literalRedacted, cursor, residentKey)
      if (end === null) {
        cursor = first.end
        continue
      }
      replacements.push([cursor, end])
      cursor = end
    }
    if (replacements.length === 0) return literalRedacted
    const pieces = []
    let copiedThrough = 0
    for (const [start, end] of replacements) {
      pieces.push(literalRedacted.slice(copiedThrough, start), '[REDACTED]')
      copiedThrough = end
    }
    pieces.push(literalRedacted.slice(copiedThrough))
    return pieces.join('')
  }
}

function redactValue(value, redactSecret) {
  if (typeof value === 'string') return redactSecret(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, redactSecret))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      redactSecret(key),
      redactValue(nested, redactSecret),
    ]),
  )
}

function isNotification(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.jsonrpc === '2.0'
    && typeof value.method === 'string'
    && !Object.hasOwn(value, 'id'),
  )
}

function isMatchingJsonRpcResponse(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.jsonrpc !== '2.0' || !Object.hasOwn(value, 'id') || value.id !== id) return false
  return Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error')
}

function authRequiredGuidance(value, identity) {
  if (identity.status === 'ready' || !value?.result?.isError || !Array.isArray(value.result.content)) return value
  let changed = false
  const content = value.result.content.map(item => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') return item
    let classified
    try {
      classified = JSON.parse(item.text)
    } catch {
      return item
    }
    if (!classified || typeof classified !== 'object' || classified.error_class !== 'auth_required') return item
    changed = true
    return {
      ...item,
      text: JSON.stringify({ ...classified, error: statusGuidance(identity) }),
    }
  })
  return changed ? { ...value, result: { ...value.result, content } } : value
}

function appendBridgeInstructions(value, method, identity) {
  if (method !== 'initialize' || !value?.result || typeof value.result !== 'object') return value
  const cityInstructions = typeof value.result.instructions === 'string'
    ? value.result.instructions.trimEnd()
    : ''
  const localInstructions = bridgeInstructions(identity)
  return {
    ...value,
    result: {
      ...value.result,
      instructions: cityInstructions ? `${cityInstructions}\n\n${localInstructions}` : localInstructions,
    },
  }
}

async function readBoundedResponse(response, maxResponseBytes) {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('oversized')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('oversized')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function createMcpBridge({
  selectedHandle = null,
  readSetupStateImpl,
  readVaultIndexImpl,
  readSecretImpl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (
    typeof readSetupStateImpl !== 'function'
    || typeof readVaultIndexImpl !== 'function'
    || typeof readSecretImpl !== 'function'
  ) {
    throw new TypeError('identity readers are required')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  const identity = loadIdentity({ selectedHandle, readSetupStateImpl, readVaultIndexImpl, readSecretImpl })
  const redactSecret = createSecretRedactor(identity.residentKey)

  async function handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > maxRequestBytes) {
      return JSON.stringify(rpcError(null, -32600, `${BRIDGE_NAME} request exceeded its size limit`))
    }

    let request
    try {
      request = JSON.parse(line)
    } catch {
      return JSON.stringify(rpcError(null, -32700, `${BRIDGE_NAME} received invalid JSON`))
    }
    if (!hasValidRequestId(request)) {
      return JSON.stringify(rpcError(
        null,
        -32600,
        `${BRIDGE_NAME} request id must be a string, null, or safe integer`,
      ))
    }
    const id = requestId(request)
    const notification = isNotification(request)
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (identity.residentKey) headers.authorization = `Bearer ${identity.residentKey}`

    let response
    try {
      response = await fetchImpl(MCP_URL, {
        method: 'POST',
        headers,
        body: line,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      if (notification) return null
      return JSON.stringify(rpcError(
        id,
        -32603,
        `${BRIDGE_NAME} could not confirm the city response; check whether the action completed before ` +
        'retrying. The bridge did not retry.',
      ))
    }

    let raw
    try {
      raw = await readBoundedResponse(response, maxResponseBytes)
    } catch {
      if (notification) return null
      return JSON.stringify(rpcError(id, -32603, `${BRIDGE_NAME} received an unreadable city response`))
    }
    if (notification) return null

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return JSON.stringify(rpcError(id, -32603, `${BRIDGE_NAME} received an unreadable city response`))
    }
    if (!isMatchingJsonRpcResponse(parsed, id)) {
      return JSON.stringify(rpcError(id, -32603, `${BRIDGE_NAME} received an unreadable city response`))
    }
    try {
      parsed = redactValue(parsed, redactSecret)
      parsed = authRequiredGuidance(parsed, identity)
      parsed = appendBridgeInstructions(parsed, request?.method, identity)
      return JSON.stringify(parsed)
    } catch {
      return JSON.stringify(rpcError(id, -32603, `${BRIDGE_NAME} received an unreadable city response`))
    }
  }

  return Object.freeze({ handleLine })
}

async function writeLine(output, line) {
  if (output.write(`${line}\n`)) return
  await once(output, 'drain')
}

async function runMcpBridge({
  input,
  output,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  ...deps
}) {
  const bridge = await createMcpBridge({ ...deps, maxRequestBytes })
  let pending = Buffer.alloc(0)
  let discardingOversizedLine = false

  async function processLine(line) {
    const response = await bridge.handleLine(line)
    if (response !== null) await writeLine(output, response)
  }

  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      const fragment = chunk.subarray(start, end)
      if (!discardingOversizedLine) {
        if (pending.length + fragment.length > maxRequestBytes) {
          pending = Buffer.alloc(0)
          discardingOversizedLine = true
        } else {
          pending = Buffer.concat([pending, fragment])
        }
      }
      if (newline === -1) break
      if (discardingOversizedLine) {
        await writeLine(output, JSON.stringify(
          rpcError(null, -32600, `${BRIDGE_NAME} request exceeded its size limit`),
        ))
      } else {
        const line = pending.at(-1) === 0x0d ? pending.subarray(0, -1) : pending
        if (line.length > 0) await processLine(line.toString('utf8'))
      }
      pending = Buffer.alloc(0)
      discardingOversizedLine = false
      start = newline + 1
    }
  }
  if (discardingOversizedLine) {
    await writeLine(output, JSON.stringify(rpcError(null, -32600, `${BRIDGE_NAME} request exceeded its size limit`)))
  } else if (pending.length > 0) {
    await processLine(pending.toString('utf8'))
  }
}

export {
  BRIDGE_NAME,
  MCP_ORIGIN,
  MCP_URL,
  createMcpBridge,
  parseBridgeArgs,
  runMcpBridge,
}
