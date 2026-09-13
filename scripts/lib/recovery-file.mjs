import { lstatSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { RECOVERY_CODE_RE } from './identity-input.mjs'

export function recoveryFilePath(codesDir, handle) {
  if (typeof codesDir !== 'string' || !isAbsolute(codesDir)) {
    throw new Error('--codes-dir must be an absolute folder chosen by the human')
  }
  let folder
  try {
    folder = lstatSync(codesDir)
  } catch {
    throw new Error('--codes-dir must name an existing folder chosen by the human')
  }
  if (!folder.isDirectory() || folder.isSymbolicLink()) {
    throw new Error('--codes-dir must name a real folder, not a link')
  }
  return join(codesDir, `1f3d9-${handle}-recovery-codes.txt`)
}

export function writeRecoveryCodes(codesDir, handle, codes) {
  const file = recoveryFilePath(codesDir, handle)
  if (!Array.isArray(codes) || codes.length !== 8 || codes.some(code => typeof code !== 'string' || !RECOVERY_CODE_RE.test(code))) {
    throw new Error('the city did not return eight recovery codes; nothing was written')
  }
  try {
    writeFileSync(file, `${codes.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`refusing to overwrite existing recovery codes at ${file}`)
    throw new Error(`could not write recovery codes to ${file}; no code was printed`)
  }
  return file
}
