import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { assertAllowedOrigin, DEFAULT_ORIGIN } from './origin-guard.mjs'

const ROOT_KEY_RE = /^1f3d9_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE_RE = /^1f3d9_rc_[0-9a-f]{64}$/u

// The city's own handle rule (matches the browser join door's validation,
// which the front door states the JSON doors "mirror" in limit, name rule,
// and refusal). Checked locally, before ever putting a handle in front of a
// human for approval, so a human is never asked to approve a name the city
// cannot create -- and so the label this script stores the vault entry
// under is never assumed to equal the requested spelling (the city may
// still normalize it further; see register() below, which always trusts
// the server's own answer as the identity of record, not this local check).
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/u

// Reserved so a real resident's handle can never collide with this script's
// OWN staging-label namespace (pendingLabel below stages an in-flight
// registration/rotation/recovery under `<handle>--pending-<kind>` or, for
// registration, `<handle>--pending-registration-<hex>`). HANDLE_RE alone
// permits this sequence -- it allows consecutive hyphens and imposes no
// reserved-suffix rule -- so without this separate check a handle like
// "agent--pending-rotation" would be a legal registration that then reads,
// to every consumer of listVaultLabels/isPendingLabel below, as an
// abandoned staging entry rather than a real identity: it would be silently
// filtered out of setup.mjs's duplicate-identity guard, which exists
// specifically to stop a second, permanent, unrecoverable resident from
// being registered next to one that already exists. Checked at every point
// a handle is validated in this file (both the requested spelling and the
// city's own confirmed spelling), so the reservation holds regardless of
// what the city itself would otherwise accept.
const RESERVED_HANDLE_SUBSTRING_RE = /--pending-/u

// Mirrors the city's own /api/register model-label validation (see
// src/identity-api.ts's optionalPublicTextField, which calls src/input.ts's
// publicText({ maximumCharacters: 120, allowEmpty: true }) -- the same
// UNSAFE_PUBLIC_TEXT character class that function tests against): the same
// 120-code-point ceiling (counted the same way, by code point via
// Array.from, not UTF-16 code unit, so a surrogate pair counts once), and
// the same rejection of ASCII/Unicode control characters and bidi-override
// marks. Checked locally, before ever spending setup.mjs's two-pass
// human-approval round trip on a --model the door was always going to
// refuse -- a --model the city was always going to reject would otherwise
// burn that round trip for nothing (a fresh --human-approved token would be
// required to try again). This is NOT a byte-for-byte port of publicText:
// the server additionally rejects malformed/mojibake UTF-8 sequences and
// credential-shaped text (src/input.ts's containsMalformedPublicText and
// containsCredentialLikeInput); those stay checks of last resort that only
// the server itself runs, and the city's own refusal remains authoritative
// regardless of what this local check lets through.
const MODEL_MAX_CODE_POINTS = 120
const UNSAFE_MODEL_TEXT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u

/** Returns an error message string if `model` fails the city's own rule, or null if it is fine. */
function validateModelLabel(model) {
  if (!model) return null
  if (Array.from(model).length > MODEL_MAX_CODE_POINTS) {
    return `--model must be at most ${MODEL_MAX_CODE_POINTS} characters (counted by code point), matching ` +
      `the city's own /api/register limit`
  }
  if (UNSAFE_MODEL_TEXT_RE.test(model)) {
    return `--model must not contain control characters or bidi-override marks, matching the city's own ` +
      '/api/register rule'
  }
  return null
}

// The one legal (letter-first) environment variable name used everywhere a
// resident key is read from the host's own secret store -- by the printed
// `claude mcp add` / `codex mcp add` commands (scripts/connect.mjs,
// scripts/setup.mjs) and by this script's own rotate/recover/pair fallback
// below. A single consistent name means a caller exports it once. Every
// env-var name this repo prints or reads must match
// /^[A-Za-z_][A-Za-z0-9_]*$/ -- `1F3D9_...` forms do not, because POSIX
// shells refuse `export NAME=value` (and `${NAME}` expansion) when NAME
// starts with a digit.
const AGENT_SECRET_ENV_VAR = 'AGENT_1F3D9_SECRET'

