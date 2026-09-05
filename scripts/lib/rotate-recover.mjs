import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AGENT_SECRET_ENV_VAR, HANDLE_RE, RECOVERY_CODE_RE, RESERVED_HANDLE_SUBSTRING_RE, ROOT_KEY_RE,
  originOf, resolveSecretArg, revealOrHide,
} from './identity-input.mjs'
import { cancelStage, postAuthed, postJson } from './identity-http.mjs'
import { promoteReplacementKey } from './promote.mjs'
import { deleteSecret, readSecret, storeSecret } from './vault-backends.mjs'
import { pendingLabel } from './vault-index.mjs'
import { VAULT_INDEX_LOCK_MAX_WAIT_MS, promoteLockPath, withFileLock } from './vault-locks.mjs'

async function rotate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }

  const staged = await postJson(origin, '/api/rotate', { action: 'begin', resident_key: residentKey })

  // Defense in depth, matching register()'s validation of the city's own
  // confirmed handle (see its own comment there): rotate() uses the
  // server's own `handle` verbatim as a vault label, unlike register(),
  // where the caller names the handle itself -- so a wrong or hostile
  // response could otherwise destroy a different resident's stored key.
  // Nothing has been confirmed server-side yet at this point -- only
  // "begin" has staged a replacement key -- so this can still cancel
  // cleanly rather than merely refuse to store.
  if (
    typeof staged.handle !== 'string' || !HANDLE_RE.test(staged.handle)
    || RESERVED_HANDLE_SUBSTRING_RE.test(staged.handle)
  ) {
    await cancelStage(origin, '/api/rotate', staged.stage_token)
    throw new Error(
      `refusing to stage a replacement key under the handle the city returned (${JSON.stringify(staged.handle)}): it does ` +
      `not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" sequence ` +
      'this script uses for its own in-flight staging labels. The rotation was cancelled before confirming; ' +
      'the old key is unaffected.',
    )
  }

  // Stage the replacement under a DISTINCT vault target first -- never
  // overwrite the live entry before confirm succeeds. If confirm below
  // fails for any reason, the live entry (still the OLD, still-valid key)
  // is never touched; only this staging copy exists, and it is deleted.
  const stagingLabel = pendingLabel(staged.handle, 'rotation')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/rotate', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/rotate', staged.stage_token)
    throw error
  }

  // Promote: merge the now-confirmed replacement key with whatever the live
  // entry already held (client_class), so rotation never silently drops
  // fields that only the pre-rotation entry carried. recovery_codes are
  // deliberately NOT carried forward: the city invalidates every recovery
  // code the moment a rotation confirms (front door: "Confirmation ...
  // invalidates ... every ... recovery code atomically"), so copying the
  // old set forward would leave the vault claiming eight codes that are
  // already dead. A recovery_codes_invalidated_at marker records that fact
  // instead, so `key show` can refuse to print them (see revealOrHide's
  // caller in key.mjs) and point at `recover generate`. Only now does the
  // live entry change; the staging copy is then deleted -- unless the
  // read-back of the live entry fails, in which case promoteReplacementKey
  // refuses to overwrite it and leaves the staging copy in place. See
  // promoteReplacementKey's own doc comment above.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    recovery_codes_invalidated_at: new Date().toISOString(),
  }), {}, {
    keyNoun: 'the confirmed replacement key from this rotation',
    oldKeyNoun: 'the old key',
  })

  // The replacement key was written under staged.handle -- the label this
  // script validated (HANDLE_RE, reserved-substring check above) BEFORE
  // ever confirming, and the only spelling this call trusted as a vault
  // target. The confirm response's own `handle` field is server-supplied
  // and was never validated: printing it instead of staged.handle would
  // let a server that stages one handle and confirms a different one make
  // this command's success output name a resident that was never touched,
  // while the write itself silently landed elsewhere. If the two disagree,
  // refuse to report success under either spelling -- the write already
  // happened under staged.handle regardless, so this is purely about not
  // mis-describing what happened to the caller (and to a skill instructed
  // to relay this output verbatim).
  if (typeof confirmed.handle === 'string' && confirmed.handle !== staged.handle) {
    throw new Error(
      `the city staged this rotation under the handle ${JSON.stringify(staged.handle)} but its confirm ` +
      `response named a different handle, ${JSON.stringify(confirmed.handle)}. The replacement resident ` +
      `key WAS stored -- under ${JSON.stringify(staged.handle)}, at "${location}" -- because that is the ` +
      "label this script validated and staged before confirming; the confirm response's spelling is not " +
      `trusted for storage or display. Run \`key status --handle ${staged.handle}\` to verify the live ` +
      'entry before relying on this rotation.',
    )
  }

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${staged.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'your recovery codes were invalidated by this rotation (the city invalidates every recovery code on ' +
    'confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this rotation also revoked every connector session, authorization code, and delegated grant this ' +
    `resident had (the city invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function recoverGenerate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }
  const generated = await postJson(origin, '/api/recovery', { action: 'generate', resident_key: residentKey })

  // Defense in depth, matching register()'s validation of the city's own
  // confirmed handle (see its own comment there): the city already minted
  // these codes server-side by this point, so this cannot prevent that --
  // it only refuses to use a handle this script's naming rule rejects as a
  // LOCAL vault label, the same discipline rotate()/recoverBegin() now
  // apply to their own server-returned handle.
  if (
    typeof generated.handle !== 'string' || !HANDLE_RE.test(generated.handle)
    || RESERVED_HANDLE_SUBSTRING_RE.test(generated.handle)
  ) {
    throw new Error(
      `refusing to store the fresh recovery codes the city already generated under the handle it returned ` +
      `(${JSON.stringify(generated.handle)}): it does not match the local handle rule ${HANDLE_RE.source}, or contains ` +
      'the reserved "--pending-" sequence this script uses for its own in-flight staging labels. The codes ' +
      'are already live server-side and were printed above if --reveal was passed; nothing was stored locally.',
    )
  }

  // Write the fresh codes into the LIVE `handle` entry, not a sibling
  // `${handle}-recovery` label: a caller resuming later (rotate, recover
  // begin, key show) reads back the vault entry for `handle` and only that
  // entry, so a set stored anywhere else is invisible to them and the live
  // entry keeps claiming whatever (possibly invalidated) codes it already
  // had.
  //
  // The read, the concurrent-change check, and the write below all run
  // inside the SAME withFileLock critical section promoteReplacementKey
  // uses, keyed by (origin, handle) -- see promoteLockPath's own doc
  // comment. Without this, a concurrent `key rotate`/`key recover begin` for
  // the SAME handle can confirm a brand new resident_key between this
  // call's network round trip above and an unlocked read-then-write below,
  // and this call would then silently overwrite that brand new live entry
  // with the STALE resident_key it resolved from --resident-key-file /
  // AGENT_1F3D9_SECRET before ever reaching the network -- reverting the
  // vault to an already-revoked key while also storing recovery codes the
  // city invalidated the moment that other rotation/recovery confirmed,
  // with both commands exiting 0 and neither saying so. Re-reading the live
  // entry INSIDE the lock, immediately before the write, and refusing
  // rather than overwriting when it no longer matches what this call
  // authenticated with, is what closes that window.
  const lockPath = promoteLockPath(origin, generated.handle)
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const location = withFileLock(lockPath, () => {
    let previous
    try {
      previous = readSecret(origin, generated.handle)
    } catch (error) {
      throw new Error(
        `the city already generated new recovery codes for "${generated.handle}", but the existing vault ` +
        `entry could not be read back to merge them in: ${error.message}. Resolve the unreadable entry, ` +
        'then re-run this command; it is safe to run again.',
      )
    }
    if (previous.found && previous.value?.resident_key !== residentKey) {
      // The live entry changed since this call authenticated with
      // `residentKey` above -- some other rotation or recovery for this
      // SAME handle confirmed on this host while this call's network round
      // trip to /api/recovery was in flight. Overwriting now would silently
      // revert the vault to the resident_key THIS call read before that
      // happened -- which the city has, by now, very likely already
      // revoked -- while still claiming the fresh recovery codes as valid.
      // Refuse instead: the codes are already live server-side regardless
      // of what this call does locally.
      throw new Error(
        `refusing to store the fresh recovery codes for "${generated.handle}": the vault entry for this ` +
        'handle changed while this command was talking to the city, meaning another rotation or recovery ' +
        'for the same handle confirmed concurrently. The resident key this command authenticated with is ' +
        `very likely already revoked. Run \`key status --handle ${generated.handle}\` to see the CURRENT ` +
        'live key, then re-run `recover generate` (or `key recover generate`) with that key if you still ' +
        'need fresh codes.',
      )
    }
    return storeSecret(origin, generated.handle, {
      kind: 'resident',
      handle: generated.handle,
      ...(previous.found && previous.value?.client_class ? { client_class: previous.value.client_class } : {}),
      resident_key: residentKey,
      recovery_codes: generated.recovery_codes,
      origin,
      stored_at: new Date().toISOString(),
    })
  })
  if (location === undefined) {
    throw new Error(
      `could not acquire the per-handle vault lock for "${generated.handle}" on this host within ` +
      `${VAULT_INDEX_LOCK_MAX_WAIT_MS}ms: another registration, rotation, or recovery for the same handle ` +
      'appears to still be running concurrently on this host. The fresh recovery codes are already live ' +
      'server-side regardless of what this command does locally -- retry once the other run finishes.',
    )
  }
  // Best-effort cleanup of the sibling-label location a prior version of
  // this command used to write to, so a stale duplicate never lingers.
  deleteSecret(origin, `${generated.handle}-recovery`)
  revealOrHide(flags, 'New recovery codes (replace every earlier set)', generated.recovery_codes)
  console.log(`handle: ${generated.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverBegin(flags) {
  const origin = originOf(flags)
  const recoveryCode = await resolveSecretArg(flags, 'recovery-code')
  if (!recoveryCode || !RECOVERY_CODE_RE.test(recoveryCode)) {
    throw new Error('--recovery-code-file must point to a valid, unused recovery code')
  }

  const staged = await postJson(origin, '/api/recovery', { action: 'begin', recovery_code: recoveryCode })

  // Same handle-validation discipline as rotate() above, and for the same
  // reason: recoverBegin() also uses the server's own `handle` verbatim as
  // a vault label. Nothing has been confirmed server-side yet -- only
  // "begin" has staged a replacement key -- so this can still cancel
  // cleanly.
  if (
    typeof staged.handle !== 'string' || !HANDLE_RE.test(staged.handle)
    || RESERVED_HANDLE_SUBSTRING_RE.test(staged.handle)
  ) {
    await cancelStage(origin, '/api/recovery', staged.stage_token)
    throw new Error(
      `refusing to stage a replacement key under the handle the city returned (${JSON.stringify(staged.handle)}): it does ` +
      `not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" sequence ` +
      'this script uses for its own in-flight staging labels. The recovery was cancelled before confirming; ' +
      'the old key is unaffected.',
    )
  }

  // Same staging discipline as rotate() above, and for the same reason: the
  // old key still works until confirm below actually succeeds, so the live
  // vault entry must not be touched before that.
  const stagingLabel = pendingLabel(staged.handle, 'recovery')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/recovery', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/recovery', staged.stage_token)
    throw error
  }

  // Same promote-or-refuse discipline as rotate() above -- see
  // promoteReplacementKey's doc comment. Recovery codes are dropped here
  // too and replaced with an invalidation marker, for the same reason as
  // rotate(): the front door confirms that using one recovery code
  // invalidates every sibling code atomically, not just the one spent.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    recovery_codes_invalidated_at: new Date().toISOString(),
  }), {}, {
    keyNoun: 'the confirmed replacement key from this recovery',
    oldKeyNoun: 'the old key',
  })

  // Same discipline as rotate() above, and for the same reason: the
  // replacement key was written under staged.handle -- the validated,
  // pre-confirm spelling -- never the confirm response's own unvalidated
  // `handle` field. If the two disagree, refuse to report success under
  // either spelling rather than naming a resident that was never touched;
  // the write already happened under staged.handle regardless.
  if (typeof confirmed.handle === 'string' && confirmed.handle !== staged.handle) {
    throw new Error(
      `the city staged this recovery under the handle ${JSON.stringify(staged.handle)} but its confirm ` +
      `response named a different handle, ${JSON.stringify(confirmed.handle)}. The replacement resident ` +
      `key WAS stored -- under ${JSON.stringify(staged.handle)}, at "${location}" -- because that is the ` +
      "label this script validated and staged before confirming; the confirm response's spelling is not " +
      `trusted for storage or display. Run \`key status --handle ${staged.handle}\` to verify the live ` +
      'entry before relying on this recovery.',
    )
  }

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${staged.handle}`)
  console.log(`stored: ${location}`)
  console.log(
    'every remaining recovery code was invalidated by this recovery (the city invalidates every sibling ' +
    'code on confirm) -- run `recover generate` (or `key recover generate`) now to mint a fresh set.',
  )
  console.log(
    'this recovery also revoked every connector session, authorization code, and delegated grant the old ' +
    `key had (the city invalidates them atomically with the key) -- update whatever host secret ` +
    `${AGENT_SECRET_ENV_VAR} reads and re-run \`connect\`, and re-pair any chat twin with a fresh ` +
    '`connect chat` code; both will otherwise start failing with no obvious cause.',
  )
}

