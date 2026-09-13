import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [host, ...args] = process.argv.slice(2)
const recordFile = process.env.JOIN_CLI_RECORD_FILE
if (!host && !recordFile) process.exit(0)
if (!recordFile || !['claude', 'codex'].includes(host)) process.exit(2)
const data = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : { entries: {}, calls: [] }
const finish = (status, message = '') => {
  if (message) console.error(message)
  writeFileSync(recordFile, JSON.stringify(data))
  process.exit(status)
}
if (args[0] === '--version') finish(0)
const action = args[1]
const name = action === 'get' ? args[2] : action === 'remove' ? args.at(-1)
  : host === 'claude' ? args[4] : args[2]
data.calls.push({ host, args })
if (action === 'get') {
  if (data.entries[name]) finish(0)
  finish(1, host === 'claude' ? `No MCP server named "${name}".` : `No MCP server named '${name}' found.`)
}
if (action === 'remove') {
  if (!data.entries[name]) finish(1)
  delete data.entries[name]
  finish(0)
}
if (action === 'add') {
  if (process.env.JOIN_CLI_FAIL_ADD === '1') finish(1, 'test connector add failure')
  data.entries[name] = args
  if (process.env.JOIN_CLI_ADD_MARKER) writeFileSync(process.env.JOIN_CLI_ADD_MARKER, 'added\n')
  finish(0)
}
finish(2)
