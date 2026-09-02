import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/lib/paths.mjs -> repo root is two directories up.
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const readInstalledVersion = async () => {
  try {
    const raw = await readFile(resolve(pluginRoot, 'plugin.json'), 'utf8')
    const manifest = JSON.parse(raw)
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

export const readChangelog = async () => {
  try {
    return await readFile(resolve(pluginRoot, 'CHANGELOG.md'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * A skill folder never stores keys or user settings; this only scans for
 * accidental leftovers so `update` can honestly refuse rather than silently
 * overwrite something the human put in the wrong place. It is a best-effort
 * safety net, not a secret scanner.
 */
export const findSuspiciousLocalFiles = async () => {
  const { readdir } = await import('node:fs/promises')
  const suspiciousNames = /^(\.env(\..*)?|.*\.key|.*secret.*|.*credential.*|env\.txt)$/iu
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (suspiciousNames.test(entry.name)) {
        found.push(full)
      }
    }
  }
  await walk(pluginRoot, 0)
  return found
}
