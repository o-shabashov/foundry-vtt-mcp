# Session tools: контракт (файлы, сцены, свет и стены, плейлисты, журналы, права, бой, чат, таблицы, лут)

Цель: подготовить сессию целиком через MCP: залить карты и музыку, создать сцены с сеткой, светом, стенами и токенами, хэндауты с правами игрокам, плейлисты, бой, зачитки в чат, таблицы и кучи лута. Код и имена - общие (без «pepel»), чтобы уйти вторым PR в апстрим; эта спека - рабочий документ форка.

Правило Отклонений: открытый вопрос не блокирует - бери дефолт из этого файла, любое отступление от дефолта или буквы ТЗ фиксируй в разделе «Отклонения» итогового отчёта.

Снимок кода: ветка `pepel` на `1c26876` (= PR-ветка `feat/raw-actor-tools` + форковый коммит). Референсы: `packages/foundry-module/src/raw-handlers.ts` (стиль обработчиков, `checkAccess`, резолв актёров/паков, `withUnlockedPack`), `packages/mcp-server/src/tools/raw-actor.ts` (стиль tool definitions, zod), `packages/mcp-server/src/tool-files.ts` (гидрация файлов в обёртке), `packages/mcp-server/src/tools/raw-actor.test.ts`, `packages/mcp-server/src/tool-files.test.ts`.

Проверено в живом Foundry 14.360 + dnd5e 5.3.0 (2026-09-03), можно опираться:
- `foundry.applications.apps.FilePicker.implementation` имеет статические `upload(source, path, file, body, options)`, `browse(source, target, options)`, `createDirectory(source, target)`; глобальный алиас `FilePicker` тоже есть.
- `foundry.applications.apps.ImagePopout` - класс с методом экземпляра `shareImage()`.
- Схема Scene: `background` внутри... поля верхнего уровня: `name, active, navigation, navName, width, height, padding, initial, grid{type,size,style,thickness,color,alpha,distance,units}, tokenVision, fog, environment{darknessLevel, darknessLock, globalLight, cycle, base, dark}, playlist, playlistSound, journal, journalEntryPage, weather, folder, ownership`. Фон - `background.src` (поле `background` есть у Scene, в списке верхнего уровня не печаталось из-за фильтра; сверяйся с `Scene.schema.fields.background`).
- AmbientLight `config`: `negative, priority, alpha, angle, bright, color, coloration, dim, attenuation, luminosity, saturation, contrast, shadows, animation{type,speed,intensity,reverse}, darkness{min,max}`.
- Wall: `c[4], light, move, sight, sound, dir, door, ds, doorSound, threshold, animation`.
- Tile: `texture{src,...}, width, height, x, y, elevation, sort, rotation, alpha, hidden, locked, restrictions{light,weather}, occlusion{mode,alpha}`.
- Note: `entryId, pageId, x, y, elevation, sort, texture{src}, iconSize, text, fontFamily, fontSize, textAnchor, textColor, global`.
- `CONST.PLAYLIST_MODES = {DISABLED:-1, SEQUENTIAL:0, SHUFFLE:1, SIMULTANEOUS:2}`; Playlist поля `name, description, sounds, channel, mode, playing, fade, folder, sorting`; PlaylistSound `name, description, path, channel, playing, pausedTime, repeat, volume, fade, sort`.
- JournalEntryPage поля `name, type, system, title{show,level}, image{caption}, text{content,format,markdown}, video, src, category, sort, ownership`; типы страниц ядра `text, image, pdf, video` плюс системные `class, map, rule, spells, subclass`. `JournalEntry.prototype.show(force)` есть.
- Combat: `startCombat, nextTurn, previousTurn, rollInitiative, rollAll, rollNPC, endCombat`.
- item-piles: `game.itempiles.API.createItemPile(...)`, `turnTokensIntoItemPiles`, `openItemPile`, `lockItemPile` и др.
- `CONST.DOCUMENT_OWNERSHIP_LEVELS = {INHERIT:-1, NONE:0, LIMITED:1, OBSERVER:2, OWNER:3}`; `CONST.CHAT_MESSAGE_STYLES = {OTHER, OOC, IC, EMOTE}`.
- `foundry.canvas.loadTexture(path)` доступен для размеров картинки (в headless-клиенте canvas отключён, `loadTexture` всё равно грузит текстуру через PIXI без канваса; если упадёт - запасной путь `new Image()` + `onload`).
- Мост крутится в headless-клиенте без канваса (`core.noCanvas`): **`canvas.*` недоступен**, работать только через документы (`scene.createEmbeddedDocuments`, `game.scenes`, `game.playlists`...). Всё, что требует `canvas.ready`, помечать как недоступное с понятной ошибкой.

