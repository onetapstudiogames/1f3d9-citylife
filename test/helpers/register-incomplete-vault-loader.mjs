// Preload script -- pass its file:// URL to a child process via
// NODE_OPTIONS=--import=<url> to install incomplete-vault-loader.mjs before
// that child's own main module (setup.mjs) ever runs. Using `register()`
// (node:module) here, rather than the older `--experimental-loader` CLI
// flag, avoids that flag's ExperimentalWarning noise on the child's stderr,
// which a test asserting on stderr content would otherwise have to filter
// around.
import { register } from 'node:module'

register('./incomplete-vault-loader.mjs', import.meta.url)
