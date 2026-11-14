# wb-mcp

**Русский** · [English](README.en.md)

> **Wildberries Seller API в твоём ИИ-ассистенте.** Локально, без VPS и без облака: клиент сам запускает сервер, а токен и данные магазина остаются у тебя.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](./test)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```
Cursor / Claude / Codex / Gemini / VS Code
        │  MCP (stdio, JSON-RPC)
        ▼
   server.mjs  ── HTTPS ──▶  *.wildberries.ru
        │
        └── catalog/ (из официальных OpenAPI WB)
```

## Чем хорош wb-mcp

- 🎯 **Полное покрытие Seller API.** 13 официальных разделов, **309 методов** — каталог собирается из OpenAPI WB, а не из ручных обёрток. `node verify.mjs` подтверждает 13/13 и отсутствие дыр.
- 🪶 **Ноль зависимостей.** Только Node.js ≥ 20 и наш собственный код: аудируется за вечер, нечего ломать в supply-chain.
- 🧠 **Полноценный MCP, а не только tools.** Prompts со сценариями, Resources (`wb://…`), structuredContent, progress-уведомления, подписки на обновление каталога.
- 🔐 **Токен под твоим контролем.** AES-256-GCM на диске (`~/.wb-mcp/token.enc`), в конфиге клиента — только путь к нему; в `.mcpb` токен хранит защищённое хранилище Claude. Запросы — только на `*.wildberries.ru`.
- 🏠 **Локально по умолчанию.** Нет VPS, портов и облака; данные магазина не покидают твою машину, тела запросов не логируются.
- 📦 **Установка под твой клиент.** `.mcpb` в один клик, deeplink'и Cursor/VS Code, portable ZIP, установщик на 6 клиентов, запуск через `npx` без установки.
- ⚡ **Аккуратная работа с WB.** Лимиты берутся из спек (token bucket), обрабатываются 429 и 409-штраф, большие ответы уходят в файл, а не в контекст модели.
- 🔄 **Каталог всегда свежий.** Офлайн-каталог в релизе, `wb_refresh` одной командой, `doctor` предупредит, если каталог устарел.
- 🩺 **Проверяемость.** 85 офлайн-тестов на моке WB, CI на Windows/Linux, `doctor` для диагностики и `verify` для каталога.

Цифры на момент проверки (2026-11-14): **13 разделов, 309 методов** — 202 read-only, 107 изменяющих, 11 файловых, 16 хостов `*.wildberries.ru`, 14 категорий токена.

> **WBD (Wildberries Цифровой)** — отдельный продукт со своим порталом и авторизацией; `sync.mjs` пробует его как опциональный модуль, но в Seller API его нет.

## Быстрый старт (3 шага)

1. **Создай токен** в кабинете продавца: Настройки → Интеграции по API → Создать токен.
   Категории — только те, что нужны. Для начала можно «Только чтение» (WB сам заблокирует любую запись).
2. **Установи и подключи** (из папки с репозиторием):
   ```bash
   node install.mjs --client all --token <WB_API_TOKEN>
   ```
   Установщик скопирует сервер в стабильную папку `~/.wb-mcp/app`, возьмёт **готовый каталог из GitHub Release**
   (один JSON, без сборки и парсинга) или соберёт его из официальных спеков, и пропишет сервер `wb` в конфиги
   найденных клиентов (старые конфиги бэкапятся).
3. **Перезапусти клиент** и напиши агенту: «покажи разделы WB API».

Дальше агент сам: `wb_search` → `wb_describe` → `wb_get` (чтение) / `wb_call` (запись).

### Один клик / по клиентам

