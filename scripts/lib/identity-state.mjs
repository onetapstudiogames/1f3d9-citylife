// Non-secret pointer file so `setup`, `connect`, and `key` can tell "this
// host already has a configured identity for this origin" apart from "this
// is the first run" without ever touching the OS credential vault to find
// out. It stores only public facts the city already treats as public
// (handle, client_class, origin) plus local-only bookkeeping flags — never a
// resident key or recovery code. Re-running `setup` reads this file first so
// it updates the existing identity instead of registering a second one.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const statePath = (homeDir = homedir()) => join(homeDir, '.1f3d9', 'setup-state.json')

/**
 * Thrown by readSetupState when the state file exists but could not be
 * parsed as JSON -- kept distinct from "no file yet" (readSetupState returns
 * `null` for that case) so a caller can refuse to guess whether an identity
 * already exists rather than silently treating "unreadable" the same as
 * "definitely nothing here". Treating those the same is exactly how a lost
 * or truncated setup-state.json used to risk registering a second, real,
 * permanent resident on top of one that already existed.
 */
export class SetupStateReadFailure extends Error {}

/** Returns `null` only when no state file exists yet -- the genuine first run. */
export function readSetupState(origin, homeDir) {
  let raw
  try {
    raw = readFileSync(statePath(homeDir), 'utf8')
  } catch {
    return null
  }
  let all
  try {
    all = JSON.parse(raw)
  } catch (error) {
    throw new SetupStateReadFailure(
      `the setup-state file at ${statePath(homeDir)} exists but could not be parsed as JSON: ` +
      `${error.message}`,
    )
  }
  return all && typeof all === 'object' && all[origin] ? all[origin] : null
}

/** Merges `fields` into the entry for `origin`, leaving other origins alone. */
export function writeSetupState(origin, fields, homeDir = homedir()) {
  const path = statePath(homeDir)
  let all = {}
  try {
    all = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    all = {}
  }
  all[origin] = { ...(all[origin] ?? {}), ...fields, updated_at: new Date().toISOString() }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  return path
}
