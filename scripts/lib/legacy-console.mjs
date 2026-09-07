import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

export const LEGACY_CONSOLE_MODE = 'ONEF3D9_LEGACY_CONSOLE_MODE'
export const LEGACY_CONSOLE_MESSAGE = 'This console cannot show the drawn view.'

const PAYLOAD_ENV = 'ONEF3D9_LEGACY_CONSOLE_PAYLOAD'

// The source is constant. Executable paths and public arguments cross the
// PowerShell boundary only as base64-encoded JSON in the child environment.
const POWERSHELL_SOURCE = String.raw`
$oldErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
$consoleHandle = [IntPtr]::Zero
$originalMode = [uint32]0
$originalInputCodePage = [uint32]0
$originalOutputCodePage = [uint32]0
$modeWasRead = $false
$inputCodePageChanged = $false
$outputCodePageChanged = $false
$payload = $null
$exitCode = 1
$vtEnabled = $false

try {
  $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ONEF3D9_LEGACY_CONSOLE_PAYLOAD))
  $payload = ConvertFrom-Json -InputObject $payloadJson
  $env:ONEF3D9_LEGACY_CONSOLE_PAYLOAD = $null

  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OneF3D9Console {
  public const UInt32 GENERIC_READ = 0x80000000;
  public const UInt32 GENERIC_WRITE = 0x40000000;
  public const UInt32 FILE_SHARE_READ = 0x00000001;
  public const UInt32 FILE_SHARE_WRITE = 0x00000002;
  public const UInt32 OPEN_EXISTING = 3;
  public const UInt32 ENABLE_PROCESSED_OUTPUT = 0x0001;
  public const UInt32 ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(string name, UInt32 access, UInt32 share, IntPtr security, UInt32 creation, UInt32 flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetConsoleMode(IntPtr handle, out UInt32 mode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleMode(IntPtr handle, UInt32 mode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 GetConsoleCP();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleCP(UInt32 codePage);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 GetConsoleOutputCP();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleOutputCP(UInt32 codePage);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@ | Out-Null

    $originalInputCodePage = [OneF3D9Console]::GetConsoleCP()
    $originalOutputCodePage = [OneF3D9Console]::GetConsoleOutputCP()
    $consoleHandle = [OneF3D9Console]::CreateFileW(
      'CONOUT$',
      [OneF3D9Console]::GENERIC_READ -bor [OneF3D9Console]::GENERIC_WRITE,
      [OneF3D9Console]::FILE_SHARE_READ -bor [OneF3D9Console]::FILE_SHARE_WRITE,
      [IntPtr]::Zero,
      [OneF3D9Console]::OPEN_EXISTING,
      0,
      [IntPtr]::Zero
    )

    $validHandle = $consoleHandle -ne [IntPtr]::Zero -and $consoleHandle -ne [IntPtr](-1)
    if ($validHandle -and $originalInputCodePage -ne 0 -and $originalOutputCodePage -ne 0) {
      $inputCodePageChanged = [OneF3D9Console]::SetConsoleCP(65001)
      $outputCodePageChanged = [OneF3D9Console]::SetConsoleOutputCP(65001)
      $modeWasRead = [OneF3D9Console]::GetConsoleMode($consoleHandle, [ref]$originalMode)
      if ($inputCodePageChanged -and $outputCodePageChanged -and $modeWasRead) {
        $wantedMode = $originalMode -bor [OneF3D9Console]::ENABLE_PROCESSED_OUTPUT -bor [OneF3D9Console]::ENABLE_VIRTUAL_TERMINAL_PROCESSING
        $vtEnabled = [OneF3D9Console]::SetConsoleMode($consoleHandle, $wantedMode)
      }
    }
  } catch {
    $vtEnabled = $false
  }

  if ($vtEnabled) { $env:ONEF3D9_LEGACY_CONSOLE_MODE = 'ansi' }
  else { $env:ONEF3D9_LEGACY_CONSOLE_MODE = 'plain' }

  $executable = [string]$payload.executable
  $childArgs = @($payload.argv | ForEach-Object { [string]$_ })
  & $executable @childArgs
  $exitCode = $LASTEXITCODE
} catch {
  $exitCode = 1
} finally {
  if ($modeWasRead -and $consoleHandle -ne [IntPtr]::Zero -and $consoleHandle -ne [IntPtr](-1)) {
    [void][OneF3D9Console]::SetConsoleMode($consoleHandle, $originalMode)
  }
  if ($inputCodePageChanged) { [void][OneF3D9Console]::SetConsoleCP($originalInputCodePage) }
  if ($outputCodePageChanged) { [void][OneF3D9Console]::SetConsoleOutputCP($originalOutputCodePage) }
  if ($consoleHandle -ne [IntPtr]::Zero -and $consoleHandle -ne [IntPtr](-1)) {
    [void][OneF3D9Console]::CloseHandle($consoleHandle)
  }
  $env:ONEF3D9_LEGACY_CONSOLE_PAYLOAD = $null
  $env:ONEF3D9_LEGACY_CONSOLE_MODE = $null
  $ErrorActionPreference = $oldErrorActionPreference
}

if ($null -eq $payload -or -not [bool]$payload.keepOpen) { exit $exitCode }
`

