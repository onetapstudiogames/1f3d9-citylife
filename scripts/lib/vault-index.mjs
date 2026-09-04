import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withFileLock } from './vault-locks.mjs'

function vaultTarget(origin, handleOrLabel) {
  return `1f3d9:${origin}:${handleOrLabel}`
}

// homeDir is injectable (defaults to the real home directory) so tests can
// round-trip storeSecret/readSecret against a temp directory instead of the
// caller's real ~/.1f3d9/credentials.
function credentialsFilePath(origin, handleOrLabel, homeDir = homedir()) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeLabel = handleOrLabel.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir, '.1f3d9', 'credentials', `${safeOrigin}__${safeLabel}.json`)
}

/**
 * The staging label a replacement credential is written under before it is
 * confirmed.
 *
 * `kind === 'registration'` gets a short random suffix, making the label
 * unique PER RUN rather than a pure function of `handle` alone. Without
 * this, two concurrent `register` invocations racing the SAME requested
 * handle would stage their bundles under the identical label; the winner's
 * own cleanup (promoteReplacementKey's final `deleteSecret`, once its write
 * actually lands) would then delete whatever the LOSER had just staged
 * there -- even though the loser's resident was itself confirmed
 * server-side and is now permanent. With the suffix, each run's staging
 * entry is exclusively its own: nothing but that run's own successful
 * promotion (or its own error-path cleanup) ever deletes it.
 *
 * `rotate()`/`recoverBegin()` do not get a suffix: their staging label is
 * scoped to a handle the caller already owns and confirms via a valid
 * resident key/recovery code, and promoteReplacementKey's per-(origin,
 * handle) file lock already serializes concurrent runs for that handle
 * end to end -- there is no legitimate way for two DIFFERENT callers to
 * even reach that code path for the same handle at once the way two
 * `register` calls can both request the same not-yet-owned handle.
 */
function pendingLabel(handle, kind) {
  if (kind === 'registration') {
    return `${handle}--pending-registration-${randomBytes(4).toString('hex')}`
  }
  return `${handle}--pending-${kind}`
}

/**
 * A LABEL-TEXT heuristic for "this looks like a staging label" -- covers
 * every kind `pendingLabel` above can produce, including the per-run
 * suffixed registration form. Used by listVaultLabels below ONLY as a
 * fallback for an entry it cannot otherwise decode (a bare `cmdkey /list`
 * scrape on win32, or a stored bundle this run's platform cannot read back).
 * It is deliberately NOT the primary source of truth: HANDLE_RE alone would
 * allow a real resident to register a handle that happens to end in one of
 * these suffixes (e.g. "agent--pending-rotation"), and RESERVED_HANDLE_SUBSTRING_RE
 * above closes that off going forward, but this function must still cope
 * with any handle already in the wild -- so listVaultLabels prefers the
 * `kind: 'staging'` marker storeSecret writes into the bundle itself
 * (pendingLabel's three callers all pass it) wherever the backend lets it
 * read that marker back, and falls back to this suffix test only when it
 * cannot.
 */
function isPendingLabel(label) {
  return /--pending-(?:rotation|recovery|registration(?:-[0-9a-f]+)?)$/u.test(label)
}

/**
 * Matches ONLY the registration form of a staging label -- the one kind
 * pendingLabel() gives a per-run random hex suffix, deliberately unlike the
 * fixed `--pending-rotation`/`--pending-recovery` forms (see pendingLabel's
 * own doc comment for why). Unlike isPendingLabel above, this is never a
 * fallback heuristic layered under a metadata marker -- the suffix shape is
 * exclusive to pendingLabel('registration'), and RESERVED_HANDLE_SUBSTRING_RE
 * already stops any real handle from ever containing "--pending-" going
 * forward, so a label matching this is authoritatively a registration
 * staging entry, never a real resident's own chosen handle. Used by
 * listVaultLabels below to surface exactly these labels (never rotation or
 * recovery ones) back to setup.mjs's duplicate-identity guard -- see that
 * property's own doc comment for why only the registration kind matters
 * there.
 */