| Клиент | Как поставить |
|---|---|
| **Claude Desktop** | скачать `wb-mcp.mcpb` из [Releases](../../releases) → двойной клик; токен вводится в окне Claude и хранится в его защищённом хранилище |
| **Claude Code** | `claude mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Codex CLI** | `codex mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Gemini CLI** | `gemini mcp add wb --env WB_API_TOKEN=<токен> -- node <путь>/server.mjs` |
| **Cursor** | [Установить в Cursor](https://cursor.com/install-mcp?name=wb&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi1wIiwiZ2l0aHViOkdyZWdvcnktbWNiaXQvd2lsZGJlcnJpZXMtbWNwIiwid2ItbWNwIl0sImVudiI6eyJXQl9BVVRPX1NZTkMiOiIxIiwiV0JfQVBJX1RPS0VOIjoiUEFTVEVfWU9VUl9XQl9BUElfVE9LRU4ifX0%3D) — или `node install.mjs --client cursor --token <токен>` |
| **VS Code** | [Установить в VS Code](vscode:mcp/install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22-p%22%2C%22github%3AGregory-mcbit%2Fwildberries-mcp%22%2C%22wb-mcp%22%5D%2C%22env%22%3A%7B%22WB_AUTO_SYNC%22%3A%221%22%2C%22WB_API_TOKEN%22%3A%22PASTE_YOUR_WB_API_TOKEN%22%7D%7D) — или `node install.mjs --client vscode --token <токен>` |
| **Портативный ZIP** | `wb-mcp-portable.zip` из Releases: распаковать → `install.cmd` (Windows) / `install.sh` |
| **Всё сразу** | `node install.mjs --client all --token <токен>` |
| **Без установки** | `WB_API_TOKEN=<токен> WB_AUTO_SYNC=1 npx -y -p github:Gregory-mcbit/wb-mcp wb-mcp` |

Deeplink-кнопки кладут в клиент конфиг с запуском через `npx` и `WB_AUTO_SYNC=1`; токен там —
плейсхолдер `PASTE_YOUR_WB_API_TOKEN`, его нужно заменить на свой (в ссылку токен не встраивается
по соображениям безопасности).

**Токен не хранится в открытом виде в конфигах.** `install.mjs` шифрует его (AES-256-GCM) в
`~/.wb-mcp/token.enc`, ключ — в `~/.wb-mcp/token.key` (права 600), а в конфиг клиента пишется только
путь: `WB_TOKEN_FILE=...`. В `.mcpb`-сценарии токен хранит Claude. Старое поведение — флаг
`--plain-token`. Честное ограничение: это защита от утечки конфига/скриншотов/синка dotfiles, но не
от вредоносного ПО под тем же пользователем.

**Для агентов со skills:** в репозитории есть `skills/wb-mcp/SKILL.md` — агент (Claude Code, Cursor,
Codex) может прочитать его и поставить сервер сам через `npx skills add Gregory-mcbit/wildberries-mcp`.

### npm и MCP Registry

Пакет публикуется в npm как **`wb-mcp`**, а карточка — в официальном реестре MCP
(`io.github.gregory-mcbit/wb-mcp`). После публикации установка одной командой:

```bash
npx -y -p wb-mcp wb-mcp-install --client all --token <WB_API_TOKEN>
```

```text
npm:          https://www.npmjs.com/package/wb-mcp
MCP Registry: https://registry.modelcontextprotocol.io  (поиск: wb-mcp)
```

### Установка без репозитория (по ссылке на GitHub)

```bash
npx -y -p github:Gregory-mcbit/wb-mcp wb-mcp-install --client all --token <WB_API_TOKEN>
```

Файлы всё равно скопируются в `~/.wb-mcp/app`, поэтому временный кэш npx не нужен после установки.

### Публикация репозитория (для владельца, локальная утилита)

В этом окружении `git push` не работает (TLS-стек Windows не отдаёт кредиты), поэтому публикация идёт
через GitHub REST API. Публикуются только файлы из манифеста `.publish` — roadmap, утилита публикации,
скачанные спеки и сгенерированный каталог остаются локальными.

```bash
# токен: fine-grained PAT с правами Contents: write + Administration: write (или классический scope repo)
GITHUB_TOKEN=github_pat_... node publish-gh.mjs --dry-run   # проверить токен и список файлов
GITHUB_TOKEN=github_pat_... node publish-gh.mjs            # создать репо и запушить
```

Скрипт сам создаёт репозиторий `wb-mcp` (или обновляет существующий), загружает файлы через Git Data API,
ставит описание и topics, и подставляет в README, AGENT-INSTALL и package.json реальные ссылки на репозиторий
и deeplink'и Cursor/VS Code.

## Подключение вручную

**Cursor** — `~/.cursor/mcp.json` (Windows: `C:\Users\<ты>\.cursor\mcp.json`):

```json
{
  "mcpServers": {
    "wb": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/Users/<ты>/.wb-mcp/app/server.mjs"],
      "env": { "WB_API_TOKEN": "eyJhbGci..." }
    }
  }
}
```

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), формат тот же.

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.wb]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/Users/<ты>/.wb-mcp/app/server.mjs"]
env = { "WB_API_TOKEN" = "eyJhbGci..." }
```

**VS Code (Copilot)** — `%APPDATA%\Code\User\mcp.json`, формат как у Cursor.

> `command` лучше указывать абсолютным путём к `node` — GUI-приложения часто не видят `node` из PATH.

## Инструменты (8 вместо 1000+)

| Инструмент | Назначение |
|---|---|
| `wb_search` | найти метод по словам: `{"query":"остатки"}`; фильтры `section`, `mode` (read/write), `limit` |
| `wb_describe` | полная схема метода: URL, параметры, тело, ответ, лимиты, типы токенов, пример вызова |
| `wb_get` | **read-only вызов** (чтения, диагностика, отчёты) — без подтверждения в клиенте |
| `wb_call` | **изменяющий вызов** (цены, карточки, заказы, ответы) — клиент спрашивает подтверждение |
| `wb_sections` | обзор каталога: разделы, число методов, состояние токенов |
| `wb_token_info` | локальный разбор JWT: тип, срок, категории, «только чтение» |
| `wb_request` | сырой запрос к `*.wildberries.ru` — для методов, которых ещё нет в каталоге |
| `wb_refresh` | пересобрать каталог из свежих спеков WB |

Почему не 1000 отдельных tools: MCP-клиент показывает модели все описания инструментов, и 1000 схем съедят контекст. Поиск + схема по требованию даёт полное покрытие при 8 инструментах.

## Prompts и Resources (полноценный MCP)

Кроме Tools сервер использует ещё два primitive MCP:

**Prompts** — готовые сценарии, клиент показывает их как slash-команды:

| Prompt | Что делает |
|---|---|
| `sales-accelerator` | **разгон продаж**: воронка/CTR, контент, SEO, цены, реклама, акции, остатки, отзывы → потери в ₽ и план на 7/30 дней |
| `diagnose-orders-drop` | почему упали заказы: заказы/продажи, воронка, остатки, реклама, блокировки |
| `check-stock` | товары с нулевым/низким остатком |
| `reply-reviews` | неотвеченные отзывы и вопросы + подготовка ответов |
| `weekly-report` | сводка за неделю |

Это и есть «вызови этот инструмент, если…» — пошаговые планы с реальными id методов.

**Resources** — данные без tool-вызова: `wb://catalog/index`, `wb://sections/<key>`, `wb://method/<id>`; есть `resources/subscribe` + `notifications/resources/updated` (после `wb_refresh`).

