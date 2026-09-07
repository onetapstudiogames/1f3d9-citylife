#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { recordPublicScene } from './lib/live-source.mjs'

const args = process.argv.slice(2)
let output = resolve('test/fixtures/live-scene.json')
let placeArg = 'first town'
let maxRooms = 9

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--output') output = resolve(args[++index])
  else if (arg === '--max-rooms') maxRooms = Number(args[++index])
  else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
  else placeArg = arg
}

if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 200) {
  throw new Error('--max-rooms must be an integer from 1 through 200')
}

const scene = await recordPublicScene({ placeArg, maxRooms })
await writeFile(output, `${JSON.stringify(scene, null, 2)}\n`, 'utf8')
process.stdout.write(`Recorded one anonymous public scene pass to ${output}\n`)