const REGISTRATION_STAGING_LABEL_RE = /^(.+)--pending-registration-[0-9a-f]+$/u

/**
 * Splits every label a vault enumeration found (BEFORE any staging filter)
 * into `kept` (never any kind of staging label -- exactly what
 * listVaultLabels has always returned) and `registrationStaging` (only the
 * REGISTRATION-kind staging labels among the ones `kept` excludes; rotation
 * and recovery staging labels are excluded from `kept` exactly as before,
 * but never collected here).
 *
 * The registration kind gets this separate surfacing because it alone can
 * strand an already-permanent resident: a register whose vault promotion
 * fails (promoteReplacementKey.mjs -- a lock timeout, a CredWrite failure,
 * an unreadable live entry) leaves the confirmed resident_key ONLY under
 * this staging label while the resident it names is already permanent
 * server-side (the city's own /api/register confirm already succeeded).
 * setup.mjs's duplicate-identity guard must see that and refuse, rather
 * than silently registering a second, permanent, unrecoverable resident
 * under whatever different handle a later, state-lost run happens to
 * choose. Rotation/recovery staging labels carry no equivalent risk: their
 * live entry sits under the same handle the guard already checks against
 * (rotate/recoverBegin never mint a fresh, not-yet-owned handle the way
 * register does), so an abandoned one there is already covered.
 *
 * The suffix test alone is authoritative only where the index has nothing
 * to say: it consults `indexMap` FIRST, with the same precedence
 * isStagingLabel uses -- a label the index positively marks `staging:
 * false` is real resident metadata, not a guess about what the label text
 * looks like, and is routed to `kept` even when its shape matches
 * REGISTRATION_STAGING_LABEL_RE (HANDLE_RE permits handles up to 32
 * characters, long enough to collide with this suffix by coincidence, e.g.
 * "abc--pending-registration-a"). Only when the index is silent about a
 * label (no entry, or an entry with no boolean `staging`) does the suffix
 * shape decide -- see isStagingLabel's own doc comment for why.
 */
function splitStagingLabels(labels, indexMap) {
  const kept = []
  const registrationStaging = []
  for (const label of labels) {
    const meta = indexMap.get(label)
    const known = meta && typeof meta.staging === 'boolean'
    if (REGISTRATION_STAGING_LABEL_RE.test(label) && (!known || meta.staging === true)) {
      registrationStaging.push(label)
      continue
    }
    if (!isStagingLabel(label, indexMap)) kept.push(label)
  }
  return { kept, registrationStaging }
}

/**
 * Attaches `registrationStaging` to `kept` as a non-enumerable property --
 * alongside it, not mixed into the array itself, so every existing caller
 * of listVaultLabels (which only ever iterates/filters/maps the array of
 * kept labels) sees no change at all, while setup.mjs's guard can read
 * `allLabels.registrationStagingLabels` explicitly. Non-enumerable so
 * `[...labels]`, `JSON.stringify(labels)`, and a `for...of` never surface it
 * as if it were a label itself.
 */
function withRegistrationStagingLabels(kept, registrationStaging) {
  Object.defineProperty(kept, 'registrationStagingLabels', {
    value: registrationStaging, enumerable: false, writable: false, configurable: true,
  })
  return kept
}

