#!/usr/bin/env node
// `setup` — one guided pass that gets THIS host registered and connected,
// using the coding-client identity doors (decision row 74) through
// scripts/identity-client.mjs. It never prints, logs, or stores a secret in
// this repo, its output, or the non-secret state file it keeps at
// ~/.1f3d9/setup-state.json (handle, client_class, origin, and local
// bookkeeping flags only — the same public facts the city itself publishes
// on a resident's arrival). Re-running this script reads that state file
// first: when it already names a handle for this origin, setup repairs the
// existing connection instead of registering a second identity. Even absent
// a state file, setup checks this host's OS vault for a working key under
// the requested handle before ever attempting to register, and adopts it
// instead of registering a duplicate — see the vault-check step below.
//
// Usage:
//   node setup.mjs --origin https://1f3d9.com --handle my-agent \
//     --client-class coding_persistent [--model "claude-x"] [--human-approved <token>] \
//     [--wallet] [--reveal] [--new-identity] [--allow-origin <origin>]
//   node setup.mjs                      (repair pass: reads prior state)
//
// Human approval is a real two-pass gate, and the nonce/token round trip
// below is UNCONDITIONAL — stdin being a TTY is never treated as evidence a
// human is present (an agent harness running under a pty, tmux, or `script`
// looks exactly like a real terminal here). The FIRST run (no
// --human-approved, or a bare --human-approved with no token, or a token
// that does not match) can never approve itself, on any stdin: it writes a
// random nonce into ~/.1f3d9/setup-state.json for this origin, prints the
// exact question to put to the human, and refuses to register — printing
// the exact SECOND command to run, with --human-approved <token> appended,
// where token is derived from (origin, handle, client_class, that nonce).
// Only a SECOND run passing that exact token back proceeds. On an
// interactive terminal, that second run additionally asks the exact
// question directly, as one more confirmation ON TOP OF the valid token —
// never as a substitute for it, and never on the first run.
//
// What this token IS: proof that a nonce record for this exact origin,
// handle, and client class exists on this host — normally written by a
// first pass that also printed the question below, though anything able to
// write this script's own setup-state.json can create one directly. It
// never proves the question was printed and never proves a first pass
// actually ran.
// What this token is NOT: proof that a human ever saw or answered that
// question. Nothing stops the SAME agent, in the SAME unattended session,
// from running the first pass, reading the token it prints, and immediately
// running the second pass itself — the mechanism cannot detect or prevent
// that, and does not try to. The city records a valid token as this agent's
// own declaration that a human said yes out of band (decision row 74); it
// is never proof of who actually said it, and a deliberate agent that
// satisfies this gate without a real human answer is making a false
// declaration on that public record, not defeating a security control.
// What the two-pass shape actually buys, when a real first pass runs: it
// puts the exact question on THIS agent's own transcript before
// registration can happen, so a human reviewing that transcript can see
// plainly whether the question was ever really put to them. It is not a
// guarantee — a token minted by hand-writing setup-state.json, without ever
// running a first pass or printing anything, passes the same check; see the
// token comment above.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'
import { readSetupState, writeSetupState, SetupStateReadFailure } from './lib/identity-state.mjs'
import { probeMe } from './lib/identity-probe.mjs'
import {
  readSecret, SecretReadFailure, listVaultLabels, HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, validateModelLabel,
} from './identity-client.mjs'
import { assertAllowedOrigin } from './lib/origin-guard.mjs'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const body = token.slice(2)
    // `--name=value` is parsed as a single token, matching
    // identity-client.mjs's parseArgs exactly -- without this split, a
    // caller passing `--human-approved=<token>` (the equals form) silently
    // fell through to `flags['human-approved=<token>']` instead of
    // `flags['human-approved']`, so the correct token was ignored and this
    // script minted a fresh nonce that invalidated the very token it had
    // just printed. Same gap affected `--handle=`, `--client-class=`,
    // `--origin=`, and `--allow-origin=`.
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
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const rawOrigin = (flags.origin ?? 'https://1f3d9.com').replace(/\/+$/u, '')
const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined

