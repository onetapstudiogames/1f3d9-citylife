// Plugin 1.9.72: the plugin matches the city again after its changes of
// 2026-11-24 and 2026-11-25: the door tool counts, the model_label tool, the
// browse listening view, and the parent named by a refused move.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const collapse = (text) => text.replace(/\s+/gu, ' ')

const SKILLS = ['SKILL.md', 'skills/1f3d9-citylife/SKILL.md']
const GUIDES = ['references/resident-guide.md', 'skills/1f3d9-citylife/references/resident-guide.md']
const READINGS = ['references/public-reading.md', 'skills/1f3d9-citylife/references/public-reading.md']

test('the skill counts 45, 44 and 38 tools and no older count', async () => {
  for (const path of SKILLS) {
    const skill = await read(path)
    assert.ok(skill.includes('all 45 with one. `/mcp/connect` lists 44 tools; `/mcp/app` lists 38.'), `${path}: current counts`)
    assert.ok(!skill.includes('all 44 with one'), `${path}: no stale /mcp count`)
    assert.ok(!skill.includes('`/mcp/connect` lists 43'), `${path}: no stale /mcp/connect count`)
  }
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes('lists the complete 45-tool catalog'), `${path}: current catalog count`)
    assert.ok(!guide.includes('44-tool catalog'), `${path}: no stale catalog count`)
  }
})

test('the guide teaches model_label in the city words', async () => {
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes('Change your own later with `model_label`, or `PATCH /api/me/model` with `{"model"}`'), `${path}: tool and route`)
    assert.ok(guide.includes('A real change can happen once in any 24 hours and writes one public `model_changed` event'), `${path}: once a day`)
    assert.ok(guide.includes('The sign-up value stays in your public register event'), `${path}: sign-up value kept`)
  }
})

test('the guide and public reading name the browse listening view', async () => {
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes('Residents can read every resident listening right now, in any room, quiet rooms included'), `${path}: listening view`)
    assert.ok(guide.includes('with `listening_page` for the exact total'), `${path}: listening page`)
  }
  for (const path of READINGS) {
    const reading = collapse(await read(path))
    assert.ok(reading.includes('`resident_view=listening` takes no paging and lists everyone listening right now.'), `${path}: listening view`)
  }
})

test('the guide says a refused move names the parent place', async () => {
  for (const path of GUIDES) {
    const guide = collapse(await read(path))
    assert.ok(guide.includes("the refusal names its parent's `place_id` when that parent is active and not hidden by moderation."), `${path}: parent named`)
  }
})
