/**
 * File hydration for the raw actor tools and the session tools.
 *
 * Files live on the machine that runs the stdio wrapper (src/index.ts), while the
 * backend may later move to a different host. So every filesystem access happens
 * here: `hydrateToolArgs` runs before a call_tool request is forwarded and
 * `dehydrateToolResult` runs on the response that comes back.
 *
 * The backend never sees `filePath` / `scriptFile` / `uvttFile` / `contentFile` /
 * `messageFile`; it does see `outFile`, but only to decide whether an oversized
 * payload may be returned inline.
 *
 * Only Node built-ins are imported here - this module is bundled into
 * dist/index.bundle.cjs by esbuild.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ToolArgs = Record<string, any>;

/**
 * Largest file upload-file will inline as base64. Anything bigger is refused here,
 * before it can be turned into a multi-megabyte JSON-RPC frame.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** MIME types guessed from the file extension for upload-file. */
const UPLOAD_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

const FALLBACK_MIME_TYPE = 'application/octet-stream';

/** Extensions accepted for a journal page body; journal pages hold HTML. */
const PAGE_CONTENT_EXTENSIONS = ['.html', '.htm', '.txt'];

/** Result of hydrating tool arguments: either rewritten args or a user-facing error. */
export type HydrateOutcome = { ok: true; args: ToolArgs } | { ok: false; error: string };

