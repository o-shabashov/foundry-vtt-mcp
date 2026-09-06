# Music tools: генерация музыки через Suno-прокси

Контракт на инструменты генерации музыки в форке foundry-vtt-mcp (ветка `pepel`).
Цель: агент (Claude через MCP или скрипт из shell) по текстовому промпту получает готовый трек
Suno, кладёт его в Data-каталог Foundry и при желании в плейлист, а копию сохраняет на машине
клиента (папка сессии в Obsidian).

Официального API у Suno нет (сентябрь 2026: партнёрская программа по заявкам). Работаем через
прокси-провайдеров, у которых одинаковая модель «создать задачу → опрашивать → скачать mp3».
Провайдер выбирается конфигом, интерфейс общий.

## Где живёт код

- Бэкенд (запускается на сервере рядом с Foundry): `packages/mcp-server/src/tools/music/`
  - `index.ts` - класс `MusicTools` (по образцу `tools/session/index.ts`): определения инструментов,
    диспетчер по имени, экспорт `MUSIC_TOOL_NAMES`.
  - `common.ts` - типы `MusicProvider`, `MusicRequest`, `MusicTask`, `MusicTrack`, ошибки.
  - `providers/apiframe.ts`, `providers/sunoapi.ts` - адаптеры.
  - `providers/index.ts` - фабрика `createMusicProvider(config)`.
- Подключение в `packages/mcp-server/src/backend.ts` там же, где создаётся `SessionTools`
  (строка ~1200) и где диспетчеризуются её имена (~1805). Инструменты попадают в общий список
  `list_tools`.
- Конфиг: `packages/mcp-server/src/config.ts`, секция `music` (см. ниже).
- Обёртка stdio на машине клиента: `packages/mcp-server/src/tool-files.ts` - дегидратация
  результата: скачивание mp3 в `outDir`.
- Скрипт: `scripts/music-gen.mjs` (через `scripts/lib/mcp-client.mjs`, как `session-apply.mjs`).
- Манифест сессии: `scripts/session-apply.mjs` - ключ `generate` у трека плейлиста.
- Модуль Foundry не меняется: заливка идёт существующим запросом `foundry-mcp-bridge.files.upload`
  (тот же путь, что у `upload-file` с `fileData`), плейлисты - существующим `manage-playlists`.

## Конфиг (env бэкенда)

| Переменная               | Дефолт                                  | Смысл                                                                                       |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `MUSIC_PROVIDER`         | `apiframe`                              | `apiframe` или `sunoapi`                                                                    |
| `APIFRAME_API_KEY`       | пусто                                   | ключ apiframe.ai (заголовок `X-API-Key`)                                                    |
| `APIFRAME_BASE_URL`      | `https://api.apiframe.ai`               |                                                                                             |
| `SUNOAPI_API_KEY`        | пусто                                   | ключ sunoapi.org (`Authorization: Bearer`)                                                  |
| `SUNOAPI_BASE_URL`       | `https://api.sunoapi.org`               |                                                                                             |
| `MUSIC_CALLBACK_URL`     | `https://example.invalid/suno-callback` | sunoapi.org требует `callBackUrl`; мы опрашиваем, поэтому заглушка (дефолт, см. Отклонения) |
| `MUSIC_POLL_INTERVAL_MS` | `5000`                                  | шаг опроса                                                                                  |
| `MUSIC_TIMEOUT_MS`       | `300000`                                | максимум ожидания в `wait: true`                                                            |

Без ключа выбранного провайдера инструмент отвечает ошибкой с текстом, какую переменную задать;
`list_tools` инструменты показывает всегда.

## Общий интерфейс провайдера (`common.ts`)

