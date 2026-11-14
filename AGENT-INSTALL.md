# AGENT-INSTALL.md — инструкция для AI-агента

Ты — агент (Claude Code, Cursor, Codex, Copilot и т.п.). Пользователь дал тебе ссылку на этот
репозиторий и попросил подключить сервер `wb-mcp`. Выполняй шаги ниже по порядку. Не изобретай
свои команды и не устанавливай сторонние пакеты — сервер zero-dependency.

Ссылка на репозиторий: `https://github.com/Gregory-mcbit/wildberries-mcp`.

## 0. Что тебе нужно от пользователя

1. **Токен WB API.** Спроси его, если не передан. Где взять:
   кабинет продавца → Настройки → Интеграции по API → Создать токен.
   Рекомендуй для начала режим «Только чтение» и только необходимые категории.
2. **Где лежит репозиторий** (если ты не запущен в нём): клонируй во временную папку.

Правила безопасности:
- не выводи токен в чат, в терминал и в логи; передавай его только через `--token` или переменную окружения `WB_API_TOKEN`;
- не отправляй токен на сторонние URL;
- не устанавливай npm-пакеты для работы сервера — они не нужны.

## 1. Проверь Node.js

```bash
node --version
```

Нужен **Node.js >= 20**. Если версия меньше или node отсутствует — попроси пользователя установить Node.js LTS и остановись.

## 2. Клонируй репозиторий (если нужно)

```bash
git clone https://github.com/Gregory-mcbit/wildberries-mcp wb-mcp
cd wb-mcp
```

Если папка уже есть — перейди в неё.

## 3. Запусти установщик

Одна команда делает всё: копирует сервер в стабильную папку `~/.wb-mcp/app`, скачивает официальные
OpenAPI-спеки WB, собирает каталог методов и прописывает сервер `wb` в конфиги клиентов.

```bash
node install.mjs --client all --token "<WB_API_TOKEN>"
```

После публикации в npm то же самое короче (без клонирования):

```bash
npx -y -p wb-mcp wb-mcp-install --client all --token "<WB_API_TOKEN>"
```

Полезные варианты:

```bash
node install.mjs --client cursor  --token "<TOKEN>"   # только Cursor
node install.mjs --client claude  --token "<TOKEN>"   # только Claude Desktop
node install.mjs --client codex   --token "<TOKEN>"   # только Codex CLI
node install.mjs --client vscode  --token "<TOKEN>"   # только VS Code
node install.mjs --dry-run --client all --token "<TOKEN>"   # показать, что будет записано
node install.mjs --client all --skip-sync            # без сборки каталога (потом node ~/.wb-mcp/app/sync.mjs)
```

Ожидаемый результат в выводе:
- `файлы сервера скопированы в .../.wb-mcp/app`
- `токен сохранён зашифрованно: .../.wb-mcp/token.enc` (в конфигах только `WB_TOKEN_FILE`, не сам токен)
- `каталог из GitHub Release ...` **или** `каталог собран: 13 разделов, 309 методов`
- `Cursor: записано в ...`, `Claude Desktop: записано в ...`, `Claude Code: ...`, `Codex CLI: ...`,
  `Gemini CLI: ...`, `VS Code: ...`
- итоговая строка `Готово. Что дальше:`

Альтернатива установщику для Claude Desktop — `wb-mcp.mcpb` из GitHub Releases (двойной клик,
токен вводится в окне Claude). Для Claude Code/Codex/Gemini можно и без установщика:
`claude mcp add wb --env WB_API_TOKEN=<TOKEN> -- node <path>/server.mjs` (аналогично `codex mcp add`,
`gemini mcp add`).

Если появилось `ВНИМАНИЕ: не собраны модули: ...` — часть спек WB недоступна (переименование или
сетевые ограничения). Сервер всё равно работает; сообщи пользователю список пропущенных модулей.
Опциональный `14-wbd` — это отдельный продукт (Wildberries Цифровой), его отсутствие нормально.

Если каталог не собрался (нет интернета/прокси) — установка продолжится, но сервер будет отвечать
ошибкой с просьбой выполнить `node ~/.wb-mcp/app/sync.mjs`. Передай это пользователю.

## 4. Проверь каталог (покрытие)

```bash
node ~/.wb-mcp/app/verify.mjs
node ~/.wb-mcp/app/doctor.mjs
```

