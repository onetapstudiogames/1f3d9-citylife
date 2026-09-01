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
