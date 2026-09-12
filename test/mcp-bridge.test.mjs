import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'

import {
  BRIDGE_NAME,
  MCP_ORIGIN,
  MCP_URL,
  createMcpBridge,
  formatBridgeStop,
  parseBridgeArgs,
  runMcpBridge,
} from '../scripts/lib/mcp-bridge.mjs'

const RESIDENT_KEY = `1f3d9_sk_${'a'.repeat(48)}`

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function identityDeps({ state = { handle: 'tinylantern' }, index = {}, stored = {
  found: true,
  value: { resident_key: RESIDENT_KEY },
} } = {}) {
  const calls = []
  return {
    calls,
    readSetupStateImpl(origin) {
      calls.push(['state', origin])
      return state
    },
    readVaultIndexImpl() {
      calls.push(['index'])
      return index
    },
    readSecretImpl(origin, handle) {
      calls.push(['secret', origin, handle])
      return stored
    },
  }
}

test('startup reads the fixed city setup and its handle-labelled vault entry once', async () => {
  const identity = identityDeps()
  const bridge = await createMcpBridge({
    ...identity,
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }),
  })

  assert.deepEqual(identity.calls, [
    ['state', MCP_ORIGIN],
    ['secret', MCP_ORIGIN, 'tinylantern'],
  ])
  await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')
  assert.equal(identity.calls.length, 2, 'identity is not reread while the host process stays alive')
})

test('an anonymous bridge reloads the vault on a later call and can use a newly stored identity without restart', async () => {
  let state = null
  let stored = { found: false, value: null }
  const requests = []
  const bridge = await createMcpBridge({
    readSetupStateImpl: () => state,
    readVaultIndexImpl: () => ({}),
    readSecretImpl: () => stored,
    fetchImpl: async (_url, init) => {
      requests.push(init)
      return jsonResponse({ jsonrpc: '2.0', id: requests.length, result: {} })
    },
  })

  await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')
  state = { handle: 'tinylantern' }
  stored = { found: true, value: { resident_key: RESIDENT_KEY } }
  await bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"tools/call"}')

  assert.equal(requests[0].headers.authorization, undefined)
  assert.equal(requests[1].headers.authorization, `Bearer ${RESIDENT_KEY}`)
})

test('missing-key guidance uses a resolved setup command in every repair case', async () => {
  const cases = [
    identityDeps({ state: null, index: {} }),
    identityDeps({ state: { handle: 'tinylantern' }, stored: { found: false, value: null } }),
    identityDeps({ state: { handle: 'tinylantern' }, stored: { found: true, value: {} } }),
  ]
  for (const deps of cases) {
    const bridge = await createMcpBridge({
      ...deps,
      fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { instructions: '' } }),
    })
    const output = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
    assert.match(output, /node \\"[^"]+\/scripts\/setup\.mjs\\"/u)
    assert.doesNotMatch(output, /CLAUDE_PLUGIN_ROOT/u)
    assert.doesNotMatch(output, /node scripts\/setup\.mjs/u)
  }
})

test('relayed JSON-RPC errors include the safe x-vercel-id response header', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse(
      { jsonrpc: '2.0', id: 9, error: { code: -32000, message: 'city refusal' } },
      { headers: { 'content-type': 'application/json', 'x-vercel-id': 'cle1::iad1::request-123' } },
    ),
  })
  const output = JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","id":9,"method":"tools/call"}'))
  assert.match(output.error.message, /x-vercel-id: cle1::iad1::request-123/u)
})

test('bridge-generated errors from a city response include its x-vercel-id', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => new Response('not json', {
      status: 502,
      headers: { 'content-type': 'text/plain', 'x-vercel-id': 'cle1::iad1::request-456' },
    }),
  })
  const output = JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","id":10,"method":"tools/call"}'))
  assert.match(output.error.message, /x-vercel-id: cle1::iad1::request-456/u)
})

test('an empty MCP error content array still receives the x-vercel-id', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse(
      { jsonrpc: '2.0', id: 11, result: { isError: true, content: [] } },
      { headers: { 'content-type': 'application/json', 'x-vercel-id': 'cle1::iad1::request-789' } },
    ),
  })
  const output = JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","id":11,"method":"tools/call"}'))
  assert.deepEqual(output.result.content, [{ type: 'text', text: 'x-vercel-id: cle1::iad1::request-789' }])
})

