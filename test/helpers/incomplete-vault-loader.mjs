// Node module customization hook (see register-incomplete-vault-loader.mjs
// for how this gets registered into a setup.mjs subprocess via
// NODE_OPTIONS=--import). Redirects ONLY setup.mjs's own top-level
// `import ... from './identity-client.mjs'` to
// fake-incomplete-identity-client.mjs -- checked by matching BOTH the
// resolved target (identity-client.mjs) AND the importer (setup.mjs, via
// context.parentURL), so the fake module's own `import * as real from
// '../../scripts/identity-client.mjs'` (a different importer) still
// resolves to the REAL module rather than looping back into itself.
import { fileURLToPath } from 'node:url'

const REAL_IDENTITY_CLIENT_PATH = fileURLToPath(new URL('../../scripts/identity-client.mjs', import.meta.url))
const SETUP_PATH = fileURLToPath(new URL('../../scripts/setup.mjs', import.meta.url))
const FAKE_URL = new URL('./fake-incomplete-identity-client.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (
    context.parentURL?.startsWith('file:')
    && resolved.url.startsWith('file:')
    && fileURLToPath(resolved.url) === REAL_IDENTITY_CLIENT_PATH
    && fileURLToPath(context.parentURL) === SETUP_PATH
  ) {
    return { url: FAKE_URL, shortCircuit: true }
  }
  return resolved
}