// --- Non-secret vault index (macOS and Windows) -----------------------------
//
// Neither macOS nor Windows has a fully reliable, non-interactive way for
// this script to enumerate every vault entry it owns. On macOS, `security
// dump-keychain` (metadata only -- deliberately never `-d`, which would
// also decrypt and print every stored PASSWORD, not just service/account
// names) lists every entry in the user's whole login keychain, not just
// this plugin's -- so it has to be filtered to this plugin's own
// `1f3d9:<origin>:` service prefix before it means anything, and it can
// still fail outright (no `security` on PATH, a locked keychain). Windows
// has a different problem with the same shape: `cmdkey /list` is this
// script's only non-interactive way to enumerate entries, but its output is
// localized -- on a non-English Windows install the literal "Target:" label
// this script parses for never appears, so scraping it alone silently
// returns nothing, language-dependently. Instead, storeSecret and
// deleteSecret below keep a small non-secret index file --
// ~/.1f3d9/vault-index.json, labels plus a `staging` marker, never a key or
// recovery code -- that setup.mjs's duplicate-identity guard reads through
// listVaultLabels. It is a heuristic, not a source of truth: it can go
// stale if an entry is removed by some other tool (Keychain Access.app,
// Windows Credential Manager's own UI, `security`/`cmdkey` by hand) --
// listVaultLabels below treats that as fine to err toward -- but it can
// also go MISSING ENTIRELY while the vault entries themselves are intact
// (a reset HOME, a moved profile, a corrupted or deleted file), and on
// macOS the index lived under that same HOME, so trusting it alone in that
// exact scenario would make the duplicate-identity guard fail open right
// where it matters most. listVaultLabels below therefore unions the index
// with a real enumeration on every platform it can manage one for: on
// win32, whatever `cmdkey /list` scraping finds; on darwin, whatever the
// filtered `security dump-keychain` scan above finds. Neither source alone
// is ever trusted as complete -- the whole point is only ever to make setup
// ask for --new-identity one time too many, never to silently register a
// real duplicate resident. The
// `staging` marker on each entry is what listVaultLabels prefers over
// isPendingLabel's label-text guess (see its own doc comment) -- it comes
// from the bundle's own `kind` field, recorded here at write time so
// listVaultLabels never has to decode the secret itself just to tell a real
// resident from an in-flight staging copy.

function vaultIndexPath(homeDir = homedir()) {
  return join(homeDir, '.1f3d9', 'vault-index.json')
}