test('malformed error payload shapes still receive the x-vercel-id', async () => {
  const replies = [
    { jsonrpc: '2.0', id: 13, error: { code: -32000 } },
    { jsonrpc: '2.0', id: 14, result: { isError: true } },
  ]
  for (const reply of replies) {
    const bridge = await createMcpBridge({
      ...identityDeps(),
      fetchImpl: async () => jsonResponse(reply, {
        headers: { 'content-type': 'application/json', 'x-vercel-id': `cle1::iad1::request-${reply.id}` },
      }),
    })
    const output = JSON.parse(await bridge.handleLine(JSON.stringify({
      jsonrpc: '2.0', id: reply.id, method: 'tools/call',
    })))
    if (reply.error) assert.equal(output.error.response_id, `cle1::iad1::request-${reply.id}`)
    else assert.deepEqual(output.result.content, [{ type: 'text', text: `x-vercel-id: cle1::iad1::request-${reply.id}` }])
  }
})

test('an unavailable identity refresh updates its handle even when the status is unchanged', async () => {
  let state = { handle: 'agent-one' }
  const bridge = await createMcpBridge({
    readSetupStateImpl: () => state,
    readVaultIndexImpl: () => ({}),
    readSecretImpl: () => ({ found: false, value: null }),
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 12, result: {} }),
  })
  state = { handle: 'agent-two' }
  const output = JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","id":12,"method":"initialize"}'))
  assert.match(output.result.instructions, /agent-two/u)
  assert.doesNotMatch(output.result.instructions, /agent-one/u)
})

test('a stopped bridge names the cause and gives one safe line to copy to the human', () => {
  const secret = `1f3d9_sk_${'b'.repeat(48)}`
  const lines = formatBridgeStop(new Error(`input stream closed near ${secret}`))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /input stream closed/iu)
  assert.match(lines[1], /Copy this line to the human:/u)
  assert.equal(lines.join('\n').includes(secret), false)
})

test('authenticated calls use the one fixed URL and keep the key only in the Bearer header', async () => {
  const requests = []
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return jsonResponse({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    },
  })
  const request = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'walk', arguments: {} } }

  const output = await bridge.handleLine(JSON.stringify(request))

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, MCP_URL)
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.headers.authorization, `Bearer ${RESIDENT_KEY}`)
  assert.equal(requests[0].init.body, JSON.stringify(request))
  assert.doesNotMatch(requests[0].init.body, /1f3d9_sk_/u)
  assert.deepEqual(JSON.parse(output), { jsonrpc: '2.0', id: 7, result: { ok: true } })
})

test('the original bounded JSON line is forwarded without normalizing a valid id', async () => {
  const raw = '{ "jsonrpc": "2.0", "id": "01", "method": "ping" }'
  let forwarded
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async (_url, init) => {
      forwarded = init.body
      return jsonResponse({ jsonrpc: '2.0', id: '01', result: {} })
    },
  })

  const output = await bridge.handleLine(raw)

  assert.equal(forwarded, raw)
  assert.equal(JSON.parse(output).id, '01')
})