Ожидаемо: verify → `"requiredModules": 13, "builtModules": 13`, `"total": 309`, `"problems": []`.
doctor → `✅ Каталог WB API`, `✅ Сеть до dev.wildberries.ru`; `⚠️ Токен` допустим только если токена нет.
Если `doctor` вернул код 1 или `problems` не пуст — запусти `node ~/.wb-mcp/app/sync.mjs` ещё раз
и передай вывод пользователю.

Если установщик написал `каталог из GitHub Release` — каталог взят готовым, без сборки спеков.
Если `релиз с каталогом недоступен` — это нормально: он собрал каталог из официальных спеков.

## 5. Проверь, что конфиг валиден

- **JSON-клиенты (Cursor / Claude / VS Code)**: в конфиге должен появиться блок `mcpServers.wb`
  с `command` (абсолютный путь к node), `args: ["<...>/.wb-mcp/app/server.mjs"]` и `env.WB_API_TOKEN`.
- **Codex**: в `~/.codex/config.toml` должен появиться ровно один блок `[mcp_servers.wb]`
  (повторный запуск установщика не должен дублировать секцию).

Файлы конфигов:
- Cursor: `~/.cursor/mcp.json` (Windows `%USERPROFILE%\.cursor\mcp.json`)
- Claude Desktop: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
- Codex: `~/.codex/config.toml`
- VS Code: Windows `%APPDATA%\Code\User\mcp.json`

## 5. Скажи пользователю перезапустить клиент
MCP-сервер подхватывается только при старте клиента:

- Cursor: перезапустить приложение (или переподключить MCP в настройках).
- Claude Desktop: полностью закрыть (Quit из трея) и открыть заново.
- Codex: перезапустить `codex`.
- VS Code: перезагрузить окно.

## 6. Проверка после перезапуска (выполни как агент в новом чате)

1. Вызови `wb_sections` — должен вернуться JSON с `catalog.modules` (13 разделов) и `accounts`.
2. Вызови `prompts/list` — должны быть 5 сценариев (`sales-accelerator`, `diagnose-orders-drop`, `check-stock`, `reply-reviews`, `weekly-report`).
3. Вызови `wb_token_info` — проверь `readOnly`, `expiresInDays`, `categories`; сообщи пользователю,
   если токен просрочен или не имеет нужных категорий.
4. Вызови `wb_get` с `{"id":"getPing"}` — должен прийти HTTP 200 и JSON от WB (read-only, без подтверждений).
5. Сообщи пользователю: «WB MCP подключён, N методов в каталоге», и предложи примеры запросов.

## 7. Если что-то не работает

| Симптом | Что делать |
|---|---|
| В клиенте нет сервера `wb` | Проверить путь к конфигу и перезапустить клиент; запустить `node install.mjs --dry-run --client <клиент>` |
| `Каталог не найден ... sync.mjs` | Выполнить `node ~/.wb-mcp/app/sync.mjs`, проверить интернет |
| `Нет токена Wildberries` | Добавить `"WB_API_TOKEN"` в `env` блока сервера в конфиге |
| `WB API вернул 401` | Токен истёк/неверный — создать новый |
| `WB API вернул 403` | Категория или тип токена не подходит, либо токен read-only; смотри `wb_token_info` |
| `WB API вернул 429` | Лимит WB; сервер сам ждёт по `X-Ratelimit-Retry`, при повторной ошибке подожди минуту |
| Метод не найден | Сначала `wb_search`; затем `wb_refresh`, затем `wb_search` заново |
| `ВНИМАНИЕ: не собраны модули` | WB переименовал файл спеки: запусти `node sync.mjs --verbose`, найди slug на `dev.wildberries.ru/swagger` и добавь его в `MODULES` в `sync.mjs` (или сообщи пользователю) |
| `multipart/form-data не поддерживается` | Загрузка файлов через этот сервер не делается — только через кабинет WB |

## 8. чего НЕ делать

- Не запускай `server.mjs` вручную «чтобы проверить» — это stdio-сервер, он ждёт JSON-RPC на stdin и на вид «зависает».
- Не добавляй сервер дважды под разными именами в конфиг.
- Не публикуй токен и не коммить конфиг клиента в git.
- Не заменяй `command` на голое `node`, если у пользователя нестандартный PATH: установщик специально пишет абсолютный путь.
