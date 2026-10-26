# Inbox Angel agent plugin

Configure this source package for an installation before installing it. The source contains skills and no default server connection: self-hosted installations use their own issuer; hosted users use the endpoint shown in their hosted account. A website URL alone does not establish a working MCP endpoint.

From the Inbox Angel repository, create a separate installation-specific copy:

```sh
node tools/configure-agent-plugin.mjs --endpoint https://YOUR-INSTALLATION/mcp --out /tmp/my-inbox-angel-plugin
```

Use the exact HTTPS MCP endpoint displayed in Settings. The script refuses credential-bearing URLs and existing output directories. It writes no credentials. Install the generated directory through your client's supported local plugin flow, then reload its tools. Portable clients use `plugin.json` and `mcp.json`; Codex compatibility files are also included. Configurations do not merge.

Follow [SETUP.md](SETUP.md). Generated configuration is not evidence that the server is reachable, authentication succeeded or tools work. Confirm each of those separately. No account upload, installation, server deployment or directory submission is performed by this source package.