test('unsafe numeric and structured ids are rejected before a city request', async () => {
  let calls = 0
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({})
    },
  })

  for (const id of ['9007199254740993', '{}', '[]']) {
    const output = await bridge.handleLine(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`)
    assert.deepEqual(JSON.parse(output), {
      jsonrpc: '2.0', id: null,
      error: {
        code: -32600,
        message: '1f3d9-local request id must be a string, null, or safe integer',
        http_status: 400,
      },
    })
  }
  assert.equal(calls, 0)
})

test('missing setup stays anonymous so initialize and server-selected public tools still work', async () => {
  const requests = []
  const bridge = await createMcpBridge({
    ...identityDeps({ state: null }),
    fetchImpl: async (_url, init) => {
      requests.push(init)
      const request = JSON.parse(init.body)
      if (request.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: 'City rules.' },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'look' }] } })
    },
  })

  const initialized = JSON.parse(await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })))
  const listed = JSON.parse(await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })))

  assert.equal(requests.some(init => 'authorization' in init.headers), false)
  assert.equal(initialized.result.instructions.startsWith('City rules.'), true)
  assert.match(initialized.result.instructions, new RegExp(BRIDGE_NAME, 'u'))
  assert.match(initialized.result.instructions, /setup has not run on this host/iu)
  assert.doesNotMatch(initialized.result.instructions, /restart the host/iu)
  assert.match(initialized.result.instructions, /do not use browser sign-in as a fallback/iu)
  assert.deepEqual(listed.result.tools, [{ name: 'look' }])
})

test('one safe vault-index label is selected, read once, and named during initialize', async () => {
  const identity = identityDeps({
    state: null,
    index: { [MCP_ORIGIN]: [{ label: 'bridge-buyer', staging: false }] },
  })
  const requests = []
  const bridge = await createMcpBridge({
    ...identity,
    fetchImpl: async (_url, init) => {
      requests.push(init)
      const request = JSON.parse(init.body)
      return jsonResponse({
        jsonrpc: '2.0', id: request.id,
        result: { instructions: 'City rules.' },
      })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.deepEqual(identity.calls, [
    ['state', MCP_ORIGIN],
    ['index'],
    ['secret', MCP_ORIGIN, 'bridge-buyer'],
  ])
  assert.equal(requests[0].headers.authorization, `Bearer ${RESIDENT_KEY}`)
  assert.match(initialized, /resident stored in this host's vault/iu)
  assert.doesNotMatch(initialized, /identity created by this plugin's setup/iu)
  assert.match(initialized, /selected vault-index identity \\"bridge-buyer\\"/iu)
})

test('an index-selected identity with no key uses neutral repair guidance', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps({
      state: null,
      index: { [MCP_ORIGIN]: [{ label: 'bridge-buyer', staging: false }] },
      stored: { found: false, value: null },
    }),
    fetchImpl: async (_url, init) => {
      const { id } = JSON.parse(init.body)
      return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.match(initialized, /no usable resident key was found for \\"bridge-buyer\\"/iu)
  assert.match(initialized, /setup\.mjs/iu)
  assert.doesNotMatch(initialized, /restart the host/iu)
  assert.doesNotMatch(initialized, /setup did not find/iu)
})

test('several vault-index labels remain public and acting guidance requests --handle', async () => {
  const identity = identityDeps({
    state: null,
    index: {
      [MCP_ORIGIN]: [
        { label: 'bridge-buyer', staging: false },
        { label: 'tinylantern', staging: false },
      ],
    },
  })
  const requests = []
  const bridge = await createMcpBridge({
    ...identity,
    fetchImpl: async (_url, init) => {
      requests.push(init)
      const request = JSON.parse(init.body)
      if (request.method === 'initialize') {
        return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { instructions: 'City rules.' } })
      }
      return jsonResponse({
        jsonrpc: '2.0', id: request.id,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ error_class: 'auth_required', error: 'upstream wording' }),
          }],
        },
      })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
  const acted = await bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"walk"}}')

  assert.equal(identity.calls.some(call => call[0] === 'secret'), false)
  assert.equal(requests.some(init => 'authorization' in init.headers), false)
  assert.match(initialized, /several resident labels/iu)
  assert.match(initialized, /--handle <handle>/u)
  assert.match(acted, /--handle <handle>/u)
  assert.match(acted, /restart the host/iu)
})

test('staging and malformed index entries are never selected or read', async () => {
  const identity = identityDeps({
    state: null,
    index: {
      [MCP_ORIGIN]: [
        { label: 'bridge-buyer--pending-rotation', staging: true },
        { label: 'not-staging-but-unknown', staging: null },
        'legacy--pending-recovery',
        "bad'label",
      ],
    },
  })
  const bridge = await createMcpBridge({
    ...identity,
    fetchImpl: async (_url, init) => {
      const { id } = JSON.parse(init.body)
      return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.equal(identity.calls.some(call => call[0] === 'secret'), false)
  assert.match(initialized, /setup has not run on this host/iu)
})

test('explicit --handle selects one identity without reading setup state or the index', async () => {
  const identity = identityDeps({
    state: null,
    index: {
      [MCP_ORIGIN]: [
        { label: 'bridge-buyer', staging: false },
        { label: 'tinylantern', staging: false },
      ],
    },
  })
  const bridge = await createMcpBridge({
    ...identity,
    selectedHandle: 'bridge-buyer',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body)
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { instructions: 'City rules.' } })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.deepEqual(identity.calls, [['secret', MCP_ORIGIN, 'bridge-buyer']])
  assert.match(initialized, /selected \\"bridge-buyer\\" from --handle/iu)
})

test('an explicit identity with an unreadable key does not claim setup selected it', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps(),
    selectedHandle: 'bridge-buyer',
    readSecretImpl() {
      throw new Error('unreadable')
    },
    fetchImpl: async (_url, init) => {
      const { id } = JSON.parse(init.body)
      return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
    },
  })

  const initialized = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.match(initialized, /resident key for \\"bridge-buyer\\".*could not be read safely/iu)
  assert.match(initialized, /setup\.mjs/iu)
  assert.doesNotMatch(initialized, /restart the host/iu)
  assert.doesNotMatch(initialized, /setup did not find/iu)
})

test('bridge CLI parsing accepts one safe handle and rejects staging or unknown arguments', () => {
  assert.deepEqual(parseBridgeArgs([]), { handle: null })
  assert.deepEqual(parseBridgeArgs(['--handle', 'bridge-buyer']), { handle: 'bridge-buyer' })
  assert.deepEqual(parseBridgeArgs(['--handle=bridge-buyer']), { handle: 'bridge-buyer' })
  assert.throws(() => parseBridgeArgs(['--handle', 'agent--pending-rotation']), /must be a resident handle/iu)
  assert.throws(() => parseBridgeArgs(['--unknown']), /usage:/iu)
})

test('unreadable setup state remains anonymous and reports repair wording without raw details', async () => {
  const bridge = await createMcpBridge({
    ...identityDeps(),
    readSetupStateImpl() {
      throw new Error(`bad state ${RESIDENT_KEY}`)
    },
    fetchImpl: async (_url, init) => {
      const { id } = JSON.parse(init.body)
      return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
    },
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

  assert.match(output, /setup state could not be read safely/iu)
  assert.match(output, /repair/iu)
  assert.doesNotMatch(output, /bad state|1f3d9_sk_/u)
})

test('an invalid setup handle is not passed to the vault facade', async () => {
  for (const handle of ["bad'handle", 'agent--pending-rotation']) {
    let secretReads = 0
    const bridge = await createMcpBridge({
      readSetupStateImpl: () => ({ handle }),
      readVaultIndexImpl: () => ({}),
      readSecretImpl: () => {
        secretReads += 1
        return { found: true, value: { resident_key: RESIDENT_KEY } }
      },
      fetchImpl: async (_url, init) => {
        const { id } = JSON.parse(init.body)
        return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
      },
    })

    const output = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

    assert.equal(secretReads, 0, `${handle} never reaches the vault facade`)
    assert.match(output, /setup state could not be read safely/iu)
  }
})

test('unreadable or invalid vault entries stay anonymous without exposing failure details', async () => {
  for (const readSecretImpl of [
    () => { throw new Error(`vault failed with ${RESIDENT_KEY}`) },
    () => ({ found: true, value: { resident_key: 'invalid-key' } }),
  ]) {
    const requests = []
    const bridge = await createMcpBridge({
      readSetupStateImpl: () => ({ handle: 'tinylantern' }),
      readVaultIndexImpl: () => ({}),
      readSecretImpl,
      fetchImpl: async (_url, init) => {
        requests.push(init)
        const { id } = JSON.parse(init.body)
        return jsonResponse({ jsonrpc: '2.0', id, result: { instructions: 'City rules.' } })
      },
    })

    const output = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')

    assert.equal('authorization' in requests[0].headers, false)
    assert.match(output, /resident key.*could not be read safely/iu)
    assert.doesNotMatch(output, /vault failed|invalid-key|1f3d9_sk_/u)
  }
})

test('missing key forwards public calls and replaces only auth-required text with setup guidance', async () => {
  const authText = JSON.stringify({
    error_class: 'auth_required',
    front_door_tool: 'front_door',
    error: 'upstream sign-in wording',
  })
  const upstream = {
    jsonrpc: '2.0',
    id: 'act-1',
    result: { content: [{ type: 'text', text: authText }], isError: true, extra: 9 },
  }
  const bridge = await createMcpBridge({
    ...identityDeps({ stored: { found: false, value: null } }),
    fetchImpl: async () => jsonResponse(upstream),
  })

  const output = JSON.parse(await bridge.handleLine(JSON.stringify({
    jsonrpc: '2.0', id: 'act-1', method: 'tools/call', params: { name: 'walk', arguments: {} },
  })))
  const classified = JSON.parse(output.result.content[0].text)

  assert.equal(output.id, upstream.id)
  assert.equal(output.result.extra, 9)
  assert.equal(classified.error_class, 'auth_required')
  assert.equal(classified.front_door_tool, 'front_door')
  assert.match(classified.error, /no usable resident key was found/iu)
  assert.match(classified.error, /run `node "[^"]+\/scripts\/setup\.mjs"`/iu)
  assert.doesNotMatch(classified.error, /CLAUDE_PLUGIN_ROOT/u)
  assert.doesNotMatch(classified.error, /restart the host/iu)
})

