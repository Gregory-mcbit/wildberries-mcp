# wb-mcp

Connects your Wildberries seller account to an AI assistant (Cursor, Claude, Codex, Gemini, VS Code).
The assistant works with real orders, stock, sales, reviews and prices from WB instead of guessing.

[![npm](https://img.shields.io/npm/v/wildberries-seller-mcp)](https://www.npmjs.com/package/wildberries-seller-mcp)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## What it gives you

- **The assistant knows what to ask Wildberries for.** No need to dictate API commands and paths —
  just ask in plain language: "how many orders yesterday", "why did sales drop", "which products
  are running out".
- **Real data from your seller account:** orders, sales, stock, products and prices, reviews and
  questions, ads, supplies, finances, documents.
- **It can also change things** — prices, stock, review replies, ad bids — but always shows you the
  change and does it only after you confirm.
- **Everything runs on your computer.** The server starts locally, your token is stored encrypted and
  never leaves your machine (only requests to Wildberries itself). No hosting bills.
- **It respects Wildberries limits**, waits and retries when WB asks, and saves large reports to a
  file instead of flooding the chat.
- **Setup takes a couple of minutes**, and the method catalog is refreshed with one command when WB
  changes its API.

## Install

### 1. Get a Wildberries token

Seller cabinet → **Settings → API integrations → Create token**.
Start with **read-only** and the minimum scopes: the assistant will not be able to change anything.

### 2. Install the server

The easiest path is the universal installer. It finds your clients, writes their configs, downloads
the method catalog and stores the token encrypted:

```bash
node install.mjs --client all --token <your_token>
```

If the repository is not cloned yet:

```bash
npx -y -p wildberries-seller-mcp wb-mcp-install --client all --token <your_token>
```

### Or install into a specific client

All install files are on the [Releases → catalog](https://github.com/Gregory-mcbit/wildberries-mcp/releases/tag/catalog)
page.

| Client | What to do |
|---|---|
| **Claude Desktop** | Download [wb-mcp.mcpb](https://github.com/Gregory-mcbit/wildberries-mcp/releases/download/catalog/wb-mcp.mcpb) and open it with a double click. Claude shows a window where you paste the token. |
| **Cursor** | [Install in Cursor](https://cursor.com/install-mcp?name=wb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiZ2l0aHViOkdyZWdvcnktbWNiaXQvd2lsZGJlcnJpZXMtbWNwIiwid2ItbWNwIl0sImVudiI6eyJXQl9BVVRPX1NZTkMiOiIxIiwiV0JfQVBJX1RPS0VOIjoiUEFTVEVfWU9VUl9XQl9BUElfVE9LRU4ifX0%3D) — Cursor opens its install dialog. Afterwards open the MCP config and replace `PASTE_YOUR_WB_API_TOKEN` with your token. That is the only thing you need to fill in. |
| **VS Code** | [Install in VS Code](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22github%3AGregory-mcbit%2Fwildberries-mcp%22%2C%22wb-mcp%22%5D%2C%22env%22%3A%7B%22WB_AUTO_SYNC%22%3A%221%22%2C%22WB_API_TOKEN%22%3A%22PASTE_YOUR_WB_API_TOKEN%22%7D%7D) — VS Code asks for confirmation. If no window appears, run the universal installer above; the result is the same. |
| **Claude Code** | `claude mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Codex CLI** | `codex mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **Gemini CLI** | `gemini mcp add wb --env WB_API_TOKEN=<token> -- node <path>/server.mjs` |
| **No install** | Download [wb-mcp-portable.zip](https://github.com/Gregory-mcbit/wildberries-mcp/releases/download/catalog/wb-mcp-portable.zip), unpack and run `install.cmd` (Windows) or `install.sh` (macOS/Linux). |

### Or let the assistant install it

Send the assistant the repository link and ask:

> "Connect wb-mcp from https://github.com/Gregory-mcbit/wildberries-mcp following AGENT-INSTALL.md"

The assistant opens [AGENT-INSTALL.md](https://github.com/Gregory-mcbit/wildberries-mcp/blob/main/AGENT-INSTALL.md),
downloads the repo, runs the installer, stores the token encrypted and verifies the connection with
`doctor`. It will ask you for the token.

### 3. Restart the assistant and verify

Ask: **"show WB API sections"**. If it works, the assistant lists the sections of your seller account.

If something is off, run the built-in check:

```bash
node ~/.wb-mcp/app/doctor.mjs
```

## What you can ask the assistant

- "How many orders and sales did I have yesterday and the day before?"
- "Why did sales drop this week?"
- "Which products will run out of stock soon?"
- "Show unanswered reviews and suggest replies"
- "Lower the price of this product by 5%" — the assistant shows exactly what it will change.
- "Build a weekly report for my store"

Ready-made scenarios are included: a full sales-growth review, an orders-drop investigation, a stock
check, review replies and a weekly report. In Cursor and Claude they appear as commands like
`/sales-accelerator`.

## Updating

```bash
node ~/.wb-mcp/app/sync.mjs   # re-download the latest Wildberries method descriptions
```

Or ask the assistant: "update the Wildberries catalog".

## Security

- The token is stored in an encrypted file (AES-256-GCM); client settings contain only the path to
  it. The key is kept in the system keychain: **DPAPI** on Windows, **Keychain** on macOS,
  **libsecret** on Linux.
- Requests go only to Wildberries hosts and **only over HTTPS** — `http://` is blocked.
- Mutating requests require confirmation: the server refuses the write until the assistant echoes
  the confirmation id that states what is about to change.
- Read-only mode (`WB_READONLY=1`) blocks writes through both the catalog call and the raw
  `wb_request`.
- Reads and writes are separated, and a read-only token cannot change anything by design.
- Logs contain no request bodies or response data.

**Honest note on token storage:** the key lives in the system keychain — DPAPI on Windows, Keychain
on macOS, libsecret on Linux (if the secret service is unavailable, the key falls back to a file next
to the data). No scheme protects against malware running as your OS user. Do not pass the token as a
`--token` argument (it lands in shell history) — use the `WB_API_TOKEN` environment variable or the
interactive installer instead.

## License

MIT — see [LICENSE](./LICENSE). Russian version — [README.md](./README.md).
