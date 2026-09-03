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
import { validateModelLabel } from '../../scripts/identity-client.mjs'

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
 *
 * `registerConfirmBarrier` (optional): `{ handle, count }`. When set,
 * register's 'confirm' action for any stage token whose staged handle
 * equals `handle` is held -- not responded to at all -- until `count` such
 * confirm requests are concurrently outstanding, at which point every held
 * one is released together. A held request is also released, on its own,
 * after REGISTER_CONFIRM_BARRIER_TIMEOUT_MS if `count` never arrives (one
 * racing subprocess failing before its own confirm -- a PowerShell
 * CredWrite hiccup, a storeSecret refusal, a crash) -- so that turns into a
 * loud, failing assertion in the test instead of an indefinite CI hang.
 * This exists for exactly one caller: this file's own
 * concurrent-registration race test in test/identity-commands.test.mjs,
 * which needs its two real subprocesses to genuinely overlap rather than
 * hoping OS scheduling makes them.
 * confirm is the FIRST network call register() makes AFTER its own local
 * pre-flight vault check (readSecret, identity-client.mjs:1277, run right
 * after stage() -- see register()'s own comment there) -- so a confirm
 * request reaching this server already proves that process's own
 * pre-flight check has already run. Holding every such request until
 * `count` have arrived therefore guarantees, structurally rather than by
 * luck, that no process can reach its own vault write (inside
 * promoteReplacementKey, which only runs after confirm resolves) before
 * every other racing process has already passed its own pre-flight
 * check -- which is the actual overlap the race test means to exercise.
 * Every other caller of this function omits the option, so it changes
 * nothing about the ~20 other scenarios sharing this stub.
 */
const REGISTER_CONFIRM_BARRIER_TIMEOUT_MS = 10_000

/**
 * `holdRecoveryGenerateUntilRotateConfirms` (optional): `{ handle }`. When
 * set, this door runs a two-way rendezvous between `/api/recovery`
 * `generate` and `/api/rotate` `confirm` for the SAME handle, so a test can
 * force the exact overlap the recoverGenerate-vs-rotate finding depends on
 * without hoping two real subprocesses happen to interleave:
 *
 *   1. A `generate` request for `handle` is computed and applied to
 *      `residents` immediately (this door already has the new codes live
 *      server-side the moment it decides to answer, exactly like the real
 *      city), then signals its own arrival and parks its HTTP response --
 *      not yet sent.
 *   2. A `confirm` request for a rotation of the SAME `handle` waits for
 *      that arrival signal (immediately, if `generate` already arrived)
 *      before committing the new key to `residents` -- so `generate`'s
 *      still-valid-old-key read is guaranteed to have already happened,
 *      server-side, before the rotation it is racing against commits.
 *   3. Only once `confirm` has actually committed does it release the
 *      parked `generate` response -- reproducing the finding's own "a
 *      delaying HTTPS proxy in front of it" scenario: the door processed
 *      `generate` with the still-valid pre-rotation key, but the CLIENT
 *      does not learn that until AFTER the concurrent rotation has already
 *      confirmed and moved the live key.
 *
 * Either side of the rendezvous also releases, on its own, after
 * RECOVERY_GENERATE_HOLD_TIMEOUT_MS if its counterpart never arrives (one
 * racing subprocess failing before reaching the network at all), so a test
 * bug here turns into a loud failing assertion rather than an indefinite CI
 * hang. Exists for exactly one caller: identity-commands.test.mjs's own
 * recoverGenerate/rotate race test.
 */
const RECOVERY_GENERATE_HOLD_TIMEOUT_MS = 10_000

/**
 * `corruptHandle` (optional):
 * `{ rotateBegin, rotateConfirm, recoveryBegin, recoveryConfirm, recoveryGenerate }`,
 * each an optional replacement handle string. When set, the matching door
 * response returns that string as `handle` instead of the real resident's
 * handle -- simulating a compromised or misbehaving server answering with a
 * DIFFERENT handle than the one the caller actually authenticated as, so a
 * test can drive identity-client.mjs's real client code and assert it
 * refuses to use that answer as a local vault label rather than trusting it
 * verbatim (defense in depth; see register()'s own validation of its
 * confirmed handle, which rotate()/recoverBegin()/recoverGenerate() now
 * mirror). Exists for exactly the handle-validation tests in
 * identity-client.test.mjs.
 *
 * The `*Confirm` variants exist separately from `*Begin` because they
 * reproduce a narrower, later-stage scenario: a server that answers
 * `begin` with a well-formed handle (passing the client's pre-confirm
 * HANDLE_RE check) and then answers `confirm` with a DIFFERENT string --
 * one the client never validates at all, because rotate()/recoverBegin()
 * only ever used the confirm response's `handle` for a printed status
 * line, never as the vault label (that has always been the validated
 * `staged.handle`). A `*Confirm` value may be any string, including one
 * containing embedded newlines, to reproduce the transcript-injection half
 * of that same finding.
 */
export async function startStubCityServer({
  registerConfirmBarrier, holdRecoveryGenerateUntilRotateConfirms, corruptHandle,
} = {}) {
  const residents = new Map()
  const pendingRegistrations = new Map() // stage_token -> { handle, resident_key, recovery_codes, client_class }
  const pendingRotations = new Map() // stage_token -> { handle, resident_key }
  const pendingRecoveries = new Map() // stage_token -> { handle, resident_key }
  let confirmBarrierWaiters = []
  let confirmBarrierTimer = null
  // Set only while holdRecoveryGenerateUntilRotateConfirms is configured --
  // see that option's own doc comment for the two-way rendezvous these
  // three implement together.
  let recoveryGenerateArrivedRelease = null
  const recoveryGenerateArrivedPromise = holdRecoveryGenerateUntilRotateConfirms
    ? new Promise(resolveThis => { recoveryGenerateArrivedRelease = resolveThis })
    : null
  let heldRecoveryGenerateRelease = null // set only while a matching generate response is parked

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
          // Mirrors the city's own /api/register model-label rule (see
          // scripts/identity-client.mjs's validateModelLabel, which mirrors
          // src/input.ts's publicText) -- without this, the stub would
          // silently accept a --model the real door refuses, which is
          // exactly the divergence the round-3 finding this closes was
          // about: a client-side --model check that has nothing real to
          // disagree with can never be pinned by a test against this stub.
          if (typeof body.model === 'string' && body.model) {
            const modelError = validateModelLabel(body.model)
            if (modelError) return send(res, 400, { error: modelError, reason: 'invalid_identity' })
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
          if (registerConfirmBarrier && pending.handle === registerConfirmBarrier.handle) {
            // Synchronous (no `await` between push and the length check) --
            // Node's single-threaded event loop means no other request's
            // handler can interleave here, so two concurrent confirms can
            // never both observe a stale waiters length and both release.
            await new Promise(releaseThis => {
              confirmBarrierWaiters.push(releaseThis)
              if (confirmBarrierWaiters.length === 1) {
                // Deadline for THIS batch: if `count` never arrives (a
                // racing subprocess failed before reaching its own
                // confirm), release whoever IS waiting instead of parking
                // them here forever -- see the doc comment above.
                confirmBarrierTimer = setTimeout(() => {
                  const waiters = confirmBarrierWaiters
                  confirmBarrierWaiters = []
                  confirmBarrierTimer = null
                  for (const release of waiters) release()
                }, REGISTER_CONFIRM_BARRIER_TIMEOUT_MS)
              }
              if (confirmBarrierWaiters.length >= registerConfirmBarrier.count) {
                if (confirmBarrierTimer) {
                  clearTimeout(confirmBarrierTimer)
                  confirmBarrierTimer = null
                }
                const waiters = confirmBarrierWaiters
                confirmBarrierWaiters = []
                for (const release of waiters) release()
              }
            })
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
          const returnedHandle = corruptHandle?.rotateBegin ?? pending.handle
          return send(res, 200, { handle: returnedHandle, resident_key: pending.resident_key, stage_token: stageToken })
        }
        if (body.action === 'confirm') {
          const pending = pendingRotations.get(body.stage_token)
          if (!pending || pending.resident_key !== body.resident_key) {
            return send(res, 403, { error: 'stage token or resident key mismatch' })
          }
          if (holdRecoveryGenerateUntilRotateConfirms && holdRecoveryGenerateUntilRotateConfirms.handle === pending.handle) {
            // Wait for a matching recover-generate request to have arrived
            // (and been processed, server-side, against the still-valid
            // pre-rotation key) BEFORE this rotation commits below -- see
            // holdRecoveryGenerateUntilRotateConfirms's own doc comment for
            // why this ordering is what makes the overlap deterministic.
            await Promise.race([
              recoveryGenerateArrivedPromise,
              new Promise(resolveThis => setTimeout(resolveThis, RECOVERY_GENERATE_HOLD_TIMEOUT_MS)),
            ])
          }
          pendingRotations.delete(body.stage_token)
          const resident = residents.get(pending.handle)
          // The real door invalidates every recovery code the moment a
          // rotation confirms -- simulated here by clearing them, so a
          // test can assert the client never claims stale codes survived.
          residents.set(pending.handle, { ...resident, resident_key: pending.resident_key, recovery_codes: [] })
          // Release a parked recover-generate response for this SAME
          // handle now that the rotation it was meant to race against has
          // actually landed -- see holdRecoveryGenerateUntilRotateConfirms's
          // own doc comment above.
          if (
            holdRecoveryGenerateUntilRotateConfirms
            && holdRecoveryGenerateUntilRotateConfirms.handle === pending.handle
            && heldRecoveryGenerateRelease
          ) {
            const release = heldRecoveryGenerateRelease
            heldRecoveryGenerateRelease = null
            release()
          }
          return send(res, 200, { handle: corruptHandle?.rotateConfirm ?? pending.handle })
        }
        return send(res, 400, { error: `unknown rotate action "${body.action}"` })
      }

      if (req.url === '/api/recovery') {
        if (body.action === 'generate') {
          const found = [...residents.entries()].find(([, value]) => value.resident_key === body.resident_key)
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const codes = recoveryCodes()
          // Applied to server-side state immediately, exactly like the real
          // city -- only the HTTP response delivery is ever held below.
          residents.set(found[0], { ...found[1], recovery_codes: codes })
          const returnedHandle = corruptHandle?.recoveryGenerate ?? found[0]
          const responseBody = { handle: returnedHandle, recovery_codes: codes }
          if (holdRecoveryGenerateUntilRotateConfirms && holdRecoveryGenerateUntilRotateConfirms.handle === found[0]) {
            if (recoveryGenerateArrivedRelease) {
              recoveryGenerateArrivedRelease()
              recoveryGenerateArrivedRelease = null
            }
            await new Promise(releaseThis => {
              heldRecoveryGenerateRelease = releaseThis
              setTimeout(() => {
                if (heldRecoveryGenerateRelease === releaseThis) {
                  heldRecoveryGenerateRelease = null
                  releaseThis()
                }
              }, RECOVERY_GENERATE_HOLD_TIMEOUT_MS)
            })
          }
          return send(res, 200, responseBody)
        }
        if (body.action === 'begin') {
          const found = [...residents.entries()].find(([, value]) => value.recovery_codes?.includes(body.recovery_code))
          if (!found) return send(res, 403, { error: 'credential_rejected' })
          const stageToken = token()
          pendingRecoveries.set(stageToken, { handle: found[0], resident_key: rootKey() })
          const pending = pendingRecoveries.get(stageToken)
          const returnedHandle = corruptHandle?.recoveryBegin ?? pending.handle
          return send(res, 200, { handle: returnedHandle, resident_key: pending.resident_key, stage_token: stageToken })
        }
        if (body.action === 'confirm') {
          const pending = pendingRecoveries.get(body.stage_token)
          if (!pending || pending.resident_key !== body.resident_key) {
            return send(res, 403, { error: 'stage token or resident key mismatch' })
          }
          pendingRecoveries.delete(body.stage_token)
          const resident = residents.get(pending.handle)
          residents.set(pending.handle, { ...resident, resident_key: pending.resident_key, recovery_codes: [] })
          return send(res, 200, { handle: corruptHandle?.recoveryConfirm ?? pending.handle })
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

/**
 * A stub that answers every request with a 307 redirect to `location`,
 * regardless of method or path -- used only to prove postJson/postAuthed
 * (identity-client.mjs) and probeMe (lib/identity-probe.mjs) refuse to
 * follow it instead of resending a secret-carrying request to wherever it
 * points. Served over HTTPS with the same fixture cert as
 * startStubCityServer, since assertAllowedOrigin refuses plain http even
 * for localhost, so this must look like a legitimate origin up to the
 * redirect itself.
 */
export async function startRedirectingStubServer(location) {
  const server = createHttpsServer(TLS_OPTIONS, (req, res) => {
    res.writeHead(307, { location })
    res.end()
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const { port } = server.address()
  return {
    // 127.0.0.1, not localhost: the server above only binds IPv4, and on at
    // least one sandboxed CI-like environment resolving "localhost" here hit
    // undici's ~10s connect timeout trying (and failing) an IPv6 leg first.
    // assertAllowedOrigin allows 127.0.0.1 unconditionally too, same as
    // localhost, so this is not a weaker test of the origin guard.
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}