test('notifications are forwarded once and an empty upstream response emits no JSON line', async () => {
  let calls = 0
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => {
      calls += 1
      return new Response(null, { status: 202 })
    },
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')

  assert.equal(calls, 1)
  assert.equal(output, null)
})

test('notifications never emit a response line when the city fails or incorrectly returns id null', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`failure ${RESIDENT_KEY}`) },
    async () => jsonResponse({ jsonrpc: '2.0', id: null, result: { unexpected: true } }),
  ]) {
    const bridge = await createMcpBridge({ ...identityDeps(), fetchImpl })
    assert.equal(
      await bridge.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
      null,
    )
  }
})

test('upstream JSON-RPC errors and null ids are preserved', async () => {
  const upstream = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid' } }
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse(upstream, { status: 400 }),
  })

  assert.deepEqual(
    JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","method":7}')),
    upstream,
  )
})

test('non-response JSON and mismatched ids are rejected under the caller request id', async () => {
  for (const upstream of [
    'plain JSON',
    [{ jsonrpc: '2.0', id: 8, result: {} }],
    { jsonrpc: '2.0', id: 9, result: {} },
    { jsonrpc: '2.0', id: 8, result: {}, error: { code: -1, message: 'both' } },
  ]) {
    const bridge = await createMcpBridge({
      ...identityDeps(),
      fetchImpl: async () => jsonResponse(upstream),
    })
    assert.deepEqual(
      JSON.parse(await bridge.handleLine('{"jsonrpc":"2.0","id":8,"method":"ping"}')),
      {
        jsonrpc: '2.0', id: 8,
        error: { code: -32603, message: '1f3d9-local received an unreadable city response' },
      },
    )
  }
})

