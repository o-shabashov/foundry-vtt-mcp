# Pepel fork: контракт новых инструментов моста

Ветка `pepel` форка `o-shabashov/foundry-vtt-mcp`. Цель: полноценный импорт/экспорт актёров
с activities (dnd5e 5.x, Foundry v14), работа с компендиумами мира, сырые правки предметов
и escape-hatch для JS в ГМ-клиенте. Плюс надёжный реконнект модуля.

Две стороны, один контракт:

- **Модуль** (`packages/foundry-module`) - обработчики в `CONFIG.queries` под ключами
  `foundry-mcp-bridge.raw.*` (в коде апстрима имена raw.*, файлы raw-actor.ts / raw-handlers.ts). Работают внутри ГМ-клиента Foundry, имеют `game`.
- **MCP-сервер** (`packages/mcp-server`) - tool definitions + dispatch в `backend.ts`,
  гидрация `filePath`/`outFile` в обёртке `index.ts`.

Правило Отклонений: открытый вопрос не блокирует - бери дефолт из этого файла, любое
отступление от дефолта или от буквы ТЗ фиксируй в разделе «Отклонения» итогового отчёта.

Снимок кода: коммит `68f18ce` (upstream master, 2026-09-02). Строки в ссылках могут
съехать - сверяйся с текущим кодом.

---

## 1. Общие соглашения

- Все ответы модуля - plain JSON, сериализуемый `JSON.stringify`. Ошибки бросать `Error`
  с человекочитаемым текстом; сервер их оборачивает как остальные инструменты.
- GM-гейт: каждый обработчик начинается с `validateGMAccess()` (как в `queries.ts:17`).
  Пишущие обработчики дополнительно проверяют world-настройку `allowWriteOperations`
  (сейчас `true`); при `false` - `{ success:false, error:'Write operations disabled' }`.
- Идентификатор актёра `actorIdentifier` резолвится в таком порядке: UUID (`fromUuid`,
  работает и для записей компендиума `Compendium.world.xxx.Actor.id`), затем id в
  `game.actors`, затем точное имя в `game.actors`, затем регистронезависимое частичное
  совпадение имени. Неоднозначность (несколько частичных) - ошибка со списком кандидатов.
- Идентификатор компендиума `pack` резолвится: `game.packs.get(id)` (например
  `world.pepel-bestiary`), затем по `metadata.label` (точное), затем по `metadata.name`.
- Залоченный компендиум для пишущей операции временно разлочивается
  (`pack.configure({locked:false})`) и возвращается в прежнее состояние в `finally`.
- Большие payload'ы (актёр с 60 предметами ~ 250 KB) ходят по WebSocket одним JSON.
  Ничего не чанковать на нашей стороне; WebRTC-ветка вне контракта.

### Формат ActorData

Полный source-объект актёра Foundry, как его отдаёт `actor.toObject()`:

```
{ name, type, img?, system?, items?: ItemData[], effects?: EffectData[],
  prototypeToken?, flags?, ownership?, folder?, sort?, _id?, _stats? }
```

- `folder` из данных игнорируется (папку задаёт destination).
- `_id` вырезается, если не `keepId`.
- `_stats` вырезается всегда (Foundry ставит сам).
- `items[]` - полные source-объекты предметов, включая `system.activities` (объект по id
  activity) - передаются в `Actor.createDocuments` как есть, вложенные `_id` предметов
  сохраняются при `keepId`, иначе вырезаются (Foundry сгенерирует).

---

## 2. Запросы модуля (`CONFIG.queries`)

### 2.1 `foundry-mcp-bridge.pepel.importActors`

Вход:

```
{
  actors: ActorData[],                         // 1..50
  destination:
    | { type: 'world', folder?: string }       // folder - имя папки Actor; создать, если нет
    | { type: 'pack', pack: string },          // компендиум мира или модуля
  replace?: 'byName' | 'none',                 // дефолт 'byName'
  keepId?: boolean                             // дефолт false
}
```