function readVaultIndex(homeDir) {
  try {
    const parsed = JSON.parse(readFileSync(vaultIndexPath(homeDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Normalizes one origin's raw vault-index.json entries -- an array that may
 * mix legacy bare-string entries (written before this index carried a
 * `staging` marker) with the current `{ label, staging }` object form --
 * into a Map from label to `{ staging }`. A legacy string entry's staging
 * status is unknown (`staging: undefined`), which listVaultLabels below
 * treats as "fall back to the isPendingLabel suffix guess for this one",
 * exactly like an entry it cannot decode at all.
 */
function vaultIndexEntriesToMap(entries) {
  const map = new Map()
  for (const entry of entries) {
    if (typeof entry === 'string') {
      map.set(entry, { staging: undefined })
    } else if (entry && typeof entry === 'object' && typeof entry.label === 'string') {
      // A malformed or absent `staging` field must stay unknown, not be
      // read as a definite "not staging" -- only a real boolean this
      // version itself wrote is trustworthy either way (see
      // vaultIndexEntriesToMap's own comment above and isStagingLabel).
      map.set(entry.label, { staging: typeof entry.staging === 'boolean' ? entry.staging : undefined })
    }
  }
  return map
}

// updateVaultIndex is a read-modify-write over one shared file with no
// built-in locking of its own -- two runs updating it at nearly the same
// moment (a rotate and a register from two different sessions, or just two
// tests in this repo's own suite) can each read the same starting state,
// mutate their own copy, and write it back, with the second write silently
// discarding the first's change. lockWithRetry below closes that window
// with a plain `wx`-mode (O_EXCL) lockfile next to vault-index.json: only
// one process can ever hold that name at once, so a second one either waits
// briefly or, if the lock looks abandoned, breaks it and proceeds.

/** Compares two label->{staging} Maps (as built by vaultIndexEntriesToMap / mutated in place below). */
function labelMapsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [label, meta] of a) {
    const otherMeta = b.get(label)
    if (!otherMeta) return false
    if (Boolean(otherMeta.staging) !== Boolean(meta.staging)) return false
  }
  return true
}

/**
 * Best effort: the index is a heuristic, so a write failure here is never
 * fatal. Also a no-op, on purpose, when `mutate` would not actually change
 * anything -- most commonly deleteSecret's own cleanup of a label this
 * particular homeDir's index never held in the first place (a mismatched
 * homeDir between the storeSecret and deleteSecret call that wrote/read
 * it, or simply deleting something already gone). Without this check,
 * every such call would still create ~/.1f3d9 and (re)write
 * vault-index.json purely to record the same empty state it already had --
 * which is exactly how a caller that forgets to pass the SAME `homeDir` a
 * test used elsewhere quietly starts writing into the operator's real
 * home. This is a defense-in-depth backstop, not a substitute for passing
 * `homeDir` correctly at every call site -- see
 * test/*.test.mjs and scripts/run-tests-with-home-guard.mjs.
 *
 * A cheap, unlocked peek decides first whether anything would change at
 * all; only when it would does this go on to create the directory, take
 * the lock, and re-check under it (a concurrent writer could have changed
 * things between the peek and the lock) before actually writing.
 */
function updateVaultIndex(origin, label, homeDir, mutate) {
  try {
    const path = vaultIndexPath(homeDir)

    const peekIndex = readVaultIndex(homeDir)
    const peekLabels = vaultIndexEntriesToMap(Array.isArray(peekIndex[origin]) ? peekIndex[origin] : [])
    const probeLabels = new Map(peekLabels)
    mutate(probeLabels, label)
    if (labelMapsEqual(probeLabels, peekLabels)) return

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    withFileLock(`${path}.lock`, () => {
      const index = readVaultIndex(homeDir)
      const labels = vaultIndexEntriesToMap(Array.isArray(index[origin]) ? index[origin] : [])
      const before = new Map(labels)
      mutate(labels, label)
      if (labelMapsEqual(labels, before)) return
      // Preserve unknown-ness on rewrite: a label whose staging status this
      // version never learned (a legacy bare-string entry this run did not
      // itself touch with a boolean) must be written back as the same bare
      // string, not upgraded to `staging: false` -- doing so would assert a
      // fact this version never actually observed. Only a label this
      // version itself set `{ staging }` for (via storeSecret's own boolean
      // above) gets the object form.
      index[origin] = [...labels].map(([entryLabel, meta]) =>
        meta.staging === undefined ? entryLabel : { label: entryLabel, staging: meta.staging === true },
      )
      writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
    })
  } catch {
    // Best effort -- see the module comment above.
  }
}

/**
 * True when `label` should be excluded from listVaultLabels' result --
 * i.e. it is a staging copy, not a real registered identity. Prefers the
 * `staging` marker `indexMap` carries for this label (set from the bundle's
 * own `kind` field at write time -- see storeSecret above), since that is
 * data, not a guess about what the label text looks like: a real resident
 * whose handle happens to end in "--pending-rotation" or similar has
 * `staging: false` recorded for it and is never dropped this way. Falls
 * back to the isPendingLabel suffix heuristic only when `indexMap` has no
 * entry for this label at all, or its staging status is unknown (a legacy
 * index entry written before this marker existed, or -- on win32 -- a label
 * `cmdkey /list` found that the index never recorded).
 */
function isStagingLabel(label, indexMap) {
  const meta = indexMap.get(label)
  if (meta && typeof meta.staging === 'boolean') return meta.staging
  return isPendingLabel(label)
}

export {
  vaultTarget, credentialsFilePath, pendingLabel, isPendingLabel, splitStagingLabels,
  withRegistrationStagingLabels, readVaultIndex, vaultIndexEntriesToMap, updateVaultIndex,
}