test('the resident key is redacted even when upstream reflects it through JSON escaping', async () => {
  const reflected = RESIDENT_KEY.replace('_', '\\u005f')
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => new Response(
      `{"jsonrpc":"2.0","id":3,"result":{"${reflected}":"key name","content":[{"type":"text","text":"${reflected}"}]}}`,
      { status: 200 },
    ),
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":3,"method":"ping"}')

  assert.doesNotMatch(output, /1f3d9_sk_|1f3d9\\u005fsk/iu)
  assert.match(output, /\[REDACTED\]/u)
  assert.equal(Object.hasOwn(JSON.parse(output).result, '[REDACTED]'), true)
})

test('the resident key is redacted from JSON serialized inside MCP text', async () => {
  const escapedKey = RESIDENT_KEY.replace('_', '\\u005f')
  const upstream = {
    jsonrpc: '2.0',
    id: 4,
    result: { content: [{ type: 'text', text: `{"token":"${escapedKey}"}` }] },
  }
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => new Response(JSON.stringify(upstream), { status: 200 }),
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":4,"method":"ping"}')
  const nested = JSON.parse(JSON.parse(output).result.content[0].text)

  assert.equal(nested.token, '[REDACTED]')
  assert.doesNotMatch(output, /1f3d9_sk_|1f3d9\\\\u005fsk/iu)
})

test('the resident key is redacted through two nested JSON documents', async () => {
  const escapedKey = RESIDENT_KEY.replace('_', '\\u005f')
  const inner = `{"token":"${escapedKey}"}`
  const nestedText = JSON.stringify({ payload: inner })
  assert.equal(JSON.parse(JSON.parse(nestedText).payload).token, RESIDENT_KEY)
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse({
      jsonrpc: '2.0', id: 5,
      result: { content: [{ type: 'text', text: nestedText }] },
    }),
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":5,"method":"ping"}')
  const redactedText = JSON.parse(output).result.content[0].text

  assert.equal(JSON.parse(JSON.parse(redactedText).payload).token, '[REDACTED]')
  assert.doesNotMatch(output, /1f3d9_sk_|1f3d9(?:\\\\){2,}u005fsk/iu)
})