Поведение:

- `world`: папка через `getOrCreateFolder`-подобную логику (референс:
  `data-access.ts:7138`). Дефолт папки, если не задана: `'Пепел'`.
- `pack`: `Actor.implementation.createDocuments(docs, { pack: pack.collection, keepId })`.
- `replace: 'byName'`: перед созданием найти в destination документы с тем же `name`
  (в мире - только внутри целевой папки; в паке - по индексу) и удалить их. Удалённые
  вернуть в `replaced`.
- Ошибка одного актёра не прерывает остальных: собирать в `errors`.

Выход:

```
{ created: [{ id, name, uuid }], replaced: [{ id, name, uuid }],
  errors: [{ name, error }], destination: { type, folder?|pack? } }
```

### 2.2 `foundry-mcp-bridge.pepel.exportActor`

Вход: `{ actorIdentifier: string, pack?: string }` - если задан `pack`, искать по имени/id в
нём, иначе по правилу резолва из п.1.

Выход: `{ uuid, name, type, itemCount, data: actor.toObject() }`.

### 2.3 `foundry-mcp-bridge.pepel.manageCompendium`

Вход:

```
{
  action: 'list' | 'create' | 'contents' | 'delete-entries' | 'lock' | 'unlock' | 'delete-pack',
  pack?: string,                 // для всех кроме list/create
  label?: string,                // create: отображаемое имя, например 'Пепел: бестиарий'
  name?: string,                 // create: машинное имя, дефолт - slug от label (латиница/дефисы)
  documentType?: 'Actor' | 'Item' | 'JournalEntry' | 'Scene' | 'RollTable' | 'Macro', // create, дефолт 'Actor'
  entryIds?: string[], entryNames?: string[]   // delete-entries
}
```

- `list` → `[{ collection, label, type, locked, size, package: 'world'|'module'|'system', packageName }]`.
- `create` → `CompendiumCollection.createCompendium({ type, label, name })`; брать класс
  как `foundry.documents.collections.CompendiumCollection ?? CompendiumCollection`.
  Если пак с таким `name` уже есть в мире - вернуть его, не падать (`{ existed: true }`).
- `contents` → `pack.getIndex()` → `[{ _id, name, type, img, uuid }]`.
- `delete-entries` → удалить по id или по точному имени; вернуть `{ deleted: [...], notFound: [...] }`.
- `lock` / `unlock` → `pack.configure({ locked })`.
- `delete-pack` → только для `metadata.packageType === 'world'`, иначе ошибка.

### 2.4 `foundry-mcp-bridge.pepel.manageActorItems`

Вход:

```
{
  actorIdentifier: string,
  action: 'list' | 'create' | 'update-raw' | 'delete',
  items?: ItemData[],                         // create - полные source-объекты
  updates?: Array<{ _id: string, [key: string]: any }>, // update-raw
  itemIds?: string[]                          // delete
}
```

- `list` → `[{ _id, name, type, img, uses: { max, spent, recovery }, activities: [{ _id, type, name, activation }] , compendiumSource }]`
  (`compendiumSource` из `_stats.compendiumSource`, может быть null).
- `create` → `actor.createEmbeddedDocuments('Item', items)` как есть (без фильтрации
  полей, кроме `_id`, если не `keepId` - тут `keepId` не поддерживаем, `_id` вырезать).
- `update-raw` → `actor.updateEmbeddedDocuments('Item', updates)` **verbatim**: dotted-ключи
  (`"system.uses.max": "3"`) и удаление ключей (`"system.activities.-=abc123": null`)
  должны доходить до Foundry без слияния на нашей стороне. Это принципиальное отличие от
  существующего `updateActorItems` (`data-access.ts:9869`), который сливает `system`
  верхним уровнем.
