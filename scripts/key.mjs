#!/usr/bin/env node
// `key` — status, rotate, recover, and show, all built on the vault helpers
// and the coding-client identity doors in scripts/identity-client.mjs.
// Never prints, logs, or returns a secret except `key show --reveal` at an
// interactive TTY.
//
// Usage:
//   node key.mjs status [--origin https://1f3d9.com] [--handle my-agent]
//   node key.mjs rotate [--origin ...] [--handle ...] [--reveal]
//   node key.mjs recover generate [--origin ...] [--handle ...] [--reveal]
//   node key.mjs recover begin --recovery-code-file <path|-> [--origin ...] [--reveal]
//   node key.mjs show [--origin ...] [--handle ...] [--reveal]
//   node key.mjs adopt --handle my-agent --from-label <staging-label> [--origin ...]
//
// --origin must be https, and defaults to https://1f3d9.com; https://localhost
// is always allowed for local development. Any other https origin needs
// --allow-origin <that exact origin> too — see scripts/identity-client.mjs.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import { readSecret, SecretReadFailure, HANDLE_RE, promoteReplacementKey } from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token, matching
      // identity-client.mjs's parseArgs -- without this split,
      // `--handle=x`/`--origin=x`/`--allow-origin=x`/`--recovery-code-file=x`
      // silently fell through to the (undefined) bare-flag name instead of
      // setting the flag.
      const equalsIndex = body.indexOf('=')
      if (equalsIndex !== -1) {
        flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
        continue
      }
      const name = body
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

const { flags, positionals } = parseArgs(process.argv.slice(2))
const rawOrigin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING else -- before status/rotate/
// recover/show ever touch the vault or the network for a disallowed origin.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`key: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

function resolveHandle() {
  if (typeof flags.handle === 'string') return flags.handle
  const state = readSetupState(origin)
  return state?.handle ?? null
}

function requireHandle() {
  let handle
  try {
    handle = resolveHandle()
  } catch (error) {
    if (!(error instanceof SetupStateReadFailure)) throw error
    console.error(`key: ${error.message}; pass --handle <handle> explicitly, or fix that file first.`)
    process.exitCode = 1
    return null
  }
  if (!handle) {
    console.error('key: no handle known for this origin. Pass --handle <handle>, or run setup first.')
    process.exitCode = 1
    return null
  }
  return handle
}

function requireStoredKey(handle) {
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return null
  }
  if (!stored.found) {
    console.error(`key: no vault entry found for "${handle}" at ${origin}.`)
    process.exitCode = 1
    return null
  }
  if (typeof stored.value?.resident_key !== 'string') {
    console.error(`key: a vault entry exists for "${handle}" at ${origin}, but it carries no resident_key field.`)
    process.exitCode = 1
    return null
  }
  return stored.value.resident_key
}

