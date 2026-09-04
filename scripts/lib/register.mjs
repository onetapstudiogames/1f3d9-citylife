import {
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, askYesNo, originOf, requireFlag, revealOrHide,
  validateModelLabel,
} from './identity-input.mjs'
import { cancelStage, postJson } from './identity-http.mjs'
import { promoteReplacementKey } from './promote.mjs'
import { deleteSecret, readSecret, storeSecret } from './vault-backends.mjs'
import { pendingLabel } from './vault-index.mjs'

async function register(flags) {
  const origin = originOf(flags)
  const handle = requireFlag(flags, 'handle')
  if (!HANDLE_RE.test(handle)) {
    throw new Error(
      `--handle "${handle}" does not match the city's handle rule ${HANDLE_RE.source} (lowercase letters, ` +
      'digits, and hyphens, 3-32 characters, must start with a letter or digit); nothing was created -- ' +
      'choose a handle that already matches this rule before asking a human to approve it',
    )
  }
  if (RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
    throw new Error(
      `--handle "${handle}" contains "--pending-", which this script reserves for its own in-flight ` +
      'staging labels; nothing was created -- choose a handle that does not contain that sequence',
    )
  }
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }
  const model = typeof flags.model === 'string' ? flags.model : ''
  const modelError = validateModelLabel(model)
  if (modelError) {
    throw new Error(`${modelError}; nothing was created -- fix --model before asking a human to approve the handle`)
  }
  const replaceVaultEntry = flags['replace-vault-entry'] === true

  let humanApproved = flags['human-approved'] === true
  if (!humanApproved) {
    humanApproved = await askYesNo(
      `Confirm the permanent public handle "${handle}" was chosen with a human's approval. Register it now?`,
    )
  }
  if (!humanApproved) {
    throw new Error(
      'registration needs human approval of the permanent public name; re-run with a "y" answer or pass --human-approved only after that approval already happened',
    )
  }

  const staged = await postJson(origin, '/api/register', {
    action: 'stage',
    handle,
    ...(model ? { model } : {}),
    client_class: clientClass,
    human_approved: true,
  })
  // The city may normalize the requested handle at staging time -- from
  // here on ITS answer is the identity of record, never the spelling this
  // call was invoked with (see the module comment on HANDLE_RE above).
  const stagedHandle = typeof staged.handle === 'string' ? staged.handle : handle

  // Validated HERE, before stagedHandle is ever used as a vault label by
  // the readSecret/pendingLabel/storeSecret calls below -- not only on
  // confirmed.handle after confirm succeeds, further down. rotate(),
  // recoverBegin(), and recoverGenerate() already validate every
  // server-returned handle before using it as a local label (round-3
  // finding 4); this stage response was the one place in this file that
  // still trusted a server answer verbatim before ever touching the vault
  // with it. A malformed or hostile staged.handle must be refused, and the
  // stage cancelled, before any local read or write happens on its
  // strength -- not discovered only after confirm already ran.
  if (!HANDLE_RE.test(stagedHandle) || RESERVED_HANDLE_SUBSTRING_RE.test(stagedHandle)) {
    await cancelStage(origin, '/api/register', staged.stage_token)
    throw new Error(
      `refusing to use the handle ${JSON.stringify(stagedHandle)} the city returned for this registration's ` +
      `stage as a vault label: it does not match the local handle rule ${HANDLE_RE.source}, or contains the ` +
      'reserved "--pending-" sequence this script uses for its own in-flight staging labels. The staged ' +
      'registration was cancelled before ever being confirmed or written to the vault; nothing was created.',
    )
  }

  // Same discipline rotate()/recoverBegin() already apply, extended to
  // register() itself: never overwrite whatever the vault already holds
  // under the identity of record without an explicit, deliberate override.
  // Without this, a stale or normalized label collision would let the
  // storeSecret call below silently destroy an existing key and its
  // recovery codes -- exactly the failure mode a dropped/ambiguous probe
  // result (setup.mjs's own vault-adopt guard cannot always tell "rejected"
  // from "could not tell") could otherwise walk straight into.
  if (!replaceVaultEntry) {
    let existing
    try {
      existing = readSecret(origin, stagedHandle)
    } catch (error) {
      await cancelStage(origin, '/api/register', staged.stage_token)
      throw new Error(
        `refusing to register over a vault entry for "${stagedHandle}" that could not be read back: ` +
        `${error.message}. The staged registration was cancelled; nothing was created. Resolve the ` +
        'unreadable entry first, then retry -- or pass --replace-vault-entry only if you are certain that ' +
        'entry should be discarded.',
      )
    }
    if (existing.found) {
      await cancelStage(origin, '/api/register', staged.stage_token)
      throw new Error(
        `refusing to register over the vault entry that already exists for "${stagedHandle}": the staged ` +
        'registration was cancelled and nothing was created. Pass --replace-vault-entry only if you are ' +
        'certain that entry should be discarded -- doing so destroys whatever key and recovery codes it ' +
        'currently holds.',
      )
    }
  }

  // Stage the new bundle under a DISTINCT vault label first, exactly like
  // rotate()/recoverBegin() below -- never write to the live label before
  // confirm actually succeeds.
  const stagingLabel = pendingLabel(stagedHandle, 'registration')
  storeSecret(origin, stagingLabel, {
    kind: 'staging',
    handle: stagedHandle,
    client_class: clientClass,
    resident_key: staged.resident_key,
    recovery_codes: staged.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/register', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    await cancelStage(origin, '/api/register', staged.stage_token)
    throw error
  }

  // The identity of record is the city's CONFIRMED answer, falling back to
  // the staged one only if the response is somehow missing it -- never the
  // originally requested spelling. promoteReplacementKey moves the staged
  // bundle to that label and deletes the staging copy only once it has
  // actually landed there.
  const finalHandle = typeof confirmed.handle === 'string' ? confirmed.handle : stagedHandle

  // Validated here, before finalHandle is ever used as a vault label,
  // printed, or (via setup.mjs's regex parse of the "handle: " line below)
  // written into setup-state.json -- the same discipline every OTHER
  // handle in this file gets before use. The registration already happened
  // server-side by this point, so this is defense in depth against the
  // city's own confirmed spelling somehow failing the rule this script
  // otherwise enforces before ever asking a human to approve a handle, not
  // an expected path.
  if (!HANDLE_RE.test(finalHandle) || RESERVED_HANDLE_SUBSTRING_RE.test(finalHandle)) {
    // Best effort: the stage is already confirmed server-side, so this call
    // is unlikely to change anything beyond what confirming already did --
    // it costs nothing to attempt, and matches every other early exit in
    // this function that cancels the stage before refusing.
    await cancelStage(origin, '/api/register', staged.stage_token)
    throw new Error(
      `refusing to store or print the handle ${JSON.stringify(finalHandle)} the city confirmed for this registration: it ` +
      `does not match the local handle rule ${HANDLE_RE.source}, or contains the reserved "--pending-" ` +
      'sequence this script uses for its own in-flight staging labels. The resident was already created ' +
      'server-side under that exact spelling, and its confirmed resident key and recovery codes were NOT ' +
      `lost -- they are still stored under the staging label "${stagingLabel}" and nowhere else. This ` +
      'script will not store them automatically for a handle that fails its own naming rule; `key show ' +
      `--handle ${stagingLabel} --reveal\` reads them back by hand, and \`key adopt\` has no use here since ` +
      'it also refuses a handle that fails this same rule -- whatever label you choose must satisfy it too.',
    )
  }

  // refuseIfPresent: register() must never silently overwrite a DIFFERENT
  // registration that came to exist for this exact handle after the
  // pre-flight check further up this function ran (see promoteReplacementKey's
  // own doc comment) -- unlike rotate()/recoverBegin() below, which
  // intentionally replace the live entry for the same already-owned handle.
  // Only when the caller passed --replace-vault-entry is that overwrite
  // actually intended -- the same flag the pre-flight check above already
  // honors, so the final write must honor it identically rather than
  // refusing what the caller explicitly asked to replace.
  const location = promoteReplacementKey(origin, finalHandle, stagingLabel, staged.resident_key, () => ({
    client_class: clientClass,
    recovery_codes: staged.recovery_codes,
  }), {}, {
    refuseIfPresent: !replaceVaultEntry,
    keyNoun: 'the confirmed resident key from this registration',
    oldKeyNoun: null,
  })

  revealOrHide(flags, 'Resident key', [staged.resident_key])
  revealOrHide(flags, 'Recovery codes (all eight)', staged.recovery_codes)
  console.log(`handle: ${finalHandle}`)
  console.log(`resident_id: ${confirmed.resident_id}`)
  console.log(`stored: ${location}`)
}


export { register }