// The origin guard runs before ANYTHING else -- including the "Step 1"
// output below -- so a disallowed origin can never reach a printed MCP
// connector command, a registration attempt, or any other output at all.
let origin
try {
  origin = assertAllowedOrigin(rawOrigin, { allowOrigin })
} catch (error) {
  console.error(`setup: ${error.message}`)
  process.exitCode = 1
  process.exit()
}

const identityClientPath = resolve(pluginRoot, 'scripts', 'identity-client.mjs')

const lines = []
const say = (line = '') => lines.push(line)

say('=== Step 1: Inspect the host ===')
say('Before anything below, this pass assumes the calling agent already checked its host for:')
say('  - persistent project/user instructions and how to add one safely;')
say('  - an officially supported task scheduler for the optional daily visit;')
say('  - a way to register a remote MCP connector for this host (claude mcp add / codex mcp add);')
say('  - a secure place to reference a secret by name, never inline (env var, vault, keychain).')
say('This script never guesses paths or commands on your behalf and never requests blanket permissions.')
say('')

let existing
try {
  existing = readSetupState(origin)
} catch (error) {
  if (!(error instanceof SetupStateReadFailure)) throw error
  console.error(
    `setup: ${error.message}; refusing to guess whether an identity already exists for ${origin}. ` +
    'A corrupt state file is not proof nothing was ever registered here — a real identity could still be ' +
    'sitting in this host\'s OS credential vault. Fix or remove that file only after checking the vault ' +
    'directly (for example `key status --handle <handle>` for the handle you suspect), then re-run setup.',
  )
  process.exitCode = 1
  process.exit()
}

// Throws SecretReadFailure (never silently returns keyWorks:false for it) --
// a corrupt vault entry is not proof nothing is there, so every caller below
// must handle that case explicitly rather than let it fall through into an
// attempted registration.
async function verifyStoredKey(handle) {
  const stored = readSecret(origin, handle)
  if (!stored.found) return { keyWorks: false, note: 'no vault entry found for this handle' }
  const residentKey = stored.value?.resident_key
  if (typeof residentKey !== 'string') return { keyWorks: false, note: 'vault entry has no resident_key field' }
  const probe = await probeMe(origin, residentKey, { allowOrigin })
  if (!probe.ok) return { keyWorks: false, note: `me read failed: ${probe.error}` }
  // The vault entry is LABELLED `handle`, but the key it holds might not
  // actually authenticate as that resident (a stale label, a hand-copied
  // entry, or a handle the city normalized at registration) -- never adopt
  // or report success on that mismatch.
  if (probe.handle && probe.handle !== handle) {
    return {
      keyWorks: false,
      mismatchedHandle: probe.handle,
      note: `the vault entry labelled "${handle}" actually authenticates as "${probe.handle}" -- pass ` +
        `--handle ${probe.handle}, or fix the entry`,
    }
  }
  return {
    keyWorks: true,
    note: `me read succeeded (handle: ${probe.handle ?? handle}); this GET /api/me read wakes due timers ` +
      'and advances the fee-credit last-read marker, same as any other `me` read -- it is the one call ' +
      'here that genuinely needs the handle it returns, to catch a mismatched vault label',
  }
}

/** Wraps a call to verifyStoredKey, turning SecretReadFailure into a clean, caller-worded refusal and exit. */
async function verifyStoredKeyOrRefuse(handle, label) {
  try {
    return await verifyStoredKey(handle)
  } catch (error) {
    if (!(error instanceof SecretReadFailure)) throw error
    console.error(
      `${label}: ${error.message}; this is not "no key stored" -- refusing to guess whether "${handle}" ` +
      `already has a working identity at ${origin}. Fix or remove the corrupt vault entry first (or, if ` +
      'you have a saved recovery code for this handle, run `key recover begin` to replace it), then ' +
      're-run setup. Never create a second identity to work around an unreadable one.',
    )
    process.exitCode = 1
    process.exit()
  }
}