async function status() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  console.log(`handle: ${handle}`)
  if (!probe.ok) {
    if (probe.rejected) {
      console.log(`stored key: does not work (${probe.error})`)
    } else {
      console.log(
        `stored key: could not be verified right now (${probe.error}); this is not evidence the key is dead -- ` +
        'retry when the city is reachable.',
      )
    }
    process.exitCode = 1
    return
  }
  if (probe.handle && probe.handle !== handle) {
    console.log(
      `stored key: works, but authenticates as "${probe.handle}", not "${handle}" -- the vault entry ` +
      `labelled "${handle}" belongs to a different resident. Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    process.exitCode = 1
    return
  }
  console.log('stored key: works (one me read succeeded) — this read wakes any due timers and advances')
  console.log('this resident\'s fee-credit last-read marker, the same as any other `me` read.')
}

/**
 * Runs the same probe connect() runs, with wording matching connect.mjs's
 * mismatch message; status() reports the same mismatch without refusing,
 * since it never acts on the key. Refuses when the vault entry labelled
 * `handle` actually authenticates as someone else -- so `rotate`/`recover
 * generate` can never silently act on the WRONG resident's key just
 * because it happened to be stored under this label. On success, this also
 * prints the same disclosure `key status` prints, since this probe is the
 * same state-changing GET /api/me either way. Returns true when the caller
 * should proceed, false when this already printed a refusal and set
 * process.exitCode.
 */
async function probeMatchesOrRefuse(label, handle, residentKey) {
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  if (!probe.ok) {
    if (probe.rejected) {
      console.error(`${label}: stored key does not work (${probe.error}); refusing to act on a key that already fails.`)
      process.exitCode = 1
      return false
    }
    console.log(`${label}: one me read: FAILED (${probe.error}) -- proceeding, since there is nothing this check can validate.`)
    return true
  }
  if (probe.handle && probe.handle !== handle) {
    console.error(
      `${label}: refusing -- the vault entry labelled "${handle}" actually authenticates as "${probe.handle}", ` +
      `not "${handle}". Pass --handle ${probe.handle} instead, or fix the entry.`,
    )
    process.exitCode = 1
    return false
  }
  console.log(`${label}: stored key works (one me read succeeded) — this read wakes any due timers and advances`)
  console.log('this resident\'s fee-credit last-read marker, the same as any other `me` read.')
  return true
}

/**
 * Runs `node identity-client.mjs <args...>` with `residentKey` piped in on
 * stdin. When --reveal was requested, this can only take effect if the
 * CHILD's own stdout is a real interactive terminal (revealOrHide there
 * checks process.stdout.isTTY on the child, not this wrapper) — a captured
 * pipe, which this function otherwise always uses so it can print or
 * re-throw the child's output itself, can never be a TTY. So --reveal here
 * either hands the child the real terminal directly (this wrapper's own
 * stdout must be a TTY too) or is refused up front, never silently dropped.
 */
function runIdentityClient(label, args, residentKey) {
  if (flags.reveal === true) {
    if (!process.stdout.isTTY) {
      console.error(`${label}: --reveal cannot work through this wrapper; run scripts/identity-client.mjs ` +
        'directly at an interactive terminal.')
      process.exitCode = 1
      return
    }
    const result = spawnSync(process.execPath, [...args, '--reveal'], {
      input: residentKey,
      stdio: [residentKey === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    })
    if (result.status !== 0) process.exitCode = 1
    return
  }
  const result = spawnSync(process.execPath, args, { input: residentKey, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${label}: failed\n`)
    process.exitCode = 1
  }
}

async function rotate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  if (!(await probeMatchesOrRefuse('key rotate', handle, residentKey))) return
  const args = [identityClientPath, 'rotate', '--origin', origin, '--resident-key-file', '-']
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key rotate', args, residentKey)
}

async function recoverGenerate() {
  const handle = requireHandle()
  if (!handle) return
  const residentKey = requireStoredKey(handle)
  if (!residentKey) return
  if (!(await probeMatchesOrRefuse('key recover generate', handle, residentKey))) return
  const args = [identityClientPath, 'recover', 'generate', '--origin', origin, '--resident-key-file', '-']
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  runIdentityClient('key recover generate', args, residentKey)
}