---

## 0. Общее

- Пространства имён запросов модуля: `foundry-mcp-bridge.files.*`, `scene.*`, `playlist.*`, `journal.*`, `ownership.*`, `combat.*`, `chat.*`, `table.*`, `piles.*`.
- Модуль: папка `packages/foundry-module/src/session/` с файлами `files-handlers.ts`, `scene-handlers.ts`, `playlist-handlers.ts`, `journal-handlers.ts`, `combat-chat-handlers.ts`, `loot-handlers.ts`, `index.ts` (экспорт `registerSessionHandlers(dataAccess)`); из `queries.ts` - один вызов. Общие хелперы (резолв сцены/актёра/пака/пользователя, координаты, GM-гейт) - `session/common.ts`; резолв актёра и пака можно импортировать из `raw-handlers.ts`, вынеся их в `common.ts` (допустимо тронуть `raw-handlers.ts` только чтобы импортировать хелперы из нового места).
- Сервер: папка `packages/mcp-server/src/tools/session/` с `files.ts`, `scene.ts`, `playlist.ts`, `journal.ts`, `ownership.ts`, `combat.ts`, `chat.ts`, `loot.ts`, `index.ts` (класс `SessionTools`, собирающий определения и `handle(name, args)`); в `backend.ts` - конструирование, spread в `allTools`, ветки `case`. Описания инструментов по-английски.
- GM-гейт и `allowWriteOperations` для всего пишущего, как в `raw-handlers.ts`.
- **Резолв сцены** `scene`: id → точное имя → регистронезависимое частичное (неоднозначность - ошибка со списком). Без `scene` - `game.scenes.active`, а если её нет - ошибка.
- **Координаты**: объект `{ x, y, units?: 'px' | 'grid' }`, дефолт `grid` (клетки от левого верхнего угла сцены, дробные допустимы; переводить через `scene.grid.size` и `scene.dimensions.sceneX/sceneY`, то есть учитывать padding). Для токенов `grid`-координата - левый верхний угол токена.
- **Пользователи** `users`: массив имён или id; `"all"` = все не-ГМ активные и неактивные игроки; `"players"` = то же; пустой/отсутствует = по умолчанию инструмента.
- Ответы - plain JSON с id/uuid созданного, ошибки - `Error`.

---

## 1. Файлы

### 1.1 `upload-file` → `files.upload`
Вход (после гидрации): `{ targetDir: string, fileName: string, fileData: string (base64), mimeType?: string, overwrite?: boolean (дефолт true), source?: 'data' (дефолт) }`.
Обёртка: аргумент `filePath` (локальный путь) читается в `fileData` (base64) и `fileName` (basename, если не задан явно), `mimeType` по расширению (jpg/jpeg/png/webp/gif/svg/mp3/ogg/wav/webm/mp4/pdf/json/txt/md; иначе `application/octet-stream`); `filePath` удаляется. Лимит 25 МБ - больше отбивать в обёртке с советом положить файл по ssh.
Модуль: `targetDir` создать рекурсивно (`createDirectory` по сегментам, ошибку «already exists» глотать), `new File([bytes], fileName, {type})`, `FilePicker.implementation.upload('data', targetDir, file, {}, {notify:false})`. Ответ `{ path, size, existed }` (`path` - как вернул Foundry, percent-encoded).
Кириллические имена папок/файлов допустимы: Foundry сам кодирует путь.

