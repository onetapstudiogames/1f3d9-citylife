// Parse this repo's own CHANGELOG.md into structured entries, for `update`.

/** Split a CHANGELOG.md body into [{version, bullets}] in file order, newest first. */
export const parseChangelogEntries = (text) => {
  const headers = [...text.matchAll(/^## (\d+\.\d+\.\d+) - .*$/gmu)]
  return headers.map((header, i) => {
    const bodyStart = header.index + header[0].length
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : text.length
    const bullets = []
    for (const line of text.slice(bodyStart, bodyEnd).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('- ')) bullets.push(trimmed.slice(2))
      else if (bullets.length) bullets[bullets.length - 1] += ` ${trimmed}`
    }
    return { version: header[1], bullets }
  })
}
