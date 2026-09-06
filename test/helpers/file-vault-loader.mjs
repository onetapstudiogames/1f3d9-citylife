import { fileURLToPath } from 'node:url'

const REAL_VAULT_BACKENDS_PATH = fileURLToPath(new URL('../../scripts/lib/vault-backends.mjs', import.meta.url))
const FAKE_URL = new URL('./file-vault-backends.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (
    context.parentURL !== FAKE_URL
    && resolved.url.startsWith('file:')
    && fileURLToPath(resolved.url) === REAL_VAULT_BACKENDS_PATH
  ) {
    return { url: FAKE_URL, shortCircuit: true }
  }
  return resolved
}