### 1.2 `manage-files` → `files.browse` | `files.mkdir`
`{ action: 'list' | 'mkdir', dir: string, source?: 'data', extensions?: string[] }` → list: `{ dirs: [], files: [{ path, name, url? }] }`; mkdir → `{ created: boolean }`. Удаления в API Foundry нет - не обещать.

---

## 2. Сцены

### 2.1 `manage-scene` → `scene.create` | `scene.update` | `scene.delete` | `scene.activate` | `scene.list` | `scene.info`
`create`: `{ name, background: string (путь к картинке в Data), folder?, gridSize?: number (px, дефолт 100), gridType?: 'square'|'hexOdd'|'hexEven'|'gridless' (дефолт square), gridDistance?: number (дефолт 5), gridUnits?: string (дефолт 'ft'), width?, height? (если нет - из размеров картинки), padding?: number (дефолт 0.25), backgroundColor?: string, darkness?: number 0..1 (дефолт 0), globalLight?: boolean (дефолт true при darkness 0, иначе false), tokenVision?: boolean (дефолт true), fogExploration?: boolean (дефолт true), navigation?: boolean (дефолт true), navName?, playlist?: string (имя/id плейлиста), initialView?: { x, y, scale }, activate?: boolean, ownership?: { default?: level } }`. Размеры картинки: `foundry.canvas.loadTexture(path)` → `width/height`; запасной путь `new Image()`. `grid.type`: square = `CONST.GRID_TYPES.SQUARE` (1), hexOdd = HEXODDR (2), hexEven = HEXEVENR (3), gridless = 0. Ответ `{ id, name, width, height, gridSize, uuid }`.
`update`: `{ scene, ...те же поля }` → `scene.update` (поля переводить в схему: `environment.darknessLevel`, `environment.globalLight.enabled`, `fog.exploration`, `background.src`, `grid.*`).
`delete`, `activate` (`scene.activate()`), `list` → `[{ id, name, active, navigation, width, height, gridSize, tokens: count, folder }]`, `info` → сцена целиком в кратком виде: настройки + счётчики (tokens, lights, walls, tiles, notes, sounds).

### 2.2 `place-tokens` → `scene.placeTokens`
`{ scene?, tokens: [{ actor: string (id/имя актёра мира или UUID записи компендиума `Compendium.world.pepel-bestiary.Actor.xxx`), x, y, units?, name?: string, hidden?: boolean, disposition?: 'hostile'|'neutral'|'friendly'|'secret', elevation?: number, count?: number (дефолт 1: одинаковые токены в ряд с шагом в клетку; имена «Имя 1..N» если count > 1), scale?: number }], importCompendiumTo?: string (папка Actor для импортированных из компендиума, дефолт 'Imported Actors') }`.
Актёр из компендиума импортируется в мир один раз на вызов (по UUID; если в мире уже есть актёр с флагом `flags.core.sourceId`/`_stats.compendiumSource` = этот UUID - переиспользовать). Токен: `actor.getTokenDocument({ x, y, hidden, disposition, elevation, name })` → `scene.createEmbeddedDocuments('Token', [...])` батчем. Ответ `{ created: [{ tokenId, actorId, name, x, y }], importedActors: [...] }`.

### 2.3 `manage-scene-lights` → `scene.lights`
`{ scene?, action: 'create' | 'update' | 'delete' | 'list' | 'clear', lights?: [{ id?, x, y, units?, bright?: number (в единицах сцены, дефолт 20), dim?: number (дефолт 40), color?: string, alpha?: number (дефолт 0.5), angle?: number (360), rotation?: number, animation?: 'none'|'torch'|'flame'|'pulse'|'chroma'|'wave'|'fog'|'sunburst'|'dome'|'emanation'|'hexa'|'ghost'|'energy'|'roiling'|'hole'|'vortex'|'witchwave'|'rainbowswirl'|'radialrainbow'|'fairy'|'grid'|'starlight'|'smokepatch'|'siren'|'reverse'|'blackhole'|'revolving', animationSpeed?: number (5), animationIntensity?: number (5), walls?: boolean (true), vision?: boolean (false), hidden?: boolean, luminosity?: number, negative?: boolean }], ids?: string[] }`.
`bright/dim` в единицах сцены (ft) - это и есть `config.bright/dim`. Пресеты по слову: `torch` → animation torch, color `#ff9329`, bright 20, dim 40; `campfire` → flame, `#ff6a00`, 15/30; `candle` → torch, `#ffd37a`, 5/10; `moonlight` → none, `#8fa9ff`, 0/60, alpha 0.2 - реализовать как поле `preset?: 'torch'|'campfire'|'candle'|'moonlight'|'lantern'|'magical'` с перекрытием явными полями.

