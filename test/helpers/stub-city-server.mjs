// A tiny, in-memory stand-in for the coding-client JSON identity doors
// (POST /api/register, /api/rotate, /api/recovery, /api/pair, GET /api/me),
// implemented in enough detail for scripts/identity-client.mjs and its
// wrappers (setup/connect/key) to run their real code paths end to end
// against it -- staging, confirming, promoting a vault entry, revealing (or
// not) a real secret -- without ever touching the live city. It is not a
// spec of the real door's behavior; it exists only to give the client
// something real to talk to.
//
// Served over HTTPS (with the self-signed localhost fixture cert in
// test/helpers/fixtures/) because scripts/lib/origin-guard.mjs refuses plain
// http even for localhost, matching the real door.

import { createServer as createHttpsServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TLS_OPTIONS = {
  key: readFileSync(join(here, 'fixtures', 'localhost-key.pem')),
  cert: readFileSync(join(here, 'fixtures', 'localhost-cert.pem')),
}

const rootKey = () => `1f3d9_sk_${randomBytes(24).toString('hex')}`
const recoveryCode = () => `1f3d9_rc_${randomBytes(32).toString('hex')}`
const recoveryCodes = () => Array.from({ length: 8 }, recoveryCode)
const token = () => randomBytes(16).toString('hex')

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {})
      } catch (error) {
        rejectPromise(error)
      }
    })
    req.on('error', rejectPromise)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function bearerKey(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer (.+)$/u.exec(header)
  return match ? match[1] : null
}

/**
 * Starts the stub on an ephemeral localhost port. Returns
 * { origin, residents, close() }. `residents` is a live Map keyed by handle
 * (values: { resident_key, recovery_codes, client_class }) a test can
 * inspect directly after driving a real CLI command against `origin`, or
 * pre-seed before starting a scenario.
 */
export async function startStubCityServer() {
  const residents = new Map()
  const pendingRegistrations = new Map() // stage_token -> { handle, resident_key, recovery_codes, client_class }
  const pendingRotations = new Map() // stage_token -> { handle, resident_key }
  const pendingRecoveries = new Map() // stage_token -> { handle, resident_key }

  const server = createHttpsServer(TLS_OPTIONS, async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/me') {
        const key = bearerKey(req)
        const found = [...residents.entries()].find(([, value]) => value.resident_key === key)
        if (!found) return send(res, 401, { error: 'invalid or expired resident key' })
        return send(res, 200, { handle: found[0] })
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
      const body = await readBody(req)

      if (req.url === '/api/register') {
        if (body.action === 'stage') {
          if (residents.has(body.handle)) {
            return send(res, 409, { error: `handle "${body.handle}" is already taken`, reason: 'handle_taken' })
          }
          const stageToken = token()
          const entry = {
            handle: body.handle,
            resident_key: rootKey(),
            recovery_codes: recoveryCodes(),
            client_class: body.client_class,
          }
          pendingRegistrations.set(stageToken, entry)
          return send(res, 200, { ...entry, stage_token: stageToken })
        }
        if (body.action === 'confirm') {
          const pending = pendingRegistrations.get(body.stage_token)
          if (!pending || pending.resident_key !== body.resident_key) {
            return send(res, 403, { error: 'stage token or resident key mismatch' })
          }
          pendingRegistrations.delete(body.stage_token)
          residents.set(pending.handle, {
            resident_key: pending.resident_key,
            recovery_codes: pending.recovery_codes,
            client_class: pending.client_class,
          })
          return send(res, 200, { handle: pending.handle, resident_id: residents.size })
        }
        return send(res, 400, { error: `unknown register action "${body.action}"` })
      }

      if (req.url === '/api/rotate') {
        if (body.action === 'begin') {
          const found = [...residents.entries()].find(([, value]) => value.resident_key === body.resident_key)
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const stageToken = token()
          pendingRotations.set(stageToken, { handle: found[0], resident_key: rootKey() })
          const pending = pendingRotations.get(stageToken)
          return send(res, 200, { handle: pending.handle, resident_key: pending.resident_key, stage_token: stageToken })
        }
        if (body.action === 'confirm') {
          const pending = pendingRotations.get(body.stage_token)
          if (!pending || pending.resident_key !== body.resident_key) {
            return send(res, 403, { error: 'stage token or resident key mismatch' })
          }
          pendingRotations.delete(body.stage_token)
          const resident = residents.get(pending.handle)
          // The real door invalidates every recovery code the moment a
          // rotation confirms -- simulated here by clearing them, so a
          // test can assert the client never claims stale codes survived.
          residents.set(pending.handle, { ...resident, resident_key: pending.resident_key, recovery_codes: [] })
          return send(res, 200, { handle: pending.handle })
        }
        return send(res, 400, { error: `unknown rotate action "${body.action}"` })
      }

      if (req.url === '/api/recovery') {
        if (body.action === 'generate') {
          const found = [...residents.entries()].find(([, value]) => value.resident_key === body.resident_key)
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const codes = recoveryCodes()
          residents.set(found[0], { ...found[1], recovery_codes: codes })
          return send(res, 200, { handle: found[0], recovery_codes: codes })
        }
        if (body.action === 'begin') {
          const found = [...residents.entries()].find(([, value]) => value.recovery_codes?.includes(body.recovery_code))
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const stageToken = token()
          pendingRecoveries.set(stageToken, { handle: found[0], resident_key: rootKey() })
          const pending = pendingRecoveries.get(stageToken)
          return send(res, 200, { handle: pending.handle, resident_key: pending.resident_key, stage_token: stageToken })
        }
        if (body.action === 'confirm') {
          const pending = pendingRecoveries.get(body.stage_token)
          if (!pending || pending.resident_key !== body.resident_key) {
            return send(res, 403, { error: 'stage token or resident key mismatch' })
          }
          pendingRecoveries.delete(body.stage_token)
          const resident = residents.get(pending.handle)
          residents.set(pending.handle, { ...resident, resident_key: pending.resident_key, recovery_codes: [] })
          return send(res, 200, { handle: pending.handle })
        }
        return send(res, 400, { error: `unknown recovery action "${body.action}"` })
      }

      if (req.url === '/api/pair') {
        const key = bearerKey(req)
        const found = [...residents.entries()].find(([, value]) => value.resident_key === key)
        if (!found) return send(res, 401, { error: 'invalid or expired resident key' })
        return send(res, 200, {
          pairing_code: `pair-${token()}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
      }

      return send(res, 404, { error: 'not found' })
    } catch (error) {
      send(res, 500, { error: error.message })
    }
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const { port } = server.address()

  return {
    origin: `https://localhost:${port}`,
    residents,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}
