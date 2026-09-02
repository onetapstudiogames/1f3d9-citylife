// Cross-platform "open a new, human-visible terminal window running this
// script" helper.
//
// There is no reliable way to ask an OS in advance "do you have a real,
// human-visible terminal I can open a window on?" from inside a script that
// may itself be running headlessly (a cloud sandbox, a container, a phone
// session). So this module does not guess: it tries the platform's normal
// terminal launcher and treats a spawn failure (the launcher binary is
// missing, or the child process errors or exits non-zero) as "no real
// terminal here" and lets the caller fall back to printing the feed once
// inline.
//
// It also does not guess whether a window actually appeared on screen —
// Node has no way to observe that. Once the launcher process itself starts
// (or hands off cleanly), the caller is told the exact command that was run
// and its PID, and that a window "should have appeared" — never a false
// claim that it definitely did.
//
// process.platform: 'win32' | 'darwin' | everything else treated as Linux/BSD.

import { spawn } from 'node:child_process'

/** Quote one argument for embedding inside a manually-built shell command string. */
const quoteArg = (arg) => `"${String(arg).replaceAll('"', '\\"')}"`

const describeCommand = (command, args) => [command, ...args.map((a) => (/\s/u.test(String(a)) ? quoteArg(a) : String(a)))].join(' ')

/**
 * Spawns `command` detached and resolves as soon as the outcome is actually
 * known — never on a timed guess:
 *  - a synchronous spawn failure (bad binary, permission error) throws and
 *    is caught immediately;
 *  - an asynchronous spawn failure (ENOENT resolved by libuv, missing
 *    binary on PATH) arrives as an 'error' event, always before Node's next
 *    macrotask;
 *  - a launcher that exits with code 0 handed off successfully (`wt.exe`,
 *    `cmd /c start`, and macOS `open -a`/`osascript` all exit 0 right after
 *    opening the real window — that is success, not failure); a non-zero
 *    exit is a genuine failure;
 *  - a launcher that is still running with no error once we reach the next
 *    macrotask (a long-lived terminal emulator such as `xterm`) is treated
 *    as opened, using its real PID.
 */
const trySpawn = (command, args, options = {}) =>
  new Promise((resolvePromise) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    let child
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        ...options,
      })
    } catch (error) {
      settle({ opened: false, reason: error?.message || String(error) })
      return
    }
    child.once('error', (error) => settle({ opened: false, reason: error?.message || String(error) }))
    child.once('exit', (code) => {
      settle(code === 0 || code === null ? { opened: true, pid: child.pid } : { opened: false, reason: `exited with code ${code}` })
    })
    setImmediate(() => {
      if (settled) return
      const { pid } = child
      child.unref()
      settle({ opened: true, pid })
    })
  })

const attempt = async (command, args) => {
  const result = await trySpawn(command, args)
  return { ...result, commandLine: describeCommand(command, args) }
}

/**
 * Open a new, visible terminal window running `node <scriptPath> <args...>`.
 *
 * Returns one of:
 *   { opened: true, commandLine, pid }
 *   { opened: false, commandLine, reason }
 *
 * `opened: true` means the launcher process itself started (or handed off)
 * successfully; it is not proof a window is on screen, only that nothing
 * about the launch itself failed.
 */
export const openTerminalRunning = async (scriptPath, args = [], { title = '1F3D9 live' } = {}) => {
  const nodeArgs = [scriptPath, ...args]

  if (process.platform === 'win32') {
    const wtArgs = ['new-tab', '--title', title, 'node', ...nodeArgs]
    const wt = await attempt('wt.exe', wtArgs)
    if (wt.opened) return wt

    // No Windows Terminal on PATH (or it failed to start): fall back to a
    // plain, visible console window via the shell's own `start`, which is
    // what actually creates a new, visible window. Spawning powershell.exe
    // directly here (no `start`) would instead attach it to no console at
    // all — an invisible, orphaned process, not a window the human can see.
    //
    // The inner command is passed to PowerShell as base64-encoded UTF-16LE
    // (`-EncodedCommand`) rather than a quoted `-Command` string: that is
    // what actually "quotes paths with spaces" correctly through two layers
    // of argument parsing (Node's own Windows quoting for the outer
    // `cmd.exe` call, then cmd's `start`), instead of hoping nested quote
    // escaping survives both.
    const psScript = `node ${nodeArgs.map(quoteArg).join(' ')}`
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64')
    const cmdArgs = ['/c', 'start', title, 'powershell', '-NoExit', '-EncodedCommand', encodedCommand]
    const fallback = await trySpawn('cmd.exe', cmdArgs)
    const readableCommandLine = `cmd.exe /c start ${quoteArg(title)} powershell -NoExit -Command ${quoteArg(psScript)}`
    if (fallback.opened) return { ...fallback, commandLine: readableCommandLine }
    return { opened: false, commandLine: readableCommandLine, reason: `wt.exe: ${wt.reason}; cmd.exe start powershell: ${fallback.reason}` }
  }

  if (process.platform === 'darwin') {
    const escaped = ['node', ...nodeArgs].map((a) => String(a).replaceAll('\\', '\\\\').replaceAll('"', '\\"')).join(' ')
    const script = `tell application "Terminal" to do script "${escaped}"`
    return attempt('osascript', ['-e', script])
  }

  // Linux and other Unix-likes: try common emulators in rough popularity order.
  const linuxEmulators = [
    ['x-terminal-emulator', ['-e', 'node', ...nodeArgs]],
    ['gnome-terminal', ['--', 'node', ...nodeArgs]],
    ['konsole', ['-e', 'node', ...nodeArgs]],
    ['xfce4-terminal', ['-x', 'node', ...nodeArgs]],
    ['xterm', ['-e', 'node', ...nodeArgs]],
  ]
  const reasons = []
  for (const [command, emulatorArgs] of linuxEmulators) {
    const result = await attempt(command, emulatorArgs)
    if (result.opened) return result
    reasons.push(`${command}: ${result.reason}`)
  }
  return { opened: false, commandLine: describeCommand('node', nodeArgs), reason: `no terminal emulator found on PATH (${reasons.join('; ')})` }
}