/** Minimal shape of an MCP tool response as produced by the backend. */
export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Build an MCP error response without ever reaching the backend. */
export function toolErrorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function readTextFile(filePath: string, field: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read "${field}" file ${resolved}: ${errorMessage(error)}`);
  }
}

function readJsonFile(filePath: string, field: string): unknown {
  const text = readTextFile(filePath, field);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot parse JSON from "${field}" file ${path.resolve(filePath)}: ${errorMessage(error)}`
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept either a single JSON object or an array of them, always return an array. */
function asObjectArray(parsed: unknown, filePath: string, field: string): unknown[] {
  if (Array.isArray(parsed)) {
    const bad = parsed.findIndex(entry => !isPlainObject(entry));
    if (bad >= 0) {
      throw new Error(
        `"${field}" file ${path.resolve(filePath)} has a non-object entry at index ${bad}`
      );
    }
    return parsed;
  }
  if (isPlainObject(parsed)) return [parsed];
  throw new Error(
    `"${field}" file ${path.resolve(filePath)} must hold a JSON object or an array of JSON objects`
  );
}

// ── hydration ─────────────────────────────────────────────────────────────────

/**
 * Read any file-backed argument into the inline field the backend expects.
 * Tools without file arguments are returned untouched.
 */
export function hydrateToolArgs(name: string, args: ToolArgs | undefined): HydrateOutcome {
  const next: ToolArgs = { ...(args ?? {}) };

  try {
    switch (name) {
      case 'import-actor':
        hydrateImportActor(next);
        break;
      case 'manage-actor-items':
        hydrateManageActorItems(next);
        break;
      case 'update-actor-raw':
        hydrateUpdateActorRaw(next);
        break;
      case 'run-script':
        hydrateRunScript(next);
        break;
      case 'upload-file':
        hydrateUploadFile(next);
        break;
      case 'manage-walls':
        hydrateManageWalls(next);
        break;
      case 'manage-journal':
        hydrateManageJournal(next);
        break;
      case 'send-chat':
        hydrateSendChat(next);
        break;
      default:
        break;
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  return { ok: true, args: next };
}

function hydrateImportActor(args: ToolArgs): void {
  const filePath = nonEmptyString(args.filePath);
  const hasInline = args.actors !== undefined;

  if (hasInline && filePath) {
    throw new Error('import-actor takes exactly one of "actors" or "filePath", not both');
  }
  if (!hasInline && !filePath) {
    throw new Error('import-actor requires either "actors" or "filePath"');
  }
  if (!filePath) return;

  args.actors = asObjectArray(readJsonFile(filePath, 'filePath'), filePath, 'filePath');
  delete args.filePath;
}

function hydrateManageActorItems(args: ToolArgs): void {
  const filePath = nonEmptyString(args.filePath);
  if (!filePath) return;

  const action = nonEmptyString(args.action) ?? '';
  const field = action === 'create' ? 'items' : action === 'update-raw' ? 'updates' : null;
  if (!field) {
    throw new Error(
      `manage-actor-items "filePath" applies to action "create" or "update-raw" only, got "${action || 'none'}"`
    );
  }
  if (args[field] !== undefined) {
    throw new Error(`manage-actor-items takes exactly one of "${field}" or "filePath", not both`);
  }

  args[field] = asObjectArray(readJsonFile(filePath, 'filePath'), filePath, 'filePath');
  delete args.filePath;
}

function hydrateUpdateActorRaw(args: ToolArgs): void {
  const filePath = nonEmptyString(args.filePath);
  if (!filePath) return;

  if (args.update !== undefined) {
    throw new Error('update-actor-raw takes exactly one of "update" or "filePath", not both');
  }

  const parsed = readJsonFile(filePath, 'filePath');
  if (!isPlainObject(parsed)) {
    throw new Error(
      `"filePath" file ${path.resolve(filePath)} must hold a single JSON object of update keys`
    );
  }

  args.update = parsed;
  delete args.filePath;
}

function hydrateRunScript(args: ToolArgs): void {
  const scriptFile = nonEmptyString(args.scriptFile);
  const hasInline = nonEmptyString(args.script) !== undefined;

  if (hasInline && scriptFile) {
    throw new Error('run-script takes exactly one of "script" or "scriptFile", not both');
  }
  if (!scriptFile) return;

  args.script = readTextFile(scriptFile, 'scriptFile');
  delete args.scriptFile;
}

// ── session tools ─────────────────────────────────────────────────────────────

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Guess a MIME type from the file name, falling back to a generic binary type. */
function mimeTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return UPLOAD_MIME_TYPES[extension] ?? FALLBACK_MIME_TYPE;
}

function hydrateUploadFile(args: ToolArgs): void {
  const filePath = nonEmptyString(args.filePath);
  const hasInline = nonEmptyString(args.fileData) !== undefined;

  if (hasInline && filePath) {
    throw new Error('upload-file takes exactly one of "fileData" or "filePath", not both');
  }
  if (!hasInline && !filePath) {
    throw new Error('upload-file requires either "filePath" or inline base64 "fileData"');
  }
  if (!filePath) {
    if (!nonEmptyString(args.fileName)) {
      throw new Error('upload-file with inline "fileData" also requires "fileName"');
    }
    if (!nonEmptyString(args.mimeType)) {
      args.mimeType = mimeTypeFor(String(args.fileName));
    }
    return;
  }

  const resolved = path.resolve(filePath);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`Cannot read "filePath" file ${resolved}: ${errorMessage(error)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`"filePath" ${resolved} is not a regular file`);
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"filePath" ${resolved} is ${formatMegabytes(stats.size)} MB, over the ` +
        `${formatMegabytes(MAX_UPLOAD_BYTES)} MB upload limit. Copy the file to the Foundry host ` +
        'over ssh/scp into its Data directory instead, then use that path directly.'
    );
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (error) {
    throw new Error(`Cannot read "filePath" file ${resolved}: ${errorMessage(error)}`);
  }

  args.fileData = bytes.toString('base64');
  if (!nonEmptyString(args.fileName)) args.fileName = path.basename(resolved);
  if (!nonEmptyString(args.mimeType)) args.mimeType = mimeTypeFor(String(args.fileName));
  delete args.filePath;
}

function hydrateManageWalls(args: ToolArgs): void {
  const uvttFile = nonEmptyString(args.uvttFile);
  if (!uvttFile) return;

  if (args.uvtt !== undefined) {
    throw new Error('manage-walls takes exactly one of "uvtt" or "uvttFile", not both');
  }

  const parsed = readJsonFile(uvttFile, 'uvttFile');
  if (!isPlainObject(parsed)) {
    throw new Error(
      `"uvttFile" file ${path.resolve(uvttFile)} must hold a Universal VTT JSON object`
    );
  }

  args.uvtt = parsed;
  delete args.uvttFile;
}

function hydrateManageJournal(args: ToolArgs): void {
  const pages = args.pages;
  if (!Array.isArray(pages)) return;

  args.pages = pages.map((page, index) => {
    if (!isPlainObject(page)) return page;

    const contentFile = nonEmptyString(page.contentFile);
    if (!contentFile) return page;

    if (page.content !== undefined) {
      throw new Error(
        `manage-journal page ${index} takes exactly one of "content" or "contentFile", not both`
      );
    }

    const resolved = path.resolve(contentFile);
    const extension = path.extname(contentFile).toLowerCase();

    if (extension === '.md' || extension === '.markdown') {
      throw new Error(
        `manage-journal page ${index} "contentFile" ${resolved} is Markdown. Journal pages store ` +
          'HTML, so convert it first and pass the .html file.'
      );
    }
    if (!PAGE_CONTENT_EXTENSIONS.includes(extension)) {
      throw new Error(
        `manage-journal page ${index} "contentFile" ${resolved} must be ` +
          `${PAGE_CONTENT_EXTENSIONS.join(', ')}, got "${extension || 'no extension'}"`
      );
    }

    const next: ToolArgs = { ...page, content: readTextFile(contentFile, 'contentFile') };
    delete next.contentFile;
    return next;
  });
}

function hydrateSendChat(args: ToolArgs): void {
  const messageFile = nonEmptyString(args.messageFile);
  const hasInline = nonEmptyString(args.message) !== undefined;

  if (hasInline && messageFile) {
    throw new Error('send-chat takes exactly one of "message" or "messageFile", not both');
  }
  if (!hasInline && !messageFile) {
    throw new Error('send-chat requires either "message" or "messageFile"');
  }
  if (!messageFile) return;

  args.message = readTextFile(messageFile, 'messageFile');
  delete args.messageFile;
}

// ── dehydration ───────────────────────────────────────────────────────────────

/**
 * Post-process a backend response. Only export-actor with "outFile" is affected:
 * the actor source is written to disk and the response shrinks to a summary.
 * Anything unexpected (error response, non-JSON text, missing "data") passes through.
 */
export function dehydrateToolResult(name: string, args: ToolArgs | undefined, result: any): any {
  if (name !== 'export-actor') return result;

  const outFile = nonEmptyString(args?.outFile);
  if (!outFile) return result;
  if (!result || result.isError) return result;

  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (!isPlainObject(parsed) || parsed.data === undefined) return result;

  const resolved = path.resolve(outFile);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const json = JSON.stringify(parsed.data, null, 2);
    fs.writeFileSync(resolved, json, 'utf8');

    const summary = {
      uuid: parsed.uuid,
      name: parsed.name,
      type: parsed.type,
      itemCount: parsed.itemCount,
      bytes: Buffer.byteLength(json, 'utf8'),
      outFile: resolved,
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
  } catch (error) {
    return toolErrorResult(`Cannot write "outFile" ${resolved}: ${errorMessage(error)}`);
  }
}
