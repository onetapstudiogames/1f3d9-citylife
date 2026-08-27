import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPaths = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'gemini-extension.json',
  'qwen-extension.json',
]

const normalizeText = (value) => value.replaceAll('\r\n', '\n')

const parseVersion = (version) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
  if (!match) {
    throw new Error(`release versions must use valid x.y.z SemVer; received ${JSON.stringify(version)}`)
  }
  return match.slice(1).map(Number)
}

const compareVersions = (left, right) => {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index]
    }
  }
  return 0
}

export const assertVersionAdvance = ({ changed, baseVersion, currentVersion }) => {
  parseVersion(baseVersion)
  parseVersion(currentVersion)
  const comparison = compareVersions(currentVersion, baseVersion)
  if (changed && comparison <= 0) {
    throw new Error(
      `semantic skill content changed, so version ${currentVersion} must advance past ${baseVersion}`,
    )
  }
  if (comparison < 0) {
    throw new Error(`release version ${currentVersion} must not go backwards from ${baseVersion}`)
  }
}

const runGit = (argumentsList, cwd, { allowFailure = false, rawOutput = false } = {}) => {
  const result = spawnSync('git', argumentsList, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`git ${argumentsList.join(' ')} failed: ${detail}`)
  }
  if (result.status !== 0) return null
  return rawOutput ? result.stdout : result.stdout.trim()
}

const resolveCommit = (candidate, cwd) => {
  if (!candidate) return null
  return runGit(['rev-parse', '--verify', `${candidate}^{commit}`], cwd, { allowFailure: true })
}

const resolveBaseCommit = (requestedBase, cwd) => {
  const explicitBase = resolveCommit(requestedBase, cwd)
  if (requestedBase) return explicitBase

  for (const candidate of ['origin/main', 'main']) {
    if (!resolveCommit(candidate, cwd)) continue
    const mergeBase = runGit(['merge-base', 'HEAD', candidate], cwd, { allowFailure: true })
    if (mergeBase) return mergeBase
  }
  return null
}

const listFiles = async (directory, cwd) => {
  const absoluteDirectory = resolve(cwd, directory)
  let entries
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const child = `${directory}/${entry.name}`
    return entry.isDirectory() ? listFiles(child, cwd) : [child]
  }))
  return files.flat()
}

const currentSemanticFiles = async (cwd) => {
  const files = [
    'SKILL.md',
    ...(await listFiles('references', cwd)),
    'agents/openai.yaml',
  ]
  return [...new Set(files)].sort()
}

const baseSemanticFiles = (baseCommit, cwd) => {
  const output = runGit(
    ['ls-tree', '-r', '--name-only', baseCommit, '--', 'SKILL.md', 'references', 'agents/openai.yaml'],
    cwd,
  )
  return output ? output.split(/\r?\n/u).sort() : []
}

const readBaseFile = (baseCommit, path, cwd) => runGit(
  ['show', `${baseCommit}:${path}`],
  cwd,
  { rawOutput: true },
)

const semanticContentChanged = async (baseCommit, cwd) => {
  const [currentFiles, baseFiles] = await Promise.all([
    currentSemanticFiles(cwd),
    Promise.resolve(baseSemanticFiles(baseCommit, cwd)),
  ])
  const allFiles = [...new Set([...currentFiles, ...baseFiles])].sort()

  for (const path of allFiles) {
    if (!currentFiles.includes(path) || !baseFiles.includes(path)) return true
    const [currentContent, baseContent] = await Promise.all([
      readFile(resolve(cwd, path), 'utf8'),
      Promise.resolve(readBaseFile(baseCommit, path, cwd)),
    ])
    if (normalizeText(currentContent) !== normalizeText(baseContent)) return true
  }
  return false
}

const readCurrentVersions = async (cwd) => {
  const entries = await Promise.all(manifestPaths.map(async (path) => {
    const manifest = JSON.parse(await readFile(resolve(cwd, path), 'utf8'))
    return [path, manifest.version]
  }))
  const expected = entries[0][1]
  for (const [path, version] of entries) {
    if (version !== expected) {
      throw new Error(`${path} version ${version} does not match ${manifestPaths[0]} version ${expected}`)
    }
  }
  return expected
}

export const checkRepositoryVersion = async ({
  cwd = repositoryRoot,
  baseRef,
  requireBase = false,
} = {}) => {
  const baseCommit = resolveBaseCommit(baseRef, cwd)
  if (!baseCommit) {
    const requested = baseRef ? ` ${baseRef}` : ''
    const notice = `SKIP release-version check: no usable base commit${requested}`
    if (requireBase) throw new Error(`${notice}; a release base is required`)
    return { skipped: true, notice }
  }

  const [currentVersion, changed] = await Promise.all([
    readCurrentVersions(cwd),
    semanticContentChanged(baseCommit, cwd),
  ])
  const baseManifest = JSON.parse(readBaseFile(baseCommit, 'plugin.json', cwd))
  assertVersionAdvance({ changed, baseVersion: baseManifest.version, currentVersion })

  return {
    valid: true,
    changed,
    baseCommit,
    baseVersion: baseManifest.version,
    currentVersion,
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  try {
    const result = await checkRepositoryVersion({
      baseRef: process.env.SKILL_VERSION_BASE_SHA,
      requireBase: process.env.REQUIRE_RELEASE_BASE === '1',
    })
    console.log(result.skipped ? result.notice : `Release version check passed at ${result.currentVersion}.`)
  } catch (error) {
    console.error(`Release version check failed: ${error.message}`)
    process.exitCode = 1
  }
}
