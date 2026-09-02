# Connect 1F3D9

This plugin bundles the skill and the hosted remote MCP connector at
`https://1f3d9.com/mcp/connect`. The browser sign-in page is first-party. Never
paste a resident key into chat, a URL, or a tool argument.

## Claude Code

1. Add this repository as a marketplace:

   ```text
   claude plugin marketplace add onetapstudiogames/1f3d9-citylife
   ```

2. Install `1f3d9-citylife` from that marketplace. Claude reads
   `.claude-plugin/marketplace.json`, the plugin manifest, `skills/`, and `.mcp.json`.

   ```text
   claude plugin install 1f3d9-citylife@1f3d9-citylife
   ```

3. Start a new Claude Code session, open the 1F3D9 connector, and finish browser
   sign-in at the exact `https://1f3d9.com` origin.
4. Say `Configure 1F3D9.`

Validate a local checkout with:

```text
claude plugin validate . --strict
```

## Codex

1. Add this repository as a Codex marketplace:

   ```text
   codex plugin marketplace add onetapstudiogames/1f3d9-citylife
   ```
2. Install `1f3d9-citylife@1f3d9-citylife`. Codex reads
   `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, and `skills/`;
   its manifest declares the hosted connector directly.
3. Start a new thread so Codex loads the skill and connector, then finish the
   first-party browser sign-in when prompted.
4. Say `Configure 1F3D9.`

The shorter `https://1f3d9.com/mcp` endpoint is only for local clients that can
keep a bearer key in a private authorization header. Do not replace the bundled
hosted address with it in Claude Code or Codex.

## Commands

Both hosts load every command from the same `skills/` directory the plugin manifests already
declare. In Claude Code, each one is also a slash command: `/1f3d9-citylife:help`,
`/1f3d9-citylife:links`, `/1f3d9-citylife:donate`, `/1f3d9-citylife:buy`,
`/1f3d9-citylife:schedule`, `/1f3d9-citylife:follow`, `/1f3d9-citylife:live`,
`/1f3d9-citylife:update`, `/1f3d9-citylife:changelog`, `/1f3d9-citylife:tools`. Codex has no
plugin-defined slash commands (its own plugin structure has no `commands/` directory — see
<https://developers.openai.com/codex/plugins/build>), so the same skill folders are invoked by
name instead, for example "1f3d9 help" or "1f3d9 follow kalani". Every command that does real work
runs a dependency-free Node script under `scripts/`, so the agent spends tokens only on the
one-line summary, never on rendering.

`setup`, `connect`, and `key` are not in this release; they need the city's new identity doors,
landing separately. `help` already says so.

The Codex package does not carry `buy`: OpenAI's plugin guidelines forbid selling digital services
through a plugin, and `buy` prints a payment-adjacent link for a specific resident. Claude Code
carries it; Codex does not run it as a named command. `donate` ships to both, and only as a plain
link in this release — this build does not include a dependency-free QR encoder, so `donate` says
that plainly and prints the link instead, in every host.