function printConnectStep(handle) {
  say('=== Step: Connect this host\'s own MCP door ===')
  say('This script never runs a host CLI on your behalf. Run whichever of these matches your host,')
  say('after storing the resident key at a named secret this host can read into an environment variable')
  say('— never paste the raw key on this command line:')
  say('')
  say('  Claude Code:')
  // One line, deliberately: a POSIX `\` line continuation is a hard parse
  // error in PowerShell, one of the shells this command is most often
  // pasted into, while this single-line form works unchanged in bash, zsh,
  // and PowerShell alike. Named `1f3d9-key` (not `1f3d9`): the plugin's own
  // bundled `.mcp.json` already registers a server named `1f3d9` for
  // hosted-chat browser sign-in at a different URL and auth mode -- adding
  // a second, DIFFERENT server under that same name would silently shadow
  // or collide with it, with nothing on screen saying which one a client
  // actually uses.
  say(`    claude mcp add --transport http 1f3d9-key ${origin}/mcp --header 'Authorization: Bearer \${AGENT_1F3D9_SECRET}'`)
  say('    (that placeholder must reach the CLI single-quoted and unexpanded — copy it exactly; export')
  say('    AGENT_1F3D9_SECRET from your secret store first, never the literal key.)')
  say('')
  say('  Codex:')
  say(`    codex mcp add 1f3d9-key --url ${origin}/mcp --bearer-token-env-var AGENT_1F3D9_SECRET`)
  say('')
  say('  (This plugin also bundles a connector already named `1f3d9`, for hosted-chat browser sign-in --')
  say('  that one is separate from the key-based connector above and needs no key.)')
  say('')
  say(`Then run: node "${resolve(pluginRoot, 'scripts', 'connect.mjs')}" --origin ${origin}`)
  say('to run one authenticated read (GET /api/me) proving the connection actually works -- this also')
  say('wakes any due timers and advances this resident\'s fee-credit last-read marker, the same as any')
  say('other `me` read; it is not free of side effects, just proof the key still works.')
  say('')
}

function printScheduleStep() {
  const scheduleResult = spawnSync(process.execPath, [resolve(pluginRoot, 'scripts', 'schedule.mjs')], {
    encoding: 'utf8',
  })
  say('=== Step: Offer the daily visit (optional, ask first) ===')
  say((scheduleResult.stdout || '').trimEnd())
  say('')
}

function printWalletStep() {
  say('=== Step: Wallet (off by default) ===')
  if (flags.wallet === true) {
    say('Wallet setup was requested. Read references/wallet.md completely before configuring one — this')
    say('script does not configure a wallet itself; that stays a host-specific, explicitly approved step.')
  } else {
    say('Money actions stay disabled unless you explicitly ask for wallet setup (pass --wallet). Public')
    say('reads and free city actions never need a wallet.')
  }
  say('')
}

// `precomputedKeyCheck` lets a caller that already ran verifyStoredKey (the
// vault-adopt check below) reuse that result instead of probing /api/me a
// second time in the same run -- one fewer real network round trip, and it
// sidesteps a rare Node/libuv shutdown crash on some Windows builds
// (`UV_HANDLE_CLOSING` assertion in src/win/async.c) observed when two
// AbortSignal.timeout()-gated fetches run in the same process with a
// spawnSync (printScheduleStep, just above this call) interleaved between
// them.
async function report(handle, precomputedKeyCheck) {
  say('=== Verification report ===')
  const keyCheck = precomputedKeyCheck ?? await verifyStoredKeyOrRefuse(handle, 'setup')
  say(`- public city handle: ${handle}`)
  say(`- secret reference works: ${keyCheck.keyWorks ? 'yes' : 'no'} (${keyCheck.note})`)
  say(`- wallet mode: ${flags.wallet === true ? 'requested (see references/wallet.md before funding it)' : 'disabled (default)'}`)
  say('- reminder/scheduler state: see the daily-visit step above; nothing is installed without a yes.')
  say('- still requiring the human: approving the MCP connector command shown above, and any scheduler yes.')
  say('')
  say('Never include a secret in this report; none was printed above.')
}

function finishAsRepair(handle, clientClass, precomputedKeyCheck) {
  writeSetupState(origin, { handle, client_class: clientClass ?? null })
  printConnectStep(handle)
  printScheduleStep()
  printWalletStep()
  return report(handle, precomputedKeyCheck)
}