### 2.4 `manage-walls` → `scene.walls`
`{ scene?, action: 'create' | 'delete' | 'clear' | 'list' | 'import-uvtt' | 'box', walls?: [{ from: {x,y,units?}, to: {x,y,units?}, door?: 'none'|'door'|'secret' (дефолт none), doorState?: 'closed'|'open'|'locked', move?: boolean (true), sight?: boolean (true), light?: boolean (true), sound?: boolean (true), oneWay?: 'none'|'left'|'right' }], ids?: string[], uvtt?: object, box?: { x, y, width, height, units? } }`.
`c = [x1,y1,x2,y2]` в пикселях; `move/sight/light/sound`: 0 = нет, 20 = normal (`CONST.WALL_SENSE_TYPES.NORMAL`), move: `CONST.WALL_MOVEMENT_TYPES`; door: `CONST.WALL_DOOR_TYPES` (0/1/2), ds: `CONST.WALL_DOOR_STATES`; dir: `CONST.WALL_DIRECTIONS`.
`import-uvtt`: формат Universal VTT (Dungeon Alchemist, dd2vtt): `resolution.pixels_per_grid`, `resolution.map_size{x,y}` в клетках, `line_of_sight: [[{x,y},...]]` (полилинии в клетках → стены между соседними точками), `portals: [{position, bounds:[{x,y},{x,y}], rotation, closed, freestanding}]` → двери (bounds как концы стены, `door: 1`, `ds: closed ? 0 : 1`), `lights: [{position, range, intensity, color (hex без #), shadows}]` → AmbientLight (range в клетках → dim = range*gridDistance, bright = dim/2). Обёртка: `uvttFile` (локальный путь) → `uvtt` (JSON). Также `image` в UVTT (base64 png) - игнорировать (фон заливается отдельно через upload-file).
`box`: четыре стены по прямоугольнику (периметр карты).
Ответ `{ created: n, deleted: n, lights: n }`.

### 2.5 `manage-tiles` → `scene.tiles`
`{ scene?, action: 'create' | 'delete' | 'list' | 'update', tiles?: [{ id?, image: string, x, y, units?, width?, height? (px; дефолт - размеры картинки), overhead?: boolean (elevation 20 + occlusion.mode = CONST.OCCLUSION_MODES.FADE... в v12+ overhead = `elevation` выше токенов; ставить `elevation: 20`, `occlusion: {mode: 3 (FADE), alpha: 0.5}`, `restrictions: {light: true, weather: false}`), hidden?, rotation?, alpha?, sort? }], ids?: string[] }`.

### 2.6 `manage-scene-notes` → `scene.notes`
`{ scene?, action: 'create' | 'delete' | 'list', notes?: [{ journal: string (имя/id/uuid), page?: string (имя/id страницы), x, y, units?, label?: string, icon?: string (путь; дефолт 'icons/svg/book.svg'), iconSize?: number (40), global?: boolean }], ids?: string[] }` → пины на карте (`Note`).

---

## 3. Плейлисты

