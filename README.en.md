# wb-mcp

**Wildberries Seller API inside your AI assistant.** Local by default: the client spawns the server,
and the token plus store data never leave your machine.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](./test)
[![npm](https://img.shields.io/npm/v/wb-mcp)](https://www.npmjs.com/package/wb-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## Highlights

- 🎯 **Full Seller API coverage** — all **13 sections, 309 methods** generated from the official WB
  OpenAPI specs; `node verify.mjs` confirms 13/13 and no gaps.
- 🪶 **Zero dependencies** — Node.js ≥ 20 and our own code only: auditable in an evening, no
  supply-chain surface.
- 🔐 **Your token stays yours** — AES-256-GCM at rest, client configs reference the file path only;
  requests go only to `*.wildberries.ru`, request bodies are never logged.
- 🧠 **A complete MCP server** — tools plus prompts with scenarios, resources (`wb://…`),
  structuredContent, progress notifications and catalog subscriptions.
- ⚡ **Careful with WB limits** — token bucket from the spec limits, 429 and 409-penalty handling,
  large responses saved to disk instead of model context.
- 📦 **One-step install** — `.mcpb` double-click, Cursor/VS Code deeplinks, portable ZIP, installer
  for 6 clients, `npx` without installing anything.
- 🔄 **Fresh catalog** — offline bundle in GitHub Releases, `wb_refresh`, and `doctor` warnings when
  the catalog gets stale.
- ✅ **Verifiable** — 85 offline tests against a mock WB API, CI on Windows/Linux, `doctor` and `verify`.

## Install

### 1. Get a WB API token

Seller cabinet → **Settings → API integrations → Create token**.
Start with **read-only** and only the scopes you need.

### 2. Install into your client

| Client | How |
|---|---|
| **Claude Desktop** | download `wb-mcp.mcpb` from Releases → double-click → paste the token |
| **Cursor** | [Install in Cursor](https://cursor.com/install-mcp?name=wb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiZ2l0aHViOkdyZWdvcnktbWNiaXQvd2lsZGJlcnJpZXMtbWNwIiwid2ItbWNwIl0sImVudiI6eyJXQl9BVVRPX1NZTkMiOiIxIiwiV0JfQVBJX1RPS0VOIjoiUEFTVEVfWU9VUl9XQl9BUElfVE9LRU4ifX0%3D) → replace `PASTE_YOUR_WB_API_TOKEN` |
| **VS Code** | [Install in VS Code](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22github%3AGregory-mcbit%2Fwildberries-mcp%22%2C%22wb-mcp%22%5D%2C%22env%22%3A%7B%22WB_AUTO_SYNC%22%3A%221%22%2C%22WB_API_TOKEN%22%3A%22PASTE_YOUR_WB_API_TOKEN%22%7D%7D) → replace `PASTE_YOUR_WB_API_TOKEN` |
| **Claude Code** | `claude mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Codex CLI** | `codex mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Gemini CLI** | `gemini mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **All clients at once** | `node install.mjs --client all --token <token>` |
| **From npm** | `npx -y -p wb-mcp wb-mcp-install --client all --token <token>` |
| **Portable ZIP** | `wb-mcp-portable.zip` from Releases → `install.cmd` / `install.sh` |

The installer downloads the offline catalog, stores the token **encrypted**
(`~/.wb-mcp/token.enc`) and writes client configs containing only `WB_TOKEN_FILE`.

Flags: `--client cursor|claude|claude-code|codex|gemini|vscode|all`, `--no-release`,
`--bundle <file>`, `--plain-token`.

### 3. Restart the client and verify

```
"show WB API sections"          → wb_sections
"check WB API connection"       → wb_get {"id":"getPing"}
```

```bash
node ~/.wb-mcp/app/doctor.mjs
```

## What the agent gets

**8 tools:** `wb_search`, `wb_describe`, `wb_get` (read), `wb_call` (write), `wb_sections`,
`wb_token_info`, `wb_request`, `wb_refresh`.

**5 prompts:** `sales-accelerator` (full sales-growth audit), `diagnose-orders-drop`, `check-stock`,
`reply-reviews`, `weekly-report`.

**Resources:** `wb://catalog/index`, `wb://sections/<key>`, `wb://method/<id>`.

## Diagnostics and updates

```bash
node doctor.mjs          # Node, catalog, token, network, client configs
node doctor.mjs --json
node verify.mjs          # catalog structure and coverage
node sync.mjs            # rebuild the catalog from official specs
```

From chat: `wb_refresh`.

## Security

- Token is encrypted with AES-256-GCM; the key is a separate owner-only file.
- Only `*.wildberries.ru` hosts are allowed; everything else is blocked before the request.
- Reads and writes are split: `wb_get` is safe, `wb_call` is for changes.
- The server sees the read-only bit in the JWT and blocks writes early; `WB_READONLY=1` is a hard mode.

## Development

```bash
node test/mcp.test.mjs      # MCP protocol + HTTP on a mock WB
node test/yaml.test.mjs     # YAML parser on a real WB spec
node test/sync.test.mjs     # catalog builder
node test/package.test.mjs  # packaging invariant (zero deps)
```

See [AGENT-INSTALL.md](./AGENT-INSTALL.md) and [README.md](./README.md) (Russian).

## License

MIT — see [LICENSE](./LICENSE).