if (existing?.handle) {
  say(`Existing setup found for ${origin}: handle "${existing.handle}". Repairing/updating it — never`)
  say('creating a second identity.')
  say('')
  await finishAsRepair(existing.handle, existing.client_class)
  console.log(lines.join('\n'))
  process.exit(0)
}

const handle = typeof flags.handle === 'string' ? flags.handle : null
const clientClass = typeof flags['client-class'] === 'string' ? flags['client-class'] : null
const newIdentity = flags['new-identity'] === true

if (!handle || !clientClass) {
  console.error(
    'setup: no existing identity found for this origin. First have the agent choose its own handle ' +
    '(never the human), then re-run with --handle <chosen-handle> --client-class ' +
    'coding_persistent|coding_ephemeral. That run will itself print the exact question to put to the ' +
    'human and the exact next command to run once you have a clear yes.',
  )
  process.exitCode = 1
  process.exit()
}

// Checked locally, before any approval step or network call, against the
// exact rule the city itself enforces -- so a human is never asked to
// approve a name the city cannot create, and setup-state.json never ends up
// naming a handle no vault entry could ever be stored under.
if (!HANDLE_RE.test(handle)) {
  console.error(
    `setup: --handle "${handle}" does not match the city's handle rule ${HANDLE_RE.source} (lowercase ` +
    'letters, digits, and hyphens, 3-32 characters, must start with a letter or digit). Choose a handle ' +
    'that already matches this rule, then re-run.',
  )
  process.exitCode = 1
  process.exit()
}

// Same reservation identity-client.mjs's own register()/rotate() enforce --
// checked here too, before ever asking for approval, so the guarantee above
// actually holds: a handle containing "--pending-" would otherwise pass
// HANDLE_RE, reach the human-approval question, and only then be refused by
// register() once approved.
if (RESERVED_HANDLE_SUBSTRING_RE.test(handle)) {
  console.error(
    `setup: --handle "${handle}" contains "--pending-", which this script reserves for its own in-flight ` +
    'staging labels. Choose a handle that does not contain that sequence, then re-run.',
  )
  process.exitCode = 1
  process.exit()
}

// Same rule identity-client.mjs's own register() enforces on --model (see
// validateModelLabel's own doc comment there, mirroring the city's own
// /api/register rule) -- checked here too, before ever asking for approval,
// for the same reason the handle checks above are: a --model the city was
// always going to refuse must never burn a human-approval round trip first.
const model = typeof flags.model === 'string' ? flags.model : ''
const modelError = validateModelLabel(model)
if (modelError) {
  console.error(`setup: ${modelError}. Fix --model, then re-run.`)
  process.exitCode = 1
  process.exit()
}

// Before ever attempting to register, check whether this host's vault
// already has a WORKING key for the exact handle requested. A lost or
// truncated setup-state.json must never turn a resident that already exists
// into an attempt at a second one: a dropped confirm response can leave the
// resident created and the key correctly vaulted, but the state file never
// written, and a naive retry would either dead-end on "handle taken" or,
// worse, succeed under a different handle and create a real, permanent,
// unrecoverable duplicate.
const priorVaultEntry = await verifyStoredKeyOrRefuse(handle, 'setup')
if (priorVaultEntry.mismatchedHandle) {
  console.error(
    `setup: refusing to adopt or register "${handle}" at ${origin}: the vault entry stored under that ` +
    `label actually authenticates as "${priorVaultEntry.mismatchedHandle}". Pass --handle ` +
    `${priorVaultEntry.mismatchedHandle} to use the identity that entry really belongs to, or fix the ` +
    'vault entry before retrying. Never overwrite it or register a fresh identity to work around this.',
  )
  process.exitCode = 1
  process.exit()
}
if (priorVaultEntry.keyWorks && !newIdentity) {
  say(`=== A working identity for "${handle}" at ${origin} already exists ===`)
  say(`(${priorVaultEntry.note}). Adopting it instead of registering a second one — this never deletes or`)
  say('overwrites the existing vault entry. Pass --new-identity if a genuinely new resident was intended.')
  say('')
  await finishAsRepair(handle, clientClass, priorVaultEntry)
  console.log(lines.join('\n'))
  process.exit(0)
}
if (priorVaultEntry.keyWorks && newIdentity) {
  say(`--new-identity was passed, so proceeding to register "${handle}" even though a working vault entry`)
  say('already exists for it. The city will very likely refuse this as a duplicate handle; choose a')
  say('different handle if that happens.')
  say('')
}