function recoverBegin() {
  const codeSource = flags['recovery-code-file']
  if (typeof codeSource !== 'string') {
    console.error('key recover begin: --recovery-code-file <path|-> is required (never a bare --recovery-code).')
    process.exitCode = 1
    return
  }
  // Unlike rotate()/recoverGenerate() above, there is no vault-stored
  // resident key to run probeMatchesOrRefuse against before this call: the
  // whole point of recovery is to obtain a working key FROM the recovery
  // code, so no "does the stored key already work, and as whom" pre-check
  // is possible here -- there is no key yet to probe with. What CAN be
  // validated locally, before ever spawning identity-client.mjs, is the
  // SHAPE of a caller-supplied --handle (if any) -- the same HANDLE_RE this
  // script's other commands already enforce -- so an obviously malformed
  // expectation is refused up front rather than silently carried into an
  // operation that, once it confirms, cannot be undone.
  if (typeof flags.handle === 'string') {
    if (!HANDLE_RE.test(flags.handle)) {
      console.error(
        `key recover begin: --handle "${flags.handle}" does not match the city's handle rule ${HANDLE_RE.source}; ` +
        'nothing was attempted.',
      )
      process.exitCode = 1
      return
    }
    console.error(
      `key recover begin: cannot verify in advance that this recovery code belongs to "${flags.handle}" -- ` +
      'unlike rotate/recover generate, there is no vault-stored key to probe before this call runs; the ' +
      'whole point of recovery is to obtain one FROM the code. After this completes, run `key status ' +
      `--handle ${flags.handle}\` to confirm it actually matches -- the code will already be consumed ` +
      'either way, so a mismatch here is a signal to investigate, not something a retry can undo.',
    )
  }
  const args = [identityClientPath, 'recover', 'begin', '--origin', origin, '--recovery-code-file', codeSource]
  if (allowOrigin) args.push('--allow-origin', allowOrigin)
  if (flags.reveal === true) args.push('--reveal')
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exitCode = 1
}

/**
 * Recovers a resident key stranded under a registration staging label --
 * setup.mjs's stranded-registration refusal (and round-4 finding 1) points
 * here. `key status --handle <baseHandle>` can never answer that refusal's
 * question, because the confirmed key it needs lives ONLY under the staging
 * label at that point, not under the base handle -- see this function's own
 * refusal path for the same reasoning `requireStoredKey` above states for
 * status/rotate/recover. This never guesses: it reads the staged bundle by
 * its exact label, probes GET /api/me with the key it holds (disclosing that
 * read, the same as every other authenticated probe in this file), and
 * refuses outright unless that probe's own handle equals --handle exactly --
 * proof the key actually belongs to the resident being adopted, not merely a
 * label that happens to say so. Only then does it store the bundle under the
 * real handle (staged-then-promote, via promoteReplacementKey -- the same
 * critical section register()/rotate()/recover() themselves use) and delete
 * the staging copy. Never prints the key itself.
 */