### 3.1 `manage-playlists` → `playlist.*`
`{ action: 'list' | 'create' | 'update' | 'delete' | 'add-tracks' | 'remove-tracks' | 'play' | 'stop' | 'play-track' | 'stop-track' | 'set-volume', playlist?: string (имя/id), name?, folder?, mode?: 'sequential' | 'shuffle' | 'simultaneous' | 'soundboard', fade?: number (мс, дефолт 2000), description?, tracks?: [{ path: string, name?: string (дефолт из имени файла без расширения), volume?: number 0..1 (дефолт 0.6), repeat?: boolean (дефолт false; true для эмбиента), fade?: number }], trackNames?: string[], track?: string, volume?: number }`.
- `create` с `tracks` создаёт плейлист и звуки одним `Playlist.create` (`sounds: [...]`). `soundboard` = mode -1.
- `play` → `playlist.playAll()`, `stop` → `stopAll()`, `play-track` → `playlist.playSound(sound)`, `stop-track` → `playlist.stopSound(sound)`.
- `set-volume`: у трека (`track`) или у всех треков плейлиста (`volume`).
- `list` → `[{ id, name, mode, playing, tracks: [{ id, name, path, volume, repeat, playing }] }]`.

---

## 4. Журналы, показ, права

### 4.1 `manage-journal` → `journal.*`
`{ action: 'create' | 'update' | 'delete' | 'add-pages' | 'update-page' | 'delete-pages' | 'list' | 'get', journal?: string, name?, folder?, ownership?: { default?: 'none'|'limited'|'observer'|'owner', users?: { [nameOrId]: level } }, pages?: [{ name, type: 'text' | 'image' | 'pdf' | 'video' (дефолт text), content?: string (HTML для text; markdown не принимать - конвертирует вызывающий), src?: string (путь для image/pdf/video), caption?: string, titleLevel?: number (1..6, дефолт 1), showTitle?: boolean (true), ownership?: {...} }], pageIds?: string[], page?: string }`.
- Существующие инструменты `create-journal-entry` / `update-journal-content` остаются; новый - для страниц-картинок, множественных страниц и прав. `text.format = 1` (HTML), `text.content`.
- `get` → журнал с перечнем страниц (id, name, type, src, длина текста, ownership).

### 4.2 `show-to-players` → `journal.show` | `journal.showImage`
`{ what: 'journal' | 'page' | 'image', journal?: string, page?: string, image?: string (путь), title?: string, users?: 'all' | string[] (дефолт all), force?: boolean (true: показать и тем, у кого нет прав - `JournalEntry#show(true)`) }`.
- image → `new foundry.applications.apps.ImagePopout({ src, window: { title } })`, затем `shareImage({ users })` если метод принимает опции, иначе `render(true)` + `shareImage()`; проверить сигнатуру в клиенте (`shareImage.length`, исходник через `.toString()`), выбрать рабочий вариант, зафиксировать в Отклонениях.

### 4.3 `manage-ownership` → `ownership.set` | `ownership.get`
`{ documentType: 'Actor' | 'JournalEntry' | 'Scene' | 'Playlist' | 'Item' | 'Macro' | 'RollTable' | 'JournalEntryPage', identifier: string (имя/id/uuid; для страницы - `journal` + `page`), journal?: string, default?: level, users?: { [nameOrId]: level }, players?: level (всем не-ГМ разом) }` → `{ uuid, ownership }`. Уровни словами: none/limited/observer/owner (и inherit для страниц). Существующий `assign-actor-ownership` не трогать.

---

## 5. Бой и чат

### 5.1 `manage-combat` → `combat.*`
`{ action: 'create' | 'add' | 'remove' | 'roll-initiative' | 'start' | 'next' | 'previous' | 'end' | 'status', scene?, tokens?: string[] (id или имена токенов сцены), select?: 'all' | 'hostile' | 'friendly' | 'npc' | 'pc', initiative?: { [tokenNameOrId]: number }, rollNpc?: boolean (true), rollAll?: boolean }`.
- `create`: новый `Combat` для сцены (`Combat.create({ scene: scene.id, active: true })`), добавить бойцов (`createEmbeddedDocuments('Combatant', [{ tokenId, sceneId, actorId, hidden }])`), при `rollNpc` - `combat.rollNPC()`, при `rollAll` - `rollAll()`, явные значения инициативы - `combat.setInitiative(combatantId, value)`. Без `select`/`tokens` - все токены сцены.
- `status` → `{ id, round, turn, combatants: [{ id, name, initiative, tokenId, defeated, hidden, isCurrent }] }`.
- В headless без канваса `Combat#startCombat` и `nextTurn` работают на документах - ок.