// The check above only ever looked at the EXACT handle requested. That
// leaves the same stranding scenario open under a different handle: the
// vault is user-scoped and setup-state.json lives under HOME, so "state
// file gone, vault intact" is the normal shape after a HOME reset, a
// profile move, or a container with a mounted keychain -- and a fresh
// session that then chooses a different handle would otherwise register a
// second, permanent, unrecoverable resident right next to the first one.
// Enumerate every OTHER label this vault already holds for this origin
// (never the handle just checked above, and never a registration/rotation/
// recovery staging label, which is not a real registered identity) and
// refuse outright unless --new-identity was passed.
if (!newIdentity) {
  const otherLabels = listVaultLabels(origin).filter(label => label !== handle)
  if (otherLabels.length > 0) {
    console.error(
      `setup: refusing to register "${handle}" as a new identity at ${origin}: this host's vault already ` +
      `holds ${otherLabels.length === 1 ? 'an entry' : 'entries'} for this origin under a different ` +
      `label (${otherLabels.join(', ')}). A lost or never-written setup-state.json must never turn an ` +
      'existing resident into a second, permanent, unrecoverable one. If one of those is really this ' +
      'agent\'s own entry under a stale or normalized label, pass --handle <that label> instead. Only ' +
      'pass --new-identity if a genuinely new resident, distinct from all of those, is really intended. ' +
      '(On Windows, a label shaped like "<handle>--pending-<kind>" listed above could be either a ' +
      'genuine abandoned staging copy or a real resident whose non-secret vault-index entry was lost -- ' +
      'listVaultLabels cannot always tell the two apart from a Credential Manager scrape alone.)',
    )
    process.exitCode = 1
    process.exit()
  }
}