async function pair(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', [AGENT_SECRET_ENV_VAR],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error(`--resident-key-file (or ${AGENT_SECRET_ENV_VAR}) must point to the current, valid resident key`)
  }
  const minted = await postAuthed(origin, '/api/pair', residentKey, {})
  // The pairing code is meant to be read by a human, not stored -- it is
  // single-use, expires in ten minutes, and never substitutes for the key.
  // Printing it is the entire point of this command, so it is not gated
  // behind --reveal the way the resident key and recovery codes are above.
  // minted.pairing_code and minted.expires_at are server-supplied and
  // never validated against any local format rule (unlike a handle) --
  // JSON.stringify neutralizes an embedded newline (or other control
  // character) that could otherwise inject a fabricated extra line into
  // output a human or a skill is instructed to relay verbatim. next_step
  // stays readable rather than stringified, so it is accepted only as a
  // non-empty trimmed string without control characters; otherwise the
  // client prints its own accurate fallback.
  console.log('Pairing code (shown once, give it to the human completing hosted-chat sign-in):')
  console.log(JSON.stringify(minted.pairing_code))
  const cityNextStep = typeof minted.next_step === 'string' ? minted.next_step.trim() : ''
  console.log(
    cityNextStep && !/[\x00-\x1f\x7f]/u.test(cityNextStep)
      ? cityNextStep
      : 'This code is single-use and expires in ten minutes; if it is rejected, mint a fresh one rather than retrying it.',
  )
  console.log(`expires_at: ${JSON.stringify(minted.expires_at)}`)
}

export { rotate, recoverGenerate, recoverBegin, pair }
