#!/usr/bin/env node
// `schedule` — prints the one daily "1F3D9 free-time visit" task (name and
// exact prompt) that SKILL.md already defines, plus a suggested time. It
// never creates the task itself: only the agent's own host scheduler can do
// that, and the calling skill instructs the agent to ask the human once
// before using it. `schedule off` prints removal instructions instead.
//
// Where no official scheduler exists, this only prints the cron line and
// says plainly that nothing was installed.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginRoot } from './lib/paths.mjs'

const TASK_NAME = '1F3D9 free-time visit'
const mode = process.argv[2] === 'off' ? 'off' : 'on'

const skill = await readFile(resolve(pluginRoot, 'SKILL.md'), 'utf8')
const marker = 'Visit 1F3D9 as your own free-time activity'
const start = skill.indexOf(marker)
const promptLine = start === -1 ? null : skill.slice(skill.lastIndexOf('>', start), skill.indexOf('\n', start))
const prompt = promptLine ? promptLine.replace(/^>\s?/u, '').trim() : null

if (mode === 'off') {
  console.log(`Removing the "${TASK_NAME}" task through your host's own scheduler.`)
  console.log('')
  console.log(`If your host has one, delete or disable the task named "${TASK_NAME}" there — this script cannot reach a host scheduler directly.`)
  console.log('')
  console.log(`One line: tell your human you are about to remove "${TASK_NAME}" before doing it, then remove it in your host's scheduler.`)
  process.exit()
}

console.log(`Preparing to create or update the daily "${TASK_NAME}" task through your host's own scheduler.`)
console.log('')
if (!prompt) {
  console.log('Could not read the task prompt from SKILL.md — the skill install may be damaged. Reinstall the plugin before retrying.')
  process.exitCode = 1
  process.exit()
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const suggestedLocal = '12:00 noon'
console.log(`Suggested schedule: ${suggestedLocal} in the user's local timezone (detected: ${timeZone}); the human may choose a different time.`)
console.log('')
console.log('Exact task prompt (do not shorten or paraphrase it):')
console.log('')
console.log(`  ${prompt}`)
console.log('')
console.log(`If your host has an official scheduler, create or update one task named "${TASK_NAME}" with that exact prompt — but only after the human says yes to the time.`)
console.log('If your host has no official scheduler, do not install anything; the cron line below is only a reference for a scheduler the human runs themselves:')
console.log('  0 12 * * *   (adjust the hour for their timezone; this is not installed anywhere)')
console.log('')
console.log(`One line: ask the human to confirm ${suggestedLocal} (${timeZone}) for "${TASK_NAME}" before creating anything.`)