async function adopt() {
  const handle = typeof flags.handle === 'string' ? flags.handle : null
  if (!handle) {
    console.error('key adopt: --handle <handle> is required -- the real handle the staged key belongs to.')
    process.exitCode = 1
    return
  }
  if (!HANDLE_RE.test(handle)) {
    console.error(`key adopt: --handle "${handle}" does not match the city's handle rule ${HANDLE_RE.source}; nothing was attempted.`)
    process.exitCode = 1
    return
  }
  const stagingLabel = flags['from-label']
  if (typeof stagingLabel !== 'string') {
    console.error(
      'key adopt: --from-label <staging-label> is required -- the vault label the stranded, already-' +
      'confirmed key is currently stored under (setup\'s registration-staging refusal, or `key status`, ' +
      'names the exact label).',
    )
    process.exitCode = 1
    return
  }
  if (stagingLabel === handle) {
    console.error(
      `key adopt: --from-label and --handle are both "${handle}"; there is no staging copy to move -- a key ` +
      'already stored under its real handle is not something adopt does anything with. Run `key status ' +
      `--handle ${handle}\` to check whether it works, or, if you believe this label is a redundant leftover ` +
      'copy rather than the resident\'s real entry, delete it by hand instead of running adopt.',
    )
    process.exitCode = 1
    return
  }
  let stored
  try {
    stored = readSecret(origin, stagingLabel)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(`key adopt: ${error.message}; refusing to guess what "${stagingLabel}" holds.`)
    process.exitCode = 1
    return
  }
  if (!stored.found) {
    console.error(`key adopt: no vault entry found for "${stagingLabel}" at ${origin} -- nothing to adopt.`)
    process.exitCode = 1
    return
  }
  if (typeof stored.value?.resident_key !== 'string') {
    console.error(
      `key adopt: a vault entry exists for "${stagingLabel}" at ${origin}, but it carries no resident_key field ` +
      '-- nothing to adopt.',
    )
    process.exitCode = 1
    return
  }
  const residentKey = stored.value.resident_key
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  console.log('key adopt: probed the staged key with one GET /api/me read — this wakes any due timers and')
  console.log('advances this resident\'s fee-credit last-read marker, the same as any other `me` read.')
  if (!probe.ok) {
    if (probe.rejected) {
      console.error(`key adopt: the key stored under "${stagingLabel}" does not work (${probe.error}); refusing to adopt it.`)
    } else {
      console.error(
        `key adopt: the key stored under "${stagingLabel}" could not be verified right now (${probe.error}); ` +
        'nothing was changed. Retry this exact adopt command when the city is reachable.',
      )
    }
    process.exitCode = 1
    return
  }
  if (probe.handle !== handle) {
    console.error(
      `key adopt: refusing -- the key stored under "${stagingLabel}" authenticates as ` +
      `${JSON.stringify(probe.handle)}, not "${handle}". Pass --handle ${probe.handle ?? '<the real handle>'} ` +
      'instead, or double-check --from-label.',
    )
    process.exitCode = 1
    return
  }

  let existingLive
  try {
    existingLive = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key adopt: could not read the existing vault entry for "${handle}" (${error.message}); refusing to ` +
      `guess whether it is safe to overwrite. The staging copy at "${stagingLabel}" -- already proven to ` +
      'authenticate as this handle -- is untouched. Resolve the unreadable entry by hand, then run this ' +
      'exact adopt command again.',
    )
    process.exitCode = 1
    return
  }

  let liveIsDead = false
  let deadReason = null
  if (existingLive.found && typeof existingLive.value?.resident_key !== 'string') {
    console.log(`key adopt: an entry exists at "${handle}" but holds no resident_key; replacing it.`)
    liveIsDead = true
    deadReason = 'it held no resident_key'
  } else if (existingLive.found) {
    const liveProbe = await probeMe(origin, existingLive.value.resident_key, { allowOrigin })
    console.log(
      liveProbe.ok
        ? `key adopt: one me read on the existing entry at "${handle}": OK (handle: ${liveProbe.handle ?? 'unknown'}).`
        : `key adopt: one me read on the existing entry at "${handle}": FAILED (${liveProbe.error}).`,
    )
    if (liveProbe.ok && liveProbe.handle === handle) {
      console.error(
        `key adopt: refusing -- the vault already holds a live entry for "${handle}" that ALSO currently ` +
        'authenticates as that same handle, so adopt will not silently pick one to keep. Read both before ' +
        `deleting either: \`key show --handle ${handle} --reveal\` for the live entry, and ` +
        `\`key show --handle ${stagingLabel} --reveal\` for the staged copy.`,
      )
      process.exitCode = 1
      return
    }
    if (liveProbe.ok) {
      console.error(
        `key adopt: refusing -- the vault entry at "${handle}" holds a key that WORKS, but authenticates as ` +
        `"${liveProbe.handle}", not "${handle}" -- it belongs to a different resident, not a dead entry. ` +
        `Nothing was changed. Recover the mislabelled entry first: \`key show --handle ${handle} --reveal\` ` +
        `reads it, and \`key adopt --handle ${liveProbe.handle} --from-label ${handle}\` moves it to its real ` +
        `handle. The staged key at "${stagingLabel}" is untouched; re-run this adopt once "${handle}" is clear.`,
      )
      process.exitCode = 1
      return
    }
    if (!liveProbe.rejected) {
      console.error(
        `key adopt: could not verify whether the existing entry at "${handle}" is dead (${liveProbe.error}); ` +
        'nothing was changed. Retry this exact adopt command once the city is reachable. The staged key at ' +
        `"${stagingLabel}" is untouched.`,
      )
      process.exitCode = 1
      return
    }
    liveIsDead = true
    deadReason = `the city rejected it (${liveProbe.error})`
  }

  let location
  try {
    location = promoteReplacementKey(origin, handle, stagingLabel, residentKey, previous => ({
      ...(typeof stored.value.client_class === 'string'
        ? { client_class: stored.value.client_class }
        : previous?.client_class ? { client_class: previous.client_class } : {}),
      ...(Array.isArray(stored.value.recovery_codes)
        ? { recovery_codes: stored.value.recovery_codes }
        : (liveIsDead ? { recovery_codes_invalidated_at: new Date().toISOString() } : {})),
    }), {}, {
      refuseIfPresent: !existingLive.found,
      expectPreviousKey: existingLive.found
        ? (typeof existingLive.value?.resident_key === 'string' ? existingLive.value.resident_key : null)
        : undefined,
      keyNoun: liveIsDead
        ? 'the already-authenticated replacement key this adopt is moving'
        : 'the already-authenticated key this adopt is moving',
      oldKeyNoun: liveIsDead ? 'the previous entry at this handle' : null,
      deadKeyClause: "this adopt's own check already found the previous entry unusable",
      concurrentCallersPhrase: 'another registration, rotation, recovery, or adopt',
    })
  } catch (error) {
    console.error(`key adopt: ${error.message}`)
    process.exitCode = 1
    return
  }
  console.log(`handle: ${handle}`)
  console.log(`stored: ${location}`)
  console.log(
    liveIsDead
      ? `key adopt: moved the confirmed key from "${stagingLabel}" to "${handle}", replacing the entry found ` +
        `there -- ${deadReason} -- and deleted the staging copy.`
      : `key adopt: moved the confirmed key from "${stagingLabel}" to "${handle}" and deleted the staging copy.`,
  )
}

