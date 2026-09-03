// Ambient declaration for the test-only exports from identity-client.mjs (a
// dependency-free CLI script, not part of the TypeScript build). Keep these
// signatures in sync with the real implementations.
export interface StoreSecretDeps {
  execFileSync?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown
  platform?: NodeJS.Platform
  /**
   * Consulted on macOS and Windows (the ~/.1f3d9 vault index) and on the
   * plain-file path (the credentials directory itself); it never changes
   * where the OS credential store (Windows Credential Manager, macOS
   * Keychain) keeps the secret entry, only where the non-secret label index
   * and the plain-file fallback live.
   */
  homeDir?: string
  /**
   * Injected file reader used by readSecret's plain-file backend (readFileSync
   * by default). Not used by listVaultLabels, which reads only the non-secret
   * vault index -- see the "Non-secret vault index" comment in
   * identity-client.mjs.
   */
  readFileSync?: (path: string, encoding: string) => string
}

export declare function storeSecret(
  origin: string,
  label: string,
  payload: unknown,
  deps?: StoreSecretDeps,
): string

export type ReadSecretResult<T = unknown> =
  | { found: true; value: T }
  | { found: false; value: null }

/**
 * Thrown by readSecret when the vault reports a stored entry exists but its
 * content could not be decoded back into the JSON bundle storeSecret writes.
 * Distinct from "nothing is stored there", which readSecret reports by
 * returning `{ found: false }` instead of throwing.
 */
export declare class SecretReadFailure extends Error {}

export declare function readSecret<T = unknown>(
  origin: string,
  label: string,
  deps?: StoreSecretDeps,
): ReadSecretResult<T>

export declare function deleteSecret(
  origin: string,
  label: string,
  deps?: StoreSecretDeps,
): void

/** Every label this host's vault currently holds for `origin`, excluding staging labels. Never throws. */
export declare function listVaultLabels(
  origin: string,
  deps?: StoreSecretDeps,
): string[]

export declare function promoteReplacementKey(
  origin: string,
  handle: string,
  stagingLabel: string,
  residentKey: string,
  mergeFields: (previous: Record<string, unknown> | null) => Record<string, unknown>,
  deps?: StoreSecretDeps,
): string

/** Pure predicate behind revealOrHide: true only when --reveal was passed AND stdout is a real TTY. */
export declare function shouldReveal(flags: Record<string, unknown>, isTty: boolean | undefined): boolean
