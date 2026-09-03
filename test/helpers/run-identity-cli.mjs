// Shared plumbing for driving setup.mjs / connect.mjs / key.mjs /
// identity-client.mjs as real subprocesses against a stub city server and a
// throwaway per-test HOME, so these tests exercise the actual vault code
// path (Windows Credential Manager, via the PowerShell CredWrite/CredRead
// shim, on win32; the plain-file backend on POSIX runners) instead of a
// mock of it.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Creates a fresh throwaway "home" directory and returns the env overlay
 * that makes os.homedir() resolve to it on whichever platform the test is
 * actually running on -- HOME on POSIX, USERPROFILE (Node's own choice) on
 * win32 -- plus a cleanup function. Setting both unconditionally is
 * harmless: Node only reads the one its platform actually uses.
 */
export function makeTempHome(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    env: { HOME: dir, USERPROFILE: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * The base environment every child gets, BEFORE the caller's `env` overlay:
 * only what a bare `node` invocation actually needs to run and (on win32)
 * to find and invoke `powershell.exe`/`cmdkey` -- never the full parent
 * process.env. This is what keeps a developer's own real
 * AGENT_1F3D9_SECRET or IDENTITY_ORIGIN, exported while working in this
 * shell, from silently reaching the identity client under test: neither
 * name appears here, so a child only ever sees them if a test's own `env`
 * overlay explicitly adds them.
 *
 * AGENT_1F3D9_STUB_ONLY=1 is set here by default: this makes every child
 * refuse any --origin that is not
 * localhost/127.0.0.1 (see scripts/lib/origin-guard.mjs), with no
 * --allow-origin exception, so a test that drives these scripts can never
 * reach the real city even by a typo or a copy-paste mistake. The handful
 * of tests in test/identity-commands.test.mjs that deliberately drive a
 * script against a fake, non-real https://example.invalid origin (to test
 * behavior unrelated to the origin guard itself -- flag parsing, printed
 * output shape, refusal wording) explicitly override this back to '0' in
 * their own `env`, with a comment explaining why: that origin can never
 * resolve to anything (reserved by RFC 2606) and is not the real city
 * either way, so the stricter guard is not needed there and would only
 * mask the behavior actually under test.
 */
function minimalBaseEnv() {
  const base = { PATH: process.env.PATH, AGENT_1F3D9_STUB_ONLY: '1' }
  if (process.platform === 'win32') {
    base.SystemRoot = process.env.SystemRoot
    base.ComSpec = process.env.ComSpec
    base.PATHEXT = process.env.PATHEXT
  } else {
    base.TMPDIR = process.env.TMPDIR
  }
  return base
}

/**
 * Runs `node <scriptPath> <args...>` as a real, ASYNCHRONOUS subprocess and
 * resolves with { status, stdout, stderr } once it exits.
 *
 * This must stay async (spawn, never spawnSync): several of these tests run
 * a stub HTTPS server in this same test process's event loop
 * (test/helpers/stub-city-server.mjs), and a synchronous spawnSync blocks
 * that entire event loop -- including the stub server -- for as long as the
 * child runs. A child that then tries to fetch from the stub server hangs
 * until its own request times out, because the parent process can never get
 * a turn to accept the connection and answer it. Using spawn (which yields
 * to the event loop while the child runs) is what lets the in-process stub
 * server actually respond.
 *
 * `env` is merged over `minimalBaseEnv()` above (not the full parent
 * process.env) so neither a test's fake HOME/USERPROFILE nor its absence of
 * AGENT_1F3D9_SECRET/IDENTITY_ORIGIN can be shadowed by the real ones this
 * test-runner process happens to have. NODE_TLS_REJECT_UNAUTHORIZED=0 is
 * always set: every test here talks only to a stub server it started
 * itself, on 127.0.0.1/localhost, with a throwaway self-signed fixture cert
 * -- never a real host -- so trusting that cert is safe and deliberate, not
 * a production relaxation.
 */
export function runNode(scriptPath, args, { input, env = {}, stdio } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: stdio ?? (input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']),
      env: {
        ...minimalBaseEnv(),
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk })
    if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', status => resolvePromise({ status, stdout, stderr }))
    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}