const powershellPath = (env) => win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export const buildLegacyConsoleLaunch = ({
  executable = process.execPath,
  argv = process.argv.slice(1),
  keepOpen = false,
  env = process.env,
} = {}) => {
  const payload = Buffer.from(JSON.stringify({
    executable: String(executable),
    argv: argv.map(value => String(value)),
    keepOpen: Boolean(keepOpen),
  }), 'utf8').toString('base64')
  const childEnv = { ...env, [PAYLOAD_ENV]: payload }
  delete childEnv[LEGACY_CONSOLE_MODE]
  return {
    command: powershellPath(env),
    args: [
      '-NoLogo',
      '-NoProfile',
      ...(keepOpen ? ['-NoExit'] : ['-NonInteractive']),
      '-EncodedCommand',
      Buffer.from(POWERSHELL_SOURCE, 'utf16le').toString('base64'),
    ],
    options: { detached: false, stdio: 'inherit', windowsHide: false, env: childEnv },
  }
}

const runChild = (launch, spawnImpl) => new Promise((resolve) => {
  let child
  try {
    child = spawnImpl(launch.command, launch.args, launch.options)
  } catch {
    resolve(null)
    return
  }
  let settled = false
  const settle = (value) => {
    if (settled) return
    settled = true
    resolve(value)
  }
  child.once('error', () => settle(null))
  child.once('exit', (code) => settle(Number.isInteger(code) ? code : 1))
})

/**
 * Prepare an interactive view for classic Windows Console Host.
 *
 * `relaunched` means the caller must return without drawing. `plain` means the
 * caller must print `message` and one plain frame, without constructing a
 * TerminalScreen. `ansi` may enter the normal screen path.
 */
export const prepareLegacyConsole = async ({
  platform = process.platform,
  isTTY = process.stdout.isTTY,
  env = process.env,
  executable = process.execPath,
  argv = process.argv.slice(1),
  spawnImpl = spawn,
} = {}) => {
  if (platform !== 'win32' || !isTTY) return { mode: 'ansi', legacy: false, relaunched: false }

  if (env[LEGACY_CONSOLE_MODE] === 'ansi') {
    return { mode: 'ansi', legacy: true, relaunched: false, synchronized: false }
  }
  if (env[LEGACY_CONSOLE_MODE] === 'plain') {
    return { mode: 'plain', legacy: true, relaunched: false, synchronized: false, message: LEGACY_CONSOLE_MESSAGE }
  }
  if (env.WT_SESSION) return { mode: 'ansi', legacy: false, relaunched: false }

  const exitCode = await runChild(buildLegacyConsoleLaunch({ executable, argv, keepOpen: false, env }), spawnImpl)
  if (exitCode === null) {
    return { mode: 'plain', legacy: true, relaunched: false, synchronized: false, message: LEGACY_CONSOLE_MESSAGE }
  }
  return { mode: 'relaunched', legacy: true, relaunched: true, synchronized: false, exitCode }
}