- `delete` → `actor.deleteEmbeddedDocuments('Item', itemIds)`.

Выход: `{ actorId, actorName, result: <массив id/имён по операции> }`.

### 2.5 `foundry-mcp-bridge.pepel.updateActor`

Вход: `{ actorIdentifier: string, update: Record<string, any> }` → `actor.update(update)`
verbatim (dotted-ключи, `-=`). Выход: `{ id, name, uuid }`.

Отличие от существующего `updateActors`: тот заменяет вложенные объекты `system.*`
целиком (`data-access.ts` / `queries.ts:2022`), что для `system.attributes.hp.max`
затирает весь `attributes`.

### 2.6 `foundry-mcp-bridge.pepel.runScript`

Вход: `{ script: string, args?: any, timeoutMs?: number }` (дефолт таймаута 60000).

Поведение: `const fn = new (Object.getPrototypeOf(async function(){}).constructor)('args', script)`;
`await fn(args)` с гонкой против таймаута. Скрипт - тело async-функции, `return` отдаёт
результат. Результат должен быть JSON-сериализуемым; если нет - вернуть `String(result)`
с флагом `serialized: false`.

Выход: `{ ok: true, result, durationMs }` или `{ ok: false, error, stack }`. Ошибку не
бросать - возвращать в теле, чтобы stack дошёл до вызывающего.

Гейт: GM + `allowWriteOperations`.

### 2.7 `foundry-mcp-bridge.pepel.bridgeInfo`

Вход: `{}`. Выход: `{ user: game.user.name, userId, isGM, world: game.world.id, system: game.system.id,
systemVersion, coreVersion, moduleVersion, connectionType, actAsBridge, url: window.location.origin }`.
Нужен для диагностики «кто именно сейчас мост».

---

## 3. Изменения модуля помимо обработчиков

### 3.1 Реконнект без потолка

- `socket-bridge.ts:scheduleReconnect` - убрать остановку по `maxReconnectAttempts`.
  Backoff как сейчас (`min(1000 * 2^n, 30000)`), после достижения 30 с - ровно каждые 30 с.
  Логировать каждую 10-ю попытку, не каждую.
- `main.ts:performHeartbeat` - при отключённом сокете вызывать `restart()` на каждом
  heartbeat (интервал `heartbeatInterval`), никогда не переключать `autoReconnectEnabled`
  в `false` и не показывать warn-уведомление «Auto-reconnect disabled».
- `start()` при ECONNREFUSED: уведомление «MCP Server not found» показывать не чаще раза в
  10 минут (сейчас 30 с).

### 3.2 Client-scope настройка `actAsBridge`

- `settings.ts`: `game.settings.register(MODULE_ID, 'actAsBridge', { scope: 'client',
config: true, type: Boolean, default: true, name: 'Act as MCP bridge client', hint: 'Only
this browser connects to the MCP server. Untick on GM clients that should stay passive.' })`.
- `main.ts:start()` - если `actAsBridge === false`: лог, состояние `disconnected`, выход без
  ошибки. Heartbeat не стартует. Хук `closeSettingsConfig` учитывает новое значение
  (включили - подключаемся, выключили - `stop()`).

### 3.3 Новый файл, минимум правок апстрима

Обработчики `pepel.*` держать в новом файле `packages/foundry-module/src/pepel-handlers.ts`
(класс `PepelHandlers` с `registerHandlers()`), из `queries.ts:registerHandlers` - один
вызов. Так мержи апстрима будут проходить почти без конфликтов.

### 3.4 `module.json`

- `version`: `0.8.4`
- `manifest`: `https://raw.githubusercontent.com/o-shabashov/foundry-vtt-mcp/pepel/packages/foundry-module/module.json`
- `download`: `https://github.com/o-shabashov/foundry-vtt-mcp/releases/latest/download/foundry-vtt-mcp.zip`
- `compatibility.verified`: `14`

---

## 4. Инструменты MCP-сервера