function show() {
  const handle = requireHandle()
  if (!handle) return
  let stored
  try {
    stored = readSecret(origin, handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `key: ${error.message}; this is not "no key stored" -- refusing to guess. If you have a saved ` +
      'recovery code for this handle, use `key recover begin` to replace it; do not register a new identity.',
    )
    process.exitCode = 1
    return
  }
  if (!stored.found) {
    console.log(`no vault entry found for "${handle}" at ${origin}.`)
    return
  }
  if (typeof stored.value?.resident_key !== 'string') {
    console.log(
      `a vault entry exists for "${handle}" at ${origin}, but it carries no resident_key field -- there ` +
      'is nothing to show.',
    )
    return
  }
  console.log(`handle: ${handle}`)
  if (flags.reveal === true && process.stdout.isTTY) {
    console.log('Resident key (shown once):')
    console.log(stored.value.resident_key)
    if (Array.isArray(stored.value.recovery_codes)) {
      console.log('Recovery codes:')
      for (const code of stored.value.recovery_codes) console.log(code)
    } else if (stored.value.recovery_codes_invalidated_at) {
      console.log(
        `Recovery codes: invalidated by the last rotation/recovery (${stored.value.recovery_codes_invalidated_at}); ` +
        'run `key recover generate` to mint a fresh set.',
      )
    } else {
      console.log('Recovery codes: none stored.')
    }
    return
  }
  console.log('key: not printed to the terminal (pass --reveal at an interactive TTY to see it once).')
}

const command = positionals[0]
if (command === 'status') await status()
else if (command === 'rotate') await rotate()
else if (command === 'recover') {
  const sub = positionals[1]
  if (sub === 'generate') await recoverGenerate()
  else if (sub === 'begin') recoverBegin()
  else {
    console.error('key recover: needs a subcommand, "generate" or "begin"')
    process.exitCode = 1
  }
} else if (command === 'show') show()
else if (command === 'adopt') await adopt()
else {
  console.error('usage: key.mjs <status|rotate|recover generate|recover begin|show|adopt> [--flags]')
  process.exitCode = 1
}