```ts
export interface MusicRequest {
  prompt: string; // описание музыки (customMode=false) или текст песни (customMode=true, instrumental=false)
  style?: string; // жанр/настроение/инструменты, до 1000 символов
  title?: string; // до 80 символов
  instrumental: boolean; // дефолт true
  customMode: boolean; // дефолт: true, если задан style или title, иначе false
  model: 'V4' | 'V4_5' | 'V4_5PLUS' | 'V4_5ALL' | 'V5' | 'V5_5'; // дефолт V5
  negativeTags?: string;
  vocalGender?: 'm' | 'f';
  styleWeight?: number; // 0..1
  weirdness?: number; // 0..1
  durationSec?: number; // 10..360, только V5_5 + customMode; иначе игнорируется с предупреждением в ответе
}
export interface MusicTrack {
  id: string;
  title: string;
  durationSec: number | null;
  audioUrl: string;
  imageUrl?: string;
  tags?: string;
}
export type MusicTaskStatus = 'pending' | 'partial' | 'complete' | 'failed';
export interface MusicTask {
  provider: string;
  taskId: string;
  status: MusicTaskStatus;
  tracks: MusicTrack[];
  error?: string;
  raw?: unknown;
}
export interface MusicProvider {
  readonly name: string;
  generate(req: MusicRequest): Promise<{ taskId: string }>;
  status(taskId: string): Promise<MusicTask>;
  credits?(): Promise<number | null>;
}
```

`raw` - усечённый ответ провайдера (для отладки; в ответ инструмента не попадает, только в лог на debug).

## Адаптеры

### apiframe (`providers/apiframe.ts`)

Документация: https://apiframe.ai/docs/music/suno (читать перед реализацией, поля ниже - из неё).

- `POST {base}/v2/music/generate`, заголовки `X-API-Key: <key>`, `Content-Type: application/json`.
  Тело:
  ```json
  {
    "model": "suno",
    "prompt": "...",
    "sunoParams": {
      "custom_mode": true,
      "instrumental": true,
      "model_version": "V5",
      "title": "...",
      "style": "...",
      "negative_tags": "...",
      "vocal_gender": "m",
      "style_weight": 0.6,
      "weirdness_constraint": 0.2
    }
  }
  ```
  Ответ содержит id задачи; принимать `id ?? task_id ?? taskId` (точное имя сверить по докам).
- `GET {base}/v2/jobs/{id}` - статус. Готово, когда есть массив `tracks` с непустыми `audioUrl`
  (обычно 2 трека); поля трека: `id, audioUrl, imageUrl, title, tags, duration`. Статус
  `failed`, если поле статуса матчит `/fail|error|cancel/i`; `pending` иначе.
- Кредиты: если в доках есть endpoint остатка кредитов - реализовать `credits()`, иначе не реализовывать.
- Ошибки HTTP 401/402/429 - в `error` человекочитаемо: «ключ неверен», «кредиты кончились», «лимит запросов».

### sunoapi (`providers/sunoapi.ts`)

Документация: https://docs.sunoapi.org/suno-api/generate-music и
https://docs.sunoapi.org/suno-api/get-music-generation-details.

- `POST {base}/api/v1/generate`, `Authorization: Bearer <key>`. Тело:
  `{ customMode, instrumental, prompt, style, title, model, negativeTags, vocalGender, styleWeight, weirdnessConstraint, duration, callBackUrl }`.
  Ответ `{ code: 200, msg, data: { taskId } }`; `code !== 200` → ошибка с `msg`.
- `GET {base}/api/v1/generate/record-info?taskId=...`: `data.status` ∈ `PENDING | TEXT_SUCCESS`
  → `pending`; `FIRST_SUCCESS` → `partial`; `SUCCESS` → `complete`;
  `CREATE_TASK_FAILED | GENERATE_AUDIO_FAILED | CALLBACK_EXCEPTION | SENSITIVE_WORD_ERROR` → `failed`
  (в `error` - `data.errorMessage` или код). Треки в `data.response.sunoData[]`:
  `id, audio_url, image_url, title, tags, duration`.
- `credits()`: `GET {base}/api/v1/generate/credit` → число в `data`.