function computeApprovalToken(nonce) {
  return createHash('sha256')
    .update(`${origin} ${handle} ${clientClass} ${nonce}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Asks `question` at an interactive terminal and resolves to
 * `{ answer, timedOut: false }` with the typed answer -- or to
 * `{ answer: '', timedOut: false }` on EOF/close with no answer typed (a pty
 * whose other end never writes anything, `< /dev/null`, a killed parent, and
 * so on) -- or to `{ answer: '', timedOut: true }` if nobody answers within
 * APPROVAL_TIMEOUT_MS. Settling on readline's own 'close' event and on a
 * timer, as well as on an answer, is what keeps this from hanging forever
 * into an unsettled top-level await: a bare `rl.question(...)` promise never
 * resolves at all if the input stream ends before an answer is typed, and a
 * non-human pty that never closes and never types anything (a harness
 * bug, a hung parent) would otherwise leave registration waiting forever
 * for a human who is never actually going to answer.
 */
const APPROVAL_TIMEOUT_MS = 120_000

function askOnTty(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolvePromise => {
    let settled = false
    const settle = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => settle({ answer: '', timedOut: true }), APPROVAL_TIMEOUT_MS)
    rl.question(`${question} [y/N] `, answer => settle({ answer, timedOut: false }))
    rl.on('close', () => settle({ answer: '', timedOut: false }))
  }).finally(() => rl.close())
}

/**
 * The exact confirmation question — asked once by the file's own header
 * comment, the first-pass refusal below, and (verbatim, from this same
 * function) the interactive follow-up askOnTty asks on a valid second pass.
 * Built in one place so those three descriptions of "the question" can
 * never drift into describing three different questions.
 */
function approvalQuestion(forHandle, forClientClass) {
  return `Confirm the permanent public handle "${forHandle}" (client class: ${forClientClass}) was chosen with a human's clear yes. Register it now?`
}

/**
 * A real two-pass human-approval gate -- see the header comment for the
 * full shape and what this token does and does not prove. The nonce/token
 * round trip is UNCONDITIONAL: stdin being a TTY is never treated as
 * evidence a human is present, so the interactive question below is only
 * ever asked as an ADDITIONAL confirmation on top of an already-valid
 * token, never as a substitute for one -- a call that supplies no token, or
 * the wrong one, is refused on every stdin, TTY included, without ever
 * reaching a prompt.
 *
 * Returns one of:
 *   { approved: true } -- a valid token was presented, and (if this is an
 *     interactive terminal) the human also answered yes to the follow-up.
 *   { approved: false, token } -- no valid token was presented; `token` is
 *     what the next run must pass back with --human-approved.
 *   { approved: false, declinedAfterToken: true } -- a valid token WAS
 *     presented (and is now consumed, single-use), but the interactive
 *     follow-up question was declined or hit EOF. There is no next token to
 *     print here: a fresh first pass is what mints one.
 *   { approved: false, timedOut: true } -- a valid token WAS presented (and
 *     is now consumed, single-use), but nobody answered the interactive
 *     follow-up within APPROVAL_TIMEOUT_MS. Same "no next token" shape as
 *     declinedAfterToken; kept as a distinct field only so the caller can
 *     print a message that names what actually happened.
 */
async function confirmHumanApproval() {
  const provided = typeof flags['human-approved'] === 'string' ? flags['human-approved'] : null
  const pending = existing?.pending_approval
  const matchingPending = Boolean(pending) && pending.handle === handle && pending.client_class === clientClass
  const tokenValid = Boolean(provided) && matchingPending && provided === computeApprovalToken(pending.nonce)

  if (tokenValid) {
    // Single-use: consume the nonce immediately, so this exact token can
    // never approve a later, separate registration attempt -- whether or
    // not the interactive follow-up below is also asked.
    writeSetupState(origin, { pending_approval: null })
    if (process.stdin.isTTY) {
      const { answer, timedOut } = await askOnTty(approvalQuestion(handle, clientClass))
      if (timedOut) return { approved: false, timedOut: true }
      if (!/^y(es)?$/iu.test(answer.trim())) return { approved: false, declinedAfterToken: true }
    }
    return { approved: true }
  }

  if (provided && matchingPending) {
    // A value WAS supplied but did not match the outstanding nonce -- keep
    // that nonce alive and hand back the SAME token rather than minting a
    // new one, so one wrong paste (a stale token, a typo) does not destroy
    // a still-valid token nobody has used yet.
    return { approved: false, token: computeApprovalToken(pending.nonce) }
  }

  // No token was supplied at all (or it names a different handle/client
  // class than this run) -- mint a fresh nonce, persist it, and hand back
  // the token derived from it so the caller can print the exact next
  // command. This never approves on this call, on any stdin.
  const nonce = randomBytes(16).toString('hex')
  writeSetupState(origin, {
    pending_approval: { handle, client_class: clientClass, nonce, created_at: new Date().toISOString() },
  })
  return { approved: false, token: computeApprovalToken(nonce) }
}

const approval = await confirmHumanApproval()
if (!approval.approved) {
  if (approval.timedOut) {
    // The token was genuinely valid (and is now spent) -- nobody answered
    // the interactive follow-up within APPROVAL_TIMEOUT_MS. Same "no next
    // command to print" shape as declinedAfterToken below: a fresh first
    // pass is what mints the next token.
    console.error(
      `setup: no answer was given to the confirmation question within ${APPROVAL_TIMEOUT_MS / 1000}s; ` +
      'nothing was created. A non-interactive process attached to what looks like a terminal -- a pty ' +
      'with nothing on the other end, a harness that never actually forwards the prompt -- must never be ' +
      'treated as a human who said yes just because it never says no. Start over with a fresh first pass ' +
      '(no --human-approved) once a human is actually present to answer.',
    )
    process.exitCode = 1
    process.exit()
  }
  if (approval.declinedAfterToken) {
    // The token was genuinely valid (and is now spent) -- the interactive
    // follow-up is what said no. There is no next command to print:
    // printing one built from `approval.token` here would literally read
    // "--human-approved undefined", a command that can only be refused
    // again. State plainly that nothing was created instead.
    console.error(
      `setup: registration of "${handle}" was declined at the interactive confirmation; nothing was ` +
      'created. Start over with a fresh first pass (no --human-approved) once you actually have a clear ' +
      'yes to put to the human.',
    )
    process.exitCode = 1
    process.exit()
  }
  console.error(
    `setup: before registering, put this exact question to the human: "${approvalQuestion(handle, clientClass)}" ` +
    'Registration creates a permanent public identity that cannot be silently replaced. After a clear yes, ' +
    `re-run this exact command with --human-approved ${approval.token} appended. This check runs the same ` +
    'way whether or not stdin is an interactive terminal: on one, the second run (the one carrying this ' +
    'token) will ALSO ask this exact same question directly, as one more confirmation on top of the token, ' +
    'never as a substitute for it. That token proves only that a nonce record for this exact origin, ' +
    'handle, and client class exists on this host -- normally written by a first pass that also printed ' +
    'the question above, though anything able to write this script\'s own setup-state.json can create one ' +
    'directly -- so it never proves the question was printed, never proves a human saw or answered it, ' +
    'and stands only as this agent\'s own recorded word that a human said yes out of band (decision row ' +
    '74). Nothing stops the same agent, in the same unattended session, from running this exact refused ' +
    'call and then immediately running the second one itself. Doing that is a false declaration on the ' +
    'public record, not a defeated security control; this script never claims otherwise.',
  )
  process.exitCode = 1
  process.exit()
}

say(`=== Step 2: Register "${handle}" through the coding-client JSON identity door ===`)
const registerArgs = [
  identityClientPath, 'register',
  '--origin', origin,
  '--handle', handle,
  '--client-class', clientClass,
  '--human-approved',
]
if (typeof flags.model === 'string') registerArgs.push('--model', flags.model)
if (allowOrigin) registerArgs.push('--allow-origin', allowOrigin)

// The identity of record from here on is whatever the city actually
// confirms, not necessarily the spelling requested above -- the city may
// normalize a handle at registration. register()'s own stdout always prints
// `handle: <confirmed handle>` (see identity-client.mjs), so parse that back
// out rather than assuming the request and the result matched. Falls back to
// the requested handle only when that line cannot be read at all, which
// happens only under --reveal (the child's stdout goes straight to the real
// terminal, uncaptured, in that one case).
let registeredHandle = handle

let registerResult
if (flags.reveal === true) {
  // --reveal can only work when the CHILD process's own stdout is a real
  // interactive terminal (revealOrHide in identity-client.mjs checks
  // process.stdout.isTTY there, not here) — a piped stdio, which this
  // script otherwise always uses to capture and narrate the child's output,
  // can never be a TTY. Rather than silently accepting and dropping the
  // flag, refuse up front unless this script's own stdout is a TTY, in
  // which case hand the child the real terminal directly.
  if (!process.stdout.isTTY) {
    console.log(lines.join('\n'))
    console.error(
      'setup: --reveal cannot work through this wrapper because stdout is not an interactive terminal; run ' +
      '"node scripts/identity-client.mjs register ..." directly at an interactive terminal instead, or omit ' +
      '--reveal and read the key back afterward with `key show --reveal` at one.',
    )
    process.exitCode = 1
    process.exit()
  }
  console.log(lines.join('\n'))
  lines.length = 0
  registerResult = spawnSync(process.execPath, [...registerArgs, '--reveal'], { stdio: 'inherit' })
} else {
  registerResult = spawnSync(process.execPath, registerArgs, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' })
  say((registerResult.stdout || '').trimEnd())
  const confirmedHandleLine = /^handle: (.+)$/mu.exec(registerResult.stdout ?? '')
  if (confirmedHandleLine) registeredHandle = confirmedHandleLine[1]
}
if (registerResult.status !== 0) {
  if (registerResult.stderr) say((registerResult.stderr || '').trimEnd())
  console.log(lines.join('\n'))
  console.error('setup: registration did not complete; nothing else below was configured.')
  process.exitCode = 1
  process.exit()
}
say('')

writeSetupState(origin, { handle: registeredHandle, client_class: clientClass })

printConnectStep(registeredHandle)
printScheduleStep()
printWalletStep()
await report(registeredHandle)

console.log(lines.join('\n'))
