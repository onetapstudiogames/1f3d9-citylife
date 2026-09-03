// Stands in for the real scripts/identity-client.mjs, for exactly one
// caller: setup.mjs, redirected here by incomplete-vault-loader.mjs. Every
// export except listVaultLabels is the REAL implementation (imported and
// re-exported unchanged) -- only listVaultLabels is replaced, with a
// version that always throws KeychainEnumerationIncomplete, reproducing
// (through a real setup.mjs subprocess, on whichever OS this test actually
// runs on -- CI never runs on darwin, so the real code path is otherwise
// unreachable end to end) the "this host's vault enumeration did not
// finish" refusal setup.mjs's own guard exists for.
import * as real from '../../scripts/identity-client.mjs'

export const {
  storeSecret, readSecret, deleteSecret, promoteReplacementKey, SecretReadFailure, shouldReveal,
  HANDLE_RE, RESERVED_HANDLE_SUBSTRING_RE, validateModelLabel, KeychainEnumerationIncomplete,
} = real

export function listVaultLabels() {
  throw new real.KeychainEnumerationIncomplete(
    'fake security dump-keychain output exceeded the 64 MiB read limit -- the Keychain scan is incomplete, ' +
    'not empty (injected by test/helpers/fake-incomplete-identity-client.mjs)',
  )
}
