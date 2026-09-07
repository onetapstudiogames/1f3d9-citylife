# PR zero verification

The local bridge starts in a fresh Claude Code 2.1.263 process on the owner's
Windows PC. The bundled browser door stays signed out. The recorded result is
in [host-proof.json](host-proof.json): `1f3d9-local` is `connected`, the browser
door is `needs-auth`, and no city tool was called.

The signed-in check is **NOT done**. This Windows profile has no setup selection
for the plugin. Claude therefore sees the public tools only, and `me` is not
advertised. We did not select another resident, run registration, change the
vault, or use a different keyed route to get around this missing prerequisite.

The fresh process used the plugin's own configuration, with this invocation:

```powershell
$env:ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
claude --plugin-dir C:/Users/Owner/Documents/1f3d9-citylife-terminal --setting-sources '' --tools '' --allowedTools mcp__plugin_1f3d9-citylife_1f3d9-local__me --permission-mode dontAsk --permission-prompts none --no-chrome --output-format stream-json --verbose --no-session-persistence -p 'Verify this plugin bridge. Call the 1f3d9-local me tool exactly once with empty arguments. Do not use any other tool or browser. If it is unavailable, stop and say unavailable. Return only whether that call succeeded and the resident handle. This one me read is explicitly authorized.'
```

The proof file retains server names/status, tool names, whether arguments were
empty, and the slot for a public resident handle, alongside the time, host
version, plugin path, invocation, exit code, and whether stderr was emitted.
Full tool results and stderr were not saved. The non-secret environment flag disables unrelated Claude.ai
connectors; no resident key is put in the environment. `--strict-mcp-config`
cannot be used here because it disables bundled plugin MCP servers as well.

Real-terminal screenshots are also **NOT done**. A Windows Terminal window was
opened for the check, but screenshot capture returned either a black image or
the foreground game. Those images were discarded.

Host configuration was checked against the current primary sources:

- [Claude plugin MCP configuration](https://code.claude.com/docs/en/plugins-reference#mcp-servers)
- [Claude CLI options](https://code.claude.com/docs/en/cli-usage)
- [Claude environment variables](https://code.claude.com/docs/en/env-vars)
- [Codex bundled MCP servers](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)
- [Codex plugin configuration loader](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs)

Claude expands `CLAUDE_PLUGIN_ROOT` in its `.mcp.json` command arguments. The
existing Codex manifest format resolves a relative `cwd` against the plugin
root; its companion file uses that behavior without relying on a placeholder.
The separate companion files preserve the same hosted browser door.

Final local checks: `npm test` ran 299 tests, with 290 passed, 9 skipped, and
0 failed. `npm run check:live-truth`, `npm run check:release-version`, both
Claude manifest validations, and `git diff --check` passed. The bridge and
guidance coverage run passed 25 tests, measuring 95.85% lines, 86.67% branches,
and 93.10% functions. Independent security review found no remaining blocker.
`npm ls --depth=0` confirms zero dependencies. `npm audit --offline` cannot run
without a lockfile (`ENOLOCK`); this dependency-free repo has no lockfile.

An adjacent wording issue remains in the existing rotation/recovery command:
its success messages still mention an environment variable. Those identity
scripts are outside the authorized PR-zero scope and were not edited. For the
new local bridge, replacing a stored key requires restarting the host so the
bridge reloads the vault, as SETUP.md now explains.
