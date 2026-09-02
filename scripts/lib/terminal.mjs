// Cross-platform "open a new terminal window running this script" helper.
//
// There is no reliable way to ask an OS in advance "do you have a real,
// human-visible terminal I can open a window on?" from inside a script that
// may itself be running headlessly (a cloud sandbox, a container, a phone
// session). So this module does not guess: it tries the platform's normal
// terminal launcher and treats a fast failure (the launcher binary is
// missing, or the child process errors immediately) as "no real terminal
// here" and lets the caller fall back to printing the feed once inline.
//
// process.platform: 'win32' | 'darwin' | everything else treated as Linux/BSD.

import { spawn } from 'node:child_process'

const PROBE_WINDOW_MS = 900

/** Resolves once the launcher either looks like it started, or definitely failed. */
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
    // A launcher that is still alive after a short probe window is assumed to
    // have opened its window; we then detach and let it run independently.
    const timer = setTimeout(() => {
      child.unref()
      settle({ opened: true })
    }, PROBE_WINDOW_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      // Some launchers (wt.exe, open -a) exit 0 immediately after handing
      // off to the real window; that is success, not failure.
      settle(code === 0 ? { opened: true } : { opened: false, reason: `exited with code ${code}` })
    })
  })

/**
 * Open a new terminal window running `node <scriptPath> <args...>`.
 * Returns { opened: boolean, reason?: string }.
 */
export const openTerminalRunning = async (scriptPath, args = []) => {
  const nodeArgs = [scriptPath, ...args]

  if (process.platform === 'win32') {
    const wtArgs = ['new-tab', '--title', '1F3D9', 'node', ...nodeArgs]
    const wt = await trySpawn('wt.exe', wtArgs)
    if (wt.opened) return wt
    const psCommand = `node ${[scriptPath, ...args].map((a) => `"${String(a).replaceAll('"', '\\"')}"`).join(' ')}`
    return trySpawn('powershell.exe', ['-NoExit', '-Command', psCommand])
  }

  if (process.platform === 'darwin') {
    const escaped = ['node', ...nodeArgs].map((a) => String(a).replaceAll('\\', '\\\\').replaceAll('"', '\\"')).join(' ')
    const script = `tell application "Terminal" to do script "${escaped}"`
    return trySpawn('osascript', ['-e', script])
  }

  // Linux and other Unix-likes: try common emulators in rough popularity order.
  const linuxEmulators = [
    ['x-terminal-emulator', ['-e', 'node', ...nodeArgs]],
    ['gnome-terminal', ['--', 'node', ...nodeArgs]],
    ['konsole', ['-e', 'node', ...nodeArgs]],
    ['xfce4-terminal', ['-x', 'node', ...nodeArgs]],
    ['xterm', ['-e', 'node', ...nodeArgs]],
  ]
  for (const [command, args_] of linuxEmulators) {
    const result = await trySpawn(command, args_)
    if (result.opened) return result
  }
  return { opened: false, reason: 'no terminal emulator found on PATH' }
}