## Инструменты

### `generate-music`

Аргументы: поля `MusicRequest` (все опциональные, кроме `prompt`) плюс:

| Аргумент    | Дефолт                      | Смысл                                                                                                                                                                                              |
| ----------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait`      | `true`                      | ждать завершения (опрос до `MUSIC_TIMEOUT_MS`); `false` - вернуть `taskId` сразу                                                                                                                   |
| `targetDir` | пусто                       | каталог в Data Foundry (`worlds/<world>/sessions/Сессия 15`); если задан, готовые треки скачиваются бэкендом и заливаются через `files.upload`                                                     |
| `fileName`  | `title` или `Suno <taskId>` | базовое имя без расширения; первый трек `<fileName>.mp3`, второй `<fileName> (2).mp3`                                                                                                              |
| `playlist`  | пусто                       | имя плейлиста Foundry: существующий - добавить треки (`manage-playlists`, действие добавления треков; если такого действия нет - см. Отклонения), нет - создать `mode: sequential` с этими треками |
| `outDir`    | пусто                       | локальный каталог на машине клиента; обрабатывает обёртка, бэкенда не касается (объявить в схеме)                                                                                                  |
| `provider`  | из конфига                  | переопределить провайдера на один вызов                                                                                                                                                            |

Ответ (JSON в тексте, как у остальных инструментов):

```json
{
  "provider": "apiframe",
  "taskId": "…",
  "status": "complete",
  "tracks": [
    {
      "id": "…",
      "title": "…",
      "durationSec": 187.4,
      "audioUrl": "https://…",
      "imageUrl": "…",
      "path": "worlds/…/Сессия%2015/Название.mp3",
      "playlist": "С15 Дорога"
    }
  ],
  "warnings": []
}
```

`path` - percent-encoded путь, который вернул `files.upload` (как у `upload-file`). При `status: pending`
(`wait: false` или таймаут) ответ содержит `taskId` и подсказку вызвать `music-status`; таймаут - это
статус `pending`, а не ошибка. `failed` - `isError` с текстом провайдера.

### `music-status`

Аргументы: `taskId`, `provider?`, и те же `targetDir`, `fileName`, `playlist`, `outDir`.
Возвращает тот же формат. Если задача `complete` и задан `targetDir` - заливка и плейлист делаются
здесь (идемпотентно: `overwrite: true`, в плейлист трек не дублируется, сравнение по `path`).

### `music-credits`

Без аргументов (или `provider`). Ответ `{ provider, credits }`; `credits: null`, если провайдер
не умеет.

## Обёртка (tool-files.ts)

`dehydrateToolResult` для `generate-music` и `music-status`: если в аргументах был `outDir` и в
ответе есть `tracks[].audioUrl`, скачать каждый трек в `path.resolve(outDir, <fileName>.mp3)`
(имена как у `fileName` выше, `(2)` для второго), дописать в трек `localPath`. Ошибка скачивания
не роняет результат: в `warnings` добавляется строка. `outDir` из аргументов перед отправкой на
бэкенд не вырезать (бэкенд его игнорирует).

## Скрипт `scripts/music-gen.mjs`

```
node scripts/music-gen.mjs "<prompt>" [--title=…] [--style=…] [--vocals] [--model=V5] [--target-dir=…] [--playlist=…] [--out=./dir] [--file-name=…] [--no-wait] [--status=<taskId>] [--credits]
```

Печатает итоговый JSON и понятные строки хода (`task …`, `pending … 45s`, `uploaded …`).

## session-apply: `generate` у трека

В `playlists[].tracks[]` разрешён ключ:

```yaml
- file: '3 Свежее мясо.mp3'
  generate:
    { prompt: 'dark industrial…', style: '…', title: 'Свежее мясо', instrumental: true, model: V5 }