Плюс `structuredContent` + `outputSchema` у `wb_search`/`wb_sections`/`wb_token_info` и `notifications/progress` для долгих вызовов.

Пример сценария в чате:

```
— сколько денег на балансе?
  → wb_search {"query":"баланс"}          → getV1AccountBalance
  → wb_describe {"id":"getV1AccountBalance"}
  → wb_call {"id":"getV1AccountBalance"}  → JSON ответа WB
```

## Как это устроено

- `sync.mjs` скачивает 13 YAML-спеков WB, парсит их (`yaml.mjs`, zero-dep парсер YAML) и собирает `catalog/`:
  `index.json` (лёгкий индекс для поиска) + `<module>.json` (полные схемы, грузятся лениво).
  Флаг `--bundle-out` пакует каталог в один JSON для релиза, `--from-bundle` разворачивает обратно.
- Из спеки берутся **официальные** поля: `x-readonly-method`, `x-category`, `x-token-types`,
  `servers`, схемы параметров/тел/ответов и **таблицы лимитов из описаний**.
- Хост метода берётся из `servers` самой спеки (WB переносит эндпоинты между доменами, например
  реклама → `advert-media-api`, календарь акций → `dp-calendar-api`), а `x-category` используется как
  запасной маппинг для путей, где перечислены сразу все хосты.