### 5.2 `send-chat` → `chat.send`
`{ message: string (HTML), speaker?: string (имя актёра или токена; без - ГМ), style?: 'ic' | 'ooc' | 'emote' | 'other' (дефолт ic при speaker, иначе other), whisperTo?: 'gm' | string[], image?: string (путь; вставляется как `<img>` в конец), flavor?: string, roll?: string (формула; если задана - `new Roll(formula).evaluate()` и `toMessage`) }` → `{ id }`.

---

## 6. Таблицы и лут

### 6.1 `manage-rolltable` → `table.*`
`{ action: 'create' | 'roll' | 'list' | 'delete' | 'get', table?: string, name?, folder?, formula?: string (дефолт `1d<N>` по числу результатов), replacement?: boolean (true), results?: [{ text?: string, document?: string (uuid или `Compendium...`), weight?: number (1), range?: [from, to] }], rolls?: number (1), toChat?: boolean (true) }`.
- `roll` → `table.draw({ rollMode })` × rolls, ответ `{ results: [{ text, documentUuid?, roll }] }`.

### 6.2 `manage-loot-pile` → `piles.*` (модуль item-piles обязателен; при отсутствии - понятная ошибка)
`{ action: 'create' | 'add-items' | 'open' | 'close' | 'lock' | 'unlock' | 'list', scene?, x?, y?, units?, name?: string (дефолт 'Loot'), image?: string (дефолт 'icons/svg/chest.svg'), type?: 'pile' | 'container' (дефолт container), items?: [{ item: string (uuid из компендиума, например `Compendium.dnd5e.items.Item.xxx`, или имя предмета в `pack`), pack?: string, quantity?: number (1) }], pile?: string (имя/id токена) }`.
- `create` → `game.itempiles.API.createItemPile({ sceneId, position: {x,y}, items: [...docs data], pileActorName: name, tokenOverrides: { name, texture: { src: image } }, actorOverrides: { name, img: image } , createActor: true })`; параметры по докам https://fantasycomputer.works/FoundryVTT-ItemPiles/#/api?id=createitempile - сверить сигнатуру через `game.itempiles.API.createItemPile.toString()` в клиенте (у исполнителя клиента нет: взять сигнатуру из документации, оставить понятную ошибку при несоответствии; интегратор проверит живьём).
- items из компендиума: `fromUuid(...)` → `toObject()`, `system.quantity = quantity`.

---

## 7. Гидрация в обёртке (`tool-files.ts`)
- `upload-file`: `filePath` → `fileData` (base64), `fileName`, `mimeType`; ошибка чтения / лимит → `isError`.
- `manage-walls`: `uvttFile` → `uvtt` (JSON).
- `manage-journal`: страницы с `contentFile` (локальный .html/.md) → `content` (markdown конвертировать простым конвертером не нужно - только .html и .txt как есть; .md отбивать с ошибкой «convert first»).
- `send-chat`: `messageFile` → `message`.
Всё - в `hydrateToolArgs`, с тестами.

---

## 8. Проверки перед сдачей
- `npm run typecheck`, `npm run build`, `npm run bundle:server` из корня.
- `npm run test --workspace=packages/mcp-server` - зелёный, новые тесты на схемы/диспетчер `session` и на гидрацию (`upload-file` base64, лимит, mime; `uvttFile`; `messageFile`).
- `node scripts/mcp-schema-smoke-test.mjs` - учит новые инструменты.
- Живой прогон - интегратор.

## 9. Отчёт исполнителя
Разделы: что сделано (файлы), что проверено (команды и вывод), **Отклонения** (каждое отступление от дефолта/ТЗ, расширения сверх ТЗ с пометкой), открытые вопросы.
