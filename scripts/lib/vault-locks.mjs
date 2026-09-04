import { closeSync, openSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VAULT_INDEX_LOCK_STALE_MS = 5_000
const VAULT_INDEX_LOCK_MAX_WAIT_MS = 2_000
const VAULT_INDEX_LOCK_RETRY_MS = 20

function sleepSyncMs(ms) {
  // A real, blocking sleep with no busy-spin -- Atomics.wait blocks this
  // thread without burning CPU, unlike a `while (Date.now() < until) {}`
  // spin loop would. Safe here because this whole file is synchronous,
  // single-threaded CLI code with no event loop work that a spin (or this)
  // would otherwise starve.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs `fn` (synchronous) while holding a short-lived lockfile at `lockPath`,
 * retrying with backoff for up to VAULT_INDEX_LOCK_MAX_WAIT_MS if another
 * process already holds it. A lock older than VAULT_INDEX_LOCK_STALE_MS is
 * treated as abandoned (the process that created it crashed, was killed, or
 * otherwise never reached its own cleanup) and broken rather than honored
 * forever -- this file's own contents are always small and held only for the
 * few synchronous fs calls inside `fn`, so a real holder is never actually
 * still working after that long. Returns `undefined` (running `fn` not at
 * all) if the wait budget is exhausted without ever acquiring the lock,
 * rather than blocking indefinitely -- callers here already treat the whole
 * operation as best effort.
 */
function withFileLock(lockPath, fn) {
  const deadline = Date.now() + VAULT_INDEX_LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let staleEnough = false
      try {
        staleEnough = Date.now() - statSync(lockPath).mtimeMs > VAULT_INDEX_LOCK_STALE_MS
      } catch {
        // The lock disappeared between the EEXIST above and this stat --
        // another process's own cleanup won that race; just retry.
      }
      if (staleEnough) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process may have broken (or re-created) it first; retry
          // either way rather than treating that as this call's failure.
        }
        continue
      }
      if (Date.now() >= deadline) return undefined
      sleepSyncMs(VAULT_INDEX_LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // Best effort -- see the module comment above.
    }
  }
}


/**
 * Lock path for promoteReplacementKey's critical section below, scoped to
 * one (origin, handle) pair -- deliberately not to the caller (register,
 * rotate, recoverBegin) or to the specific staging label, since what this
 * must serialize against is any OTHER promotion racing for the same live
 * vault entry on this host, whichever command started it. Lives in the
 * same ~/.1f3d9 directory as vault-index.json and reuses the exact same
 * withFileLock mechanism (short-retry, stale-aware) defined above.
 */
function promoteLockPath(origin, handle, homeDir) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeHandle = handle.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir ?? homedir(), '.1f3d9', `promote-lock__${safeOrigin}__${safeHandle}.lock`)
}

export { VAULT_INDEX_LOCK_MAX_WAIT_MS, withFileLock, promoteLockPath }