- Сборка **устойчивая**: если один модуль не скачался/не распарсился, каталог собирается из остальных,
  а пробел виден в `wb_sections` (`coverage.missingModules`) и в `index.json`. Флаг `--strict` превращает
  это в ошибку. `node verify.mjs` проверяет структуру и полноту покрытия.
- `server.mjs` — MCP по stdio: JSON-RPC, dual-era протокол, 7 инструментов, HTTP-клиент к WB,
  rate limiter, ретраи, сохранение больших ответов в `~/.wb-mcp/`.
- `install.mjs` — установка: копирование в `~/.wb-mcp/app`, сборка каталога, правка конфигов клиентов.

## Запись в WB: по умолчанию разрешена

По умолчанию сервер **не ограничивает** изменяющие методы (так задумано). Защита выстраивается на трёх уровнях:

1. **Токен WB**: можно выдать токен с режимом «Только чтение» — WB физически отклонит любую запись (403), независимо от сервера. Самый надёжный уровень.
2. **Сервер**: `wb_token_info` видит бит «только чтение» в токене и заранее блокирует write-методы с понятным сообщением.
3. **Режим**: `WB_READONLY=1` в env — полностью запрещает изменяющие методы на стороне сервера.

Перед методами записи агент предупреждает пользователя (это прописано в описаниях инструментов).

## Диагностика: `doctor`

```bash
node doctor.mjs          # человеческий отчёт
node doctor.mjs --json   # JSON для агента/скриптов
```

Проверяет: Node ≥ 20, каталог (309 методов, покрытие 13/13, структура), токен (срок, категории,
read-only), сеть до `dev.wildberries.ru` и `api.github.com`, конфиги Cursor/Claude/Codex/VS Code,
установку в `~/.wb-mcp/app`. Код выхода: 0 — всё ок (warn допустимы), 1 — есть fail.

## Офлайн-каталог из релиза

В GitHub Release прикладывается `catalog.bundle.json` (все 309 методов одним JSON). Установщик
скачивает его и разворачивает в `catalog/` — установка не требует парсинга спеков. Флаги:

