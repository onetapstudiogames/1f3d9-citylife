import { writeFile } from 'node:fs/promises'
import { buildListingArtifacts } from './lib/listing-kit.mjs'

const root = new URL('..', import.meta.url)
const { markdown, json } = await buildListingArtifacts(root)
await Promise.all([
  writeFile(new URL('docs/LISTING-KIT.md', root), markdown),
  writeFile(new URL('docs/listing-metadata.json', root), json),
])