```

Если локальный файл `assetsDir/file` существует - ничего не генерить. Если нет - вызвать
`generate-music` с `wait: true`, `outDir: assetsDir`, `fileName` = имя без расширения, без `targetDir`
(заливка идёт общим шагом uploads, поэтому uploads должен выполняться после генерации: сделать
проход генерации до секции uploads). Из двух треков в `file` идёт первый; второй остаётся рядом
как `<имя> (2).mp3` и не заливается (чтобы не плодить мусор). В `--dry-run` печатать, что было бы
сгенерировано.

## Тесты

vitest в `packages/mcp-server`: адаптеры с замоканным `fetch` (успех, `pending → complete`,
`failed`, 402), `MusicTools.generate` c `wait: true` и фейковым провайдером (таймаут → `pending`),
дегидратация `outDir` с замоканным скачиванием. `npm run build` и `npm test` зелёные.

## Документация

- Этот файл - контракт. После реализации дописать раздел «Проверено» с датой и тем, что прогнано.
- В `docs/session-tools-spec.md` добавить абзац-ссылку на music tools.
- В README форка - короткий раздел (по-английски, как у session tools).

## Отклонения и дефолты

Открытый вопрос не блокирует: бери дефолт из этого файла, любое отступление от дефолта или от
буквы спеки фиксируй в разделе «Отклонения» итогового отчёта. Известные дефолты:

- `MUSIC_CALLBACK_URL` заглушка `https://example.invalid/suno-callback`: провайдер может отклонить
  невалидный домен; тогда взять `https://httpbin.org/post` и записать в Отклонения.
- Если у `manage-playlists` нет действия «добавить треки в существующий плейлист» - добавить его
  (`action: 'add-tracks'`, `playlist`, `tracks[]`) в `tools/session/playlist.ts` и в модуль
  `packages/foundry-module/src/session/playlist-handlers.ts` (тогда модуль всё же меняется -
  отметить в Отклонениях и в отчёте, чтобы задеплоить модуль тоже).
- Имя поля id в ответе apiframe и имена статусов - сверить по докам; если доки недоступны, принять
  `id`/`status` и отметить.
- Ничего не деплоить: сборка и тесты локально, деплой делает интегратор.

---

## Проверено

Реализовано 2026-09-06 в ветке `feat/music-tools` (от `pepel` на `7d2ffc1`).

Файлы:

- `packages/mcp-server/src/tools/music/common.ts` - контракт `MusicProvider`, типы, HTTP-хелперы и общие тексты ошибок.
- `packages/mcp-server/src/tools/music/providers/apiframe.ts`, `providers/sunoapi.ts`, `providers/index.ts` - адаптеры и фабрика.
- `packages/mcp-server/src/tools/music/index.ts` - класс `MusicTools`, три инструмента, опрос, заливка, плейлист.
- `packages/mcp-server/src/tools/music/music.test.ts` - 29 тестов (адаптеры на замоканном `fetch` + инструменты).
- `packages/mcp-server/src/config.ts` - секция `music`; `backend.ts` - конструирование, `allTools`, диспетчер.
- `packages/mcp-server/src/tool-files.ts` - `dehydrateToolResult` стал асинхронным, добавлено скачивание в `outDir`.
- `scripts/music-gen.mjs`, ключ `generate` у трека в `scripts/session-apply.mjs`.

Прогнано:

- `npm run build` (весь workspace) - зелёный.
- `npm test` - 14 файлов, 312 тестов, зелёный (было 283, добавлено 29 музыкальных + 6 на дегидратацию).
- `npm run bundle:server` и `npm run test:mcp:schema` - PASS, новые схемы проходят.
- `node --check scripts/music-gen.mjs`, `node --check scripts/session-apply.mjs` - без ошибок.
- `npx eslint packages/mcp-server/src/tools/music` - 0 ошибок (только общие для репозитория warning'и на `any`), `prettier --check` чистый.

Живого ключа провайдера у исполнителя не было: реальный вызов apiframe/sunoapi и заливка в Foundry не прогонялись, это делает интегратор.

## Отклонения от спеки

1. **Тексты ошибок по-английски.** Спека просила «человекочитаемо: «ключ неверен», «кредиты кончились», «лимит запросов»»; сообщения написаны по-английски, как и всё остальное в коде и описаниях инструментов.
2. **`MusicGenerateResult` вместо `{ taskId }`** (сверх ТЗ). `generate()` возвращает `{ taskId, warnings? }`: apiframe не принимает длину трека вовсе, и адаптеру нужно сказать об этом в ответе инструмента.
3. **`credits()` у apiframe реализован** - `GET /v2/me`, баланс в `team.credits` (доки `https://apiframe.ai/docs/account/me`). Спека допускала не реализовывать, если endpoint'а нет.
4. **Поле id задачи у apiframe - `jobId`.** По докам `POST /v2/music/generate` отвечает `202 { "jobId": "...", "status": "QUEUED" }`; адаптер принимает `jobId ?? id ?? task_id ?? taskId`. Статусы `QUEUED | PROCESSING | COMPLETED | FAILED`, треки в `result.tracks`.
5. **Коды ошибок sunoapi - в теле, а не в HTTP.** Ответ всегда `200` с полем `code`; «кредиты кончились» там `429`, а не `402`. Разобраны 400/401/404/405/413/429/430/455/500.
6. **`MUSIC_CALLBACK_URL` оставлен дефолтным** (`https://example.invalid/suno-callback`). Проверить, примет ли sunoapi невалидный домен, без живого ключа нельзя; если откажет, менять на `https://httpbin.org/post` интегратору.
7. **`add-tracks` у `manage-playlists` уже был** - модуль Foundry не тронут, деплоить его не нужно.
8. **Существующий плейлист ищется через `manage-playlists` `action: list` с `playlist: <имя>`** - модульный резолвер бросает ошибку на неизвестное имя, это и есть признак «плейлиста нет, надо создать».
9. **`dehydrateToolResult` стал `async`** - скачивание требует `await`. Обновлены шесть существующих тестов на `export-actor`, поведение не изменилось.
10. **Имя файла санируется** (`\ / : * ? " < > |` и управляющие символы в `-`, схлопывание пробелов) одинаково в бэкенде и в обёртке, чтобы локальная копия и копия в Foundry назывались одинаково. Кириллица и пробелы сохраняются.
11. **Лимит `MAX_UPLOAD_MB` применён и к локальному скачиванию в `outDir`** (сверх ТЗ, буквально по пункту 5 задания): трек больше 25 МБ не сохраняется, строка уходит в `warnings`.
12. **`music-gen.mjs` ждёт сам**, а не одним длинным вызовом: `generate-music` с `wait: false`, затем опрос `music-status` с печатью `pending ... 45s`, затем финальный `music-status` с `targetDir`/`playlist`/`outDir`. Иначе строк хода из спеки взяться неоткуда. Флаг `--no-wait` печатает `taskId` и выходит.
13. **Таймаут MCP-клиента `session-apply.mjs` поднят с 300 до 600 секунд** (сверх ТЗ): вызов `generate-music` с `wait: true` держит соединение весь прогон Suno, а прежний таймаут совпадал с `MUSIC_TIMEOUT_MS` и гарантированно срывался бы первым.
14. **`session-apply.mjs`: генерация - отдельная секция `music`** (`--only=music`), выполняется до `uploads`. Второй дубль Suno (`<имя> (N).mp3`) исключается из списка загрузок по умолчанию, чтобы не попасть в Foundry.
15. **`playlist` без `targetDir`** не молчит: трек некуда положить, поэтому шаг пропускается со строкой в `warnings`.
16. **apiframe со статусом `COMPLETED` без единого трека** трактуется как `failed` с понятным текстом, иначе опрос крутился бы до таймаута.
