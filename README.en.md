# wb-mcp — Wildberries Seller API as a local MCP server

> **Your Wildberries Seller API inside an AI assistant.** Local by default: the client spawns the
> server, and the token plus store data never leave your machine.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](./test)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```text
Cursor / Claude / Codex / Gemini / VS Code
        │  MCP over stdio (JSON-RPC)
        ▼
   server.mjs  ── HTTPS ──▶  *.wildberries.ru
        │
        └── catalog/ (built from official WB OpenAPI specs)
```

## Highlights

- 🎯 **Full Seller API coverage.** 13 official sections, **309 methods**, generated from the
  official WB OpenAPI specs; `node verify.mjs` confirms 13/13 and no gaps.
- 🪶 **Zero dependencies.** Node.js ≥ 20 plus our own code: auditable in an evening, no
  supply-chain surface.
- 🧠 **A real MCP server, not just tools.** Prompts with scenarios, Resources (`wb://…`),
  structuredContent, progress notifications, catalog subscriptions.
- 🔐 **Token under your control.** AES-256-GCM at rest (`~/.wb-mcp/token.enc`); client configs
  contain only the file path; in `.mcpb` the token lives in Claude's secure storage. Requests go
  only to `*.wildberries.ru`.
- 🏠 **Local by default.** No VPS, ports or cloud; store data stays on your machine and request
  bodies are never logged.
- 📦 **Install for your client.** `.mcpb` one-click, Cursor/VS Code deeplinks, portable ZIP,
  installer for 6 clients, `npx` without installing anything.
- ⚡ **Careful with WB limits.** Token bucket from the official spec limits, 429 and **409 penalty**
  handling, large responses saved to disk instead of context.
- 🔄 **Fresh catalog.** Offline catalog shipped in the release, `wb_refresh` in one command,
  `doctor` warns when the catalog gets stale.
- 🩺 **Verifiable.** 85 offline tests against a mock WB API, CI on Windows/Linux, `doctor` and
  `verify` built in.

## Install

| Client | How |
|---|---|
| **Claude Desktop** | download `wb-mcp.mcpb` from Releases → double-click |
| **Cursor** | [Install in Cursor](https://cursor.com/install-mcp?name=wb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiZ2l0aHViOkdyZWdvcnktbWNiaXQvd2lsZGJlcnJpZXMtbWNwIiwid2ItbWNwIl0sImVudiI6eyJXQl9BVVRPX1NZTkMiOiIxIiwiV0JfQVBJX1RPS0VOIjoiUEFTVEVfWU9VUl9XQl9BUElfVE9LRU4ifX0%3D) |
| **VS Code** | [Install in VS Code](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22github%3AGregory-mcbit%2Fwildberries-mcp%22%2C%22wb-mcp%22%5D%2C%22env%22%3A%7B%22WB_AUTO_SYNC%22%3A%221%22%2C%22WB_API_TOKEN%22%3A%22PASTE_YOUR_WB_API_TOKEN%22%7D%7D) |
| **Claude Code** | `claude mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Codex CLI** | `codex mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Gemini CLI** | `gemini mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Portable ZIP** | `wb-mcp-portable.zip` from Releases → run `install.cmd` / `install.sh` |
| **No install** | `WB_API_TOKEN=<token> WB_AUTO_SYNC=1 npx -y -p github:Gregory-mcbit/wildberries-mcp wb-mcp` |

The installer (`node install.mjs --client all --token <token>`) configures Cursor, Claude Desktop,
Claude Code, Codex, Gemini CLI and VS Code, builds or downloads the offline catalog, and stores the
token encrypted with AES-256-GCM. Client configs contain only `WB_TOKEN_FILE=...`, never the token.

## Tools (8 instead of 1000+)

`wb_search`, `wb_describe`, `wb_get` (read-only), `wb_call` (writes), `wb_sections`,
`wb_token_info`, `wb_request`, `wb_refresh`.

## Prompts (slash commands)

`sales-accelerator` — full sales growth audit (funnel/CTR, content, SEO, pricing, ads, promos, stock,
reviews) with a 7/30-day plan; plus `diagnose-orders-drop`, `check-stock`, `reply-reviews`,
`weekly-report`.

## Resources

`wb://catalog/index`, `wb://sections/<key>`, `wb://method/<id>` with `resources/subscribe` and
`notifications/resources/updated`; `structuredContent`, `notifications/progress`.

## Diagnostics

```bash
node doctor.mjs          # Node, catalog, token, network, client configs
node doctor.mjs --json
```

## Environment

| Variable | Purpose |
|---|---|
| `WB_API_TOKEN` | WB API token (or use encrypted `WB_TOKEN_FILE`) |
| `WB_TOKEN_FILE` | path to encrypted token (set by installer) |
| `WB_TOKEN_KEY` | path to the encryption key |
| `WB_READONLY` | `1` — block all write methods |
| `WB_AUTO_SYNC` | `1` — build the catalog on start if missing (npx mode) |
| `WB_MCP_CATALOG` | catalog directory |
| `WB_MAX_OUTPUT` | max chars returned into the model context (default 80000) |

## Development

```bash
node test/yaml.test.mjs && node test/sync.test.mjs && node test/mcp.test.mjs \
  && node test/publish.test.mjs && node test/package.test.mjs && node test/bundle.test.mjs \
  && node test/doctor.test.mjs && node test/tokenstore.test.mjs && node test/mcpb.test.mjs
```

Tests run offline against a local mock of the WB API.

## License

MIT — see [LICENSE](./LICENSE).