function fail(message) {
  console.error(`identity-client: ${message}`)
  process.exitCode = 1
  return null
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      // `--name=value` is parsed as a single token so a caller cannot defeat
      // the bare-secret-flag refusal below by writing --resident-key=...
      // instead of --resident-key ... (both still land in shell history and
      // process listings the exact same way).
      const equalsIndex = body.indexOf('=')
      if (equalsIndex !== -1) {
        flags[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1)
        continue
      }
      const name = body
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        index += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function originOf(flags) {
  const raw = flags.origin ?? process.env.IDENTITY_ORIGIN ?? DEFAULT_ORIGIN
  const trimmed = raw.replace(/\/+$/u, '')
  const allowOrigin = typeof flags['allow-origin'] === 'string' ? flags['allow-origin'] : undefined
  return assertAllowedOrigin(trimmed, { allowOrigin })
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
    return /^y(es)?$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

// --- Secret input: argv is refused, a file path or stdin is required ------

// argv-flag name -> the -file flag that must supply it instead. Both values
// here can authenticate a request or consume a one-use credential, so
// neither may ever be a bare argv flag.
const SECRET_ARGV_FLAGS = {
  'resident-key': 'resident-key-file',
  'recovery-code': 'recovery-code-file',
}

async function readStdinText() {
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function readSecretFromPathOrStdin(source) {
  const raw = source === '-' ? await readStdinText() : readFileSync(source, 'utf8')
  const value = raw.trim()
  if (!value) throw new Error(`no value read from ${source === '-' ? 'stdin' : source}`)
  return value
}

/**
 * Refuses --resident-key or --recovery-code as a bare flag and resolves the
 * matching --*-file flag (a path, or `-` for stdin) into the plain secret
 * value the caller below expects. Falls back to the given environment
 * variables only when neither argv form is present -- an environment
 * variable is not visible in a process listing the way argv is, so it stays
 * allowed as before.
 */
async function resolveSecretArg(flags, bareName, envNames = []) {
  const fileName = SECRET_ARGV_FLAGS[bareName]
  if (bareName in flags) {
    throw new Error(
      `--${bareName} is refused as a bare flag (this also catches --${bareName}=VALUE): it would land ` +
      `in shell history and process listings. If you just typed it either way, treat that value as ` +
      `exposed now and rotate it. Use --${fileName} <path> (or --${fileName} - to read one value from ` +
      'stdin) instead.',
    )
  }
  if (fileName in flags) {
    const source = flags[fileName]
    if (typeof source !== 'string') throw new Error(`--${fileName} requires a path or -`)
    return readSecretFromPathOrStdin(source)
  }
  for (const envName of envNames) {
    if (process.env[envName]) return process.env[envName]
  }
  return null
}

// --- Secret output: hidden unless the caller opts in at a real TTY --------

/**
 * The pure predicate revealOrHide below is built on -- exported separately
 * so a test can exercise all four combinations of (reveal flag) x (TTY)
 * directly, without needing to fork a subprocess whose own stdout can never
 * be a real TTY either way (which is exactly why the naive version of that
 * test could not actually reach or fail on the reveal branch at all).
 */
function shouldReveal(flags, isTty) {
  return flags.reveal === true && isTty === true
}

/**
 * Prints `values` only when the caller passed --reveal AND stdout is an
 * interactive TTY (never a pipe, redirect, or captured subprocess output --
 * exactly where a secret could land in a log or another program's memory).
 * Otherwise prints only a pointer to where the value already went.
 */
function revealOrHide(flags, label, values) {
  if (shouldReveal(flags, process.stdout.isTTY)) {
    console.log(`${label} (shown once):`)
    for (const value of values) console.log(value)
    return
  }
  console.log(
    `${label}: not printed to the terminal (pass --reveal at an interactive TTY to see it ` +
    'once); read it back from storage instead.',
  )
}

export {
  ROOT_KEY_RE, RECOVERY_CODE_RE, HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, AGENT_SECRET_ENV_VAR,
  validateModelLabel, fail, parseArgs, requireFlag, originOf, askYesNo, resolveSecretArg,
  shouldReveal, revealOrHide,
}