test('slash-heavy encoded-key near-matches stay bounded', { timeout: 2_000 }, async () => {
  const hostileText = `${'\\'.repeat(128 * 1024)}u0031X`
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse({
      jsonrpc: '2.0', id: 6,
      result: { content: [{ type: 'text', text: hostileText }] },
    }),
  })

  const startedAt = performance.now()
  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":6,"method":"ping"}')
  const elapsedMs = performance.now() - startedAt

  assert.equal(JSON.parse(output).result.content[0].text, hostileText)
  assert.ok(elapsedMs < 2_000, `hostile near-match took ${elapsedMs.toFixed(0)} ms`)
})

test('a literal key beginning inside a skipped escape token is still redacted', async () => {
  const reflected = `\\u004${RESIDENT_KEY}`
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => jsonResponse({
      jsonrpc: '2.0', id: 7,
      result: { content: [{ type: 'text', text: reflected }] },
    }),
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":7,"method":"ping"}')

  assert.doesNotMatch(output, /1f3d9_sk_/u)
  assert.equal(JSON.parse(output).result.content[0].text, '\\u004[REDACTED]')
})

test('transport failures are sanitized, retain the request id, and are never retried', async () => {
  let calls = 0
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => {
      calls += 1
      throw new Error(`socket copied ${RESIDENT_KEY}`)
    },
  })

  const output = await bridge.handleLine('{"jsonrpc":"2.0","id":42,"method":"tools/call"}')

  assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(output), {
    jsonrpc: '2.0', id: 42,
    error: {
      code: -32603,
      message: '1f3d9-local could not confirm the city response; check whether the action completed before retrying. The bridge did not retry.',
    },
  })
  assert.doesNotMatch(output, /socket|1f3d9_sk_/u)
})

test('malformed and oversized responses become bounded sanitized errors', async () => {
  for (const body of ['not json', 'x'.repeat(80)]) {
    const bridge = await createMcpBridge({
      ...identityDeps(),
      maxResponseBytes: 64,
      fetchImpl: async () => new Response(body, { status: 200 }),
    })
    const output = await bridge.handleLine('{"jsonrpc":"2.0","id":5,"method":"ping"}')
    assert.deepEqual(JSON.parse(output), {
      jsonrpc: '2.0', id: 5,
      error: { code: -32603, message: '1f3d9-local received an unreadable city response' },
    })
  }
})

test('a deeply nested response fails only its request and the bridge handles the next line', async () => {
  const depth = 20_000
  let calls = 0
  const bridge = await createMcpBridge({
    ...identityDeps(),
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return new Response(
          `{"jsonrpc":"2.0","id":1,"result":{"deep":${'['.repeat(depth)}null${']'.repeat(depth)}}}`,
          { status: 200 },
        )
      }
      return jsonResponse({ jsonrpc: '2.0', id: 2, result: { alive: true } })
    },
  })

  const failed = await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')
  const recovered = await bridge.handleLine('{"jsonrpc":"2.0","id":2,"method":"ping"}')

  assert.deepEqual(JSON.parse(failed), {
    jsonrpc: '2.0', id: 1,
    error: { code: -32603, message: '1f3d9-local received an unreadable city response' },
  })
  assert.deepEqual(JSON.parse(recovered), { jsonrpc: '2.0', id: 2, result: { alive: true } })
})

test('malformed and oversized input lines fail locally with http_status 400 and no city request', async () => {
  let calls = 0
  const bridge = await createMcpBridge({
    ...identityDeps(),
    maxRequestBytes: 64,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({})
    },
  })

  assert.deepEqual(JSON.parse(await bridge.handleLine('{')).error, {
    code: -32700, message: '1f3d9-local received invalid JSON', http_status: 400,
  })
  assert.deepEqual(JSON.parse(await bridge.handleLine(' '.repeat(65))).error, {
    code: -32600, message: '1f3d9-local request exceeded its size limit', http_status: 400,
  })
  assert.equal(calls, 0)
})

test('stdio processing is sequential and writes one line for each response', async () => {
  const order = []
  const input = Readable.from([
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
  ])
  let stdout = ''
  const output = new Writable({ write(chunk, _encoding, done) { stdout += chunk; done() } })

  await runMcpBridge({
    input,
    output,
    ...identityDeps(),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body)
      order.push(`start-${request.id}`)
      await new Promise(resolve => setTimeout(resolve, request.id === 1 ? 10 : 0))
      order.push(`end-${request.id}`)
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: {} })
    },
  })

  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2'])
  assert.deepEqual(stdout.trim().split('\n').map(JSON.parse).map(value => value.id), [1, 2])
})
