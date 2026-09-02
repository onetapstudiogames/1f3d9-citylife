#!/usr/bin/env node
// `update` — checks this skill repo for a newer version, prints the
// changelog entries between installed and current in plain words, asks
// "install?", then runs the host's own plugin update. Before touching
// anything it verifies that keys and custom settings live outside the skill
// folder (they do by design) and refuses otherwise.

import { spawnSync } from 'node:child_process'
import { readInstalledVersion, findSuspiciousLocalFiles } from './lib/paths.mjs'
import { fetchTextSafe } from './lib/net.mjs'
import { compareVersions } from './lib/semver.mjs'
import { parseChangelogEntries } from './lib/changelog.mjs'

const REPO_RAW = 'https://raw.githubusercontent.com/onetapstudiogames/1f3d9-citylife/main'
const confirmed = process.argv.includes('--confirm')

const runHostUpdate = (command, args) => {
  console.log(`Running: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) return { ran: false, reason: result.error.message }
  if (result.status !== 0) return { ran: false, reason: (result.stderr || result.stdout || `exit ${result.status}`).trim() }
  console.log(result.stdout.trim())
  return { ran: true }
}

console.log('Checking the skill repository for a newer version (public, read-only GitHub raw content) ...')

const installedVersion = await readInstalledVersion()

if (!installedVersion) {
  console.error("Could not read the installed version from this plugin's own plugin.json. The install may be damaged.")
  process.exitCode = 1
} else {
  const [remoteManifest, remoteChangelog] = await Promise.all([
    fetchTextSafe(`${REPO_RAW}/plugin.json`),
    fetchTextSafe(`${REPO_RAW}/CHANGELOG.md`),
  ])

  if (!remoteManifest.ok) {
    console.log(`Could not reach the repository (${remoteManifest.error}). Installed version stays ${installedVersion}.`)
  } else {
    let remoteVersion = null
    try {
      remoteVersion = JSON.parse(remoteManifest.data).version
    } catch {
      console.log("The repository's plugin.json was not valid JSON; cannot compare versions right now.")
    }

    if (remoteVersion) {
      const comparison = compareVersions(installedVersion, remoteVersion)
      if (comparison === null) {
        console.log(`Could not compare versions "${installedVersion}" and "${remoteVersion}".`)
      } else if (comparison >= 0) {
        console.log(`You're already on the latest version (${installedVersion}).`)
      } else {
        console.log('')
        console.log(`A newer version is available: ${installedVersion} -> ${remoteVersion}.`)
        console.log('')

        if (remoteChangelog.ok) {
          const entries = parseChangelogEntries(remoteChangelog.data)
            .filter((entry) => (compareVersions(entry.version, installedVersion) ?? -1) > 0)
          if (entries.length) {
            console.log('What changed since your installed version, in plain words:')
            for (const entry of entries) {
              console.log('')
              console.log(`  ${entry.version}:`)
              for (const bullet of entry.bullets) console.log(`    - ${bullet}`)
            }
            console.log('')
          }
        }

        if (!confirmed) {
          console.log('install? — ask the human for a clear yes before re-running this command with --confirm.')
          console.log('')
          console.log(`One line: a newer version (${remoteVersion}) is available; get the human's yes, then run \`update\` again with --confirm.`)
        } else {
          console.log('Checking that no key or custom setting lives inside this skill folder before touching anything ...')
          const suspicious = await findSuspiciousLocalFiles()
          if (suspicious.length) {
            console.log('Refusing to update: found file(s) inside the skill folder that look like a key or a setting, which should never live here:')
            for (const file of suspicious) console.log(`  ${file}`)
            console.log('')
            console.log('One line: move those file(s) out of the skill folder yourself, then run `update --confirm` again.')
            process.exitCode = 1
          } else {
            console.log('Confirmed: nothing but skill content lives in this folder.')
            console.log('')

            let outcome = { ran: false, reason: 'no known host plugin CLI was found on PATH' }
            if (spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0) {
              const marketplace = runHostUpdate('claude', ['plugin', 'marketplace', 'update', '1f3d9-citylife'])
              outcome = marketplace.ran ? runHostUpdate('claude', ['plugin', 'update', '1f3d9-citylife']) : marketplace
            } else if (spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0) {
              const marketplace = runHostUpdate('codex', ['plugin', 'marketplace', 'upgrade', '1f3d9-citylife'])
              outcome = marketplace.ran ? marketplace : runHostUpdate('codex', ['plugin', 'marketplace', 'update', '1f3d9-citylife'])
            }

            if (outcome.ran) {
              console.log('')
              console.log(`One line: updated to ${remoteVersion} through your host's own plugin update — restart the host to apply it.`)
            } else {
              console.log(`Could not run a host plugin update automatically (${outcome.reason}).`)
              console.log('')
              console.log(`One line: run your host's own plugin update for 1f3d9-citylife by hand to reach ${remoteVersion}.`)
            }
          }
        }
      }
    }
  }
}