Новый класс `PepelTools` в `packages/mcp-server/src/tools/pepel.ts` (паттерн -
`tools/actor-management.ts`): `getToolDefinitions()` + `handleX(args)`; регистрация в
`backend.ts` рядом с `actorManagementTools` (allTools + switch).

| Tool                 | Args                                                                          | Query модуля             |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| `import-actor`       | `{ actors?: ActorData[], filePath?: string, destination, replace?, keepId? }` | `pepel.importActors`     |
| `export-actor`       | `{ actorIdentifier, pack?, outFile?: string }`                                | `pepel.exportActor`      |
| `manage-compendium`  | как 2.3                                                                       | `pepel.manageCompendium` |
| `manage-actor-items` | как 2.4 + `filePath?` (для `items`/`updates`)                                 | `pepel.manageActorItems` |
| `update-actor-raw`   | `{ actorIdentifier, update?, filePath? }`                                     | `pepel.updateActor`      |
| `run-script`         | `{ script?, scriptFile?: string, args?, timeoutMs? }`                         | `pepel.runScript`        |
| `bridge-info`        | `{}`                                                                          | `pepel.bridgeInfo`       |

Описания инструментов - на английском, в стиле остальных, с явной пометкой в
`import-actor`: «full Foundry actor source including items with activities; the recommended
way to create monsters with legendary actions, recharge, templates and spell links».

Валидация входа - `zod`, как в соседних инструментах. `filePath` и `actors` в
`import-actor` взаимоисключающи (ровно один). JSON в файле - либо один объект актёра, либо
массив.

### 4.1 Гидрация файлов в обёртке `index.ts`

Файлы лежат на машине, где запущен Claude Code (обёртка `index.ts`), а backend в будущем
может уехать на другой хост. Поэтому чтение/запись файлов делает **обёртка**, до
пересылки `call_tool` в backend:

- `filePath` (import-actor, manage-actor-items, update-actor-raw) → прочитать JSON, положить
  в соответствующее поле (`actors` / `items`|`updates` / `update`), удалить `filePath`.
  Ошибка чтения/парсинга → ответ инструмента с `isError`, без похода в backend.
- `scriptFile` (run-script) → прочитать текст в `script`.
- `outFile` (export-actor) → после ответа backend'а записать `result.data` (pretty JSON,
  2 пробела, UTF-8) в файл, каталог создать; в ответ пользователю вернуть только
  `{ uuid, name, type, itemCount, bytes, outFile }` без `data`.

Вынести это в чистую функцию `hydrateToolArgs(name, args)` / `dehydrateToolResult(name, args, result)`
в `packages/mcp-server/src/tool-files.ts` и покрыть vitest-тестами (временные файлы).
Backend о файлах не знает; поля `filePath`/`outFile`/`scriptFile` в схемах инструментов
описаны, но backend их игнорирует.

### 4.2 Ограничение размера ответа

`export-actor` без `outFile` и `manage-actor-items list` могут вернуть сотни KB. Если
`JSON.stringify(result).length > 200_000` и `outFile` не задан - вернуть ошибку с советом
задать `outFile`. Порог - константа.

---

## 5. Проверки перед сдачей

- `npm run typecheck` в корне (оба пакета).
- `npm run lint` без новых ошибок в изменённых файлах.
- `npm run test --workspace=packages/mcp-server` (vitest) зелёный, включая новые тесты
  `tool-files`.
- `node scripts/mcp-schema-smoke-test.mjs` проходит с новыми инструментами.
- Сборка: `npm run build`.

Живой прогон с Foundry делает интегратор (не исполнители).

---

## 6. Отчёт исполнителя

Разделы: что сделано (файлы), что проверено (команды и вывод), **Отклонения** (каждое
отступление от дефолта/ТЗ, расширения сверх ТЗ с пометкой «сверх ТЗ»), открытые вопросы.