```bash
node install.mjs --client all --token <TOKEN>            # реюз релиза, иначе сборка из спеков
node install.mjs --client all --no-release               # всегда собирать из официальных спеков
node install.mjs --client all --bundle ./catalog.bundle.json  # из локального бандла (полностью офлайн)
node install.mjs --client all --repo owner/name          # указать репозиторий для релиза
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `WB_API_TOKEN` | — | токен WB (обязателен для `wb_call`/`wb_get`), если не используется `WB_TOKEN_FILE` |
| `WB_TOKEN_FILE` | — | путь к зашифрованному токену (`~/.wb-mcp/token.enc`), пишет `install.mjs` |
| `WB_TOKEN_KEY` | рядом с токеном | путь к ключу шифрования (`token.key`) |
| `WB_AUTO_SYNC` | `0` | `1` — собрать каталог при старте, если его нет (режим `npx github:...`) |
| `WB_ACCOUNTS` | — | несколько токенов: `{"shop1":"token1","shop2":"token2"}`; выбор через `account` |
| `WB_READONLY` | `0` | `1` — запретить все изменяющие методы |
| `WB_MCP_CATALOG` | `./catalog` | папка с каталогом |
| `WB_MCP_HOME` | `~/.wb-mcp` | куда сохранять файлы/логи (`downloads/`, `out/`) |
| `WB_MAX_OUTPUT` | `80000` | сколько символов ответа максимум отдавать в контекст |
| `WB_MAX_WAIT_MS` | `120000` | сколько максимум ждать лимит WB внутри вызова |
| `WB_HTTP_TIMEOUT_MS` | `120000` | таймаут одного HTTP-запроса |
| `WB_RATE_LIMIT` | — | `off` — отключить ожидание лимитов (только для тестов/бенчмарков) |
| `WB_ALLOW_ANY_HOST` | `0` | `1` — разрешить запросы не на `*.wildberries.ru` (только для тестов) |

## Обновление под изменения WB

```bash
node ~/.wb-mcp/app/sync.mjs        # пересобрать каталог из официальных спеков
node ~/.wb-mcp/app/verify.mjs      # проверить структуру и полноту покрытия
```

Или из чата: `wb_refresh`. Перезапуск клиента не нужен.

## Проверка покрытия

```bash
node sync.mjs          # скачать спеки и собрать каталог
node verify.mjs        # проверить: 13/13 модулей, уникальные id, хосты, суммы
```

`verify.mjs` печатает JSON (coverage, operations по модулям, список хостов и категорий) и падает с
кодом 1, если обязательный модуль отсутствует или каталог структурно битый.

## Безопасность

- Токен используется только в заголовке `Authorization` к хостам `*.wildberries.ru`; другой хост блокируется до запроса.
- Тела запросов/ответов не пишутся в логи — только статус, путь и ошибки.
- Большие ответы сохраняются локально в `~/.wb-mcp/`, а не уходят в контекст модели.
- Полный токен никогда не возвращается в ответах инструментов (только превью вида `eyJhbG…abcd`).

## Разработка

```bash
node test/yaml.test.mjs   # 10 тестов парсера YAML на реальной спеке WB
node test/sync.test.mjs   # 7 тестов сборщика каталога (кандидаты slug, tolerant/strict)
node test/mcp.test.mjs    # 29 тестов MCP: tools, prompts, resources, progress, HTTP на моке WB
node test/publish.test.mjs # 7 тестов публикатора (мок GitHub API, релиз с каталогом)
node test/package.test.mjs # 8 тестов упаковки/zero-dep инварианта
node test/bundle.test.mjs  # 3 теста офлайн-бандла каталога
node test/doctor.test.mjs  # 6 тестов диагностики
```

Тесты не ходят в интернет: поднимают мок-WB и запускают сервер в процессе.

Структура:

```
server.mjs        MCP-сервер (фабрика createMcpServer + stdio entrypoint)
sync.mjs          сборка каталога из официальных OpenAPI-спеков + bundle для релиза
yaml.mjs          zero-dependency YAML-парсер (подмножество OpenAPI)
search.mjs        поиск: стемминг, синонимы, ключевые слова
tokens.mjs        локальный разбор JWT WB (общий для сервера/doctor/install)
verify.mjs        проверка каталога и покрытия
doctor.mjs        самодиагностика: Node, каталог, токен, сеть, конфиги клиентов
install.mjs       установка + правка конфигов Cursor/Claude/Codex/VS Code
catalog/          генерируется sync.mjs (в git не хранится)
test/             тесты на моке, без сети
```

## Ограничения

- Сборка каталога требует доступ к `dev.wildberries.ru` (один раз при установке).
- `multipart/form-data` (загрузка файлов) не поддерживается — только JSON; для загрузки файлов используй официальный портал.
- Тестовый токен WB работает только с песочницей: сервер по умолчанию ходит на продакшн-хосты.
- Методы, у которых WB временно отключил эндпоинт, вернут ошибку WB — это не баг каталога.

## Лицензия

MIT — см. [LICENSE](./LICENSE).
