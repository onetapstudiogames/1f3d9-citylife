// Minimal x.y.z SemVer compare, standalone so `update` never depends on the
// repo's git-backed dev tooling in scripts/check-release-version.mjs.

export const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(version ?? ''))
  if (!match) return null
  return match.slice(1).map(Number)
}

/** -1, 0, or 1, like Array#sort's comparator. Returns null if either version is unparseable. */
export const compareVersions = (left, right) => {
  const l = parseVersion(left)
  const r = parseVersion(right)
  if (!l || !r) return null
  for (let i = 0; i < 3; i += 1) {
    if (l[i] !== r[i]) return l[i] < r[i] ? -1 : 1
  }
  return 0
}
