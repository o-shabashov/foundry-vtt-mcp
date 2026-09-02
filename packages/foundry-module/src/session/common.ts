import { MODULE_ID } from '../constants.js';

/**
 * Shared helpers for the session tool handlers (`files.*`, `scene.*`, `playlist.*`,
 * `journal.*`, `ownership.*`, `combat.*`, `chat.*`, `table.*`, `piles.*`).
 *
 * The bridge runs inside a headless GM client started with `core.noCanvas`, so
 * nothing here may touch `canvas.*`. Every placement, light, wall and token is
 * created through documents instead.
 *
 * Foundry types bundled with this package are 9.x, far older than the 14.x client
 * the bridge talks to, so runtime objects are reached through `any` casts on
 * purpose - see the sibling handlers for the same convention.
 */

/** Denial payload handed straight back to the caller when a gate rejects the call. */
export type AccessDenial = { success: false; error: string };

/** A point accepted by the session tools. `grid` counts squares from the scene origin. */
export interface SessionPoint {
  x: number;
  y: number;
  units?: 'px' | 'grid';
}

/** Ownership levels addressed by word instead of by number. */
const OWNERSHIP_WORDS: Record<string, number> = {
  inherit: -1,
  none: 0,
  limited: 1,
  observer: 2,
  owner: 3,
};

/** Fallback grid size when a scene reports nothing usable. */
const DEFAULT_GRID_SIZE = 100;

/** Upper bound on how long the `new Image()` fallback may wait for a texture. */
const IMAGE_PROBE_TIMEOUT_MS = 15000;

// --- Gates, auditing, errors -------------------------------------------------

/**
 * SECURITY: GM-only, plus the world-level write toggle for mutating handlers.
 * Returns a denial payload to send back verbatim, or null when the call may proceed.
 */
export function checkAccess(requiresWrite: boolean): AccessDenial | null {
  if (!game.user?.isGM) {
    // Silent failure - no detail for non-GM users
    return { success: false, error: 'Access denied' };
  }

  if (requiresWrite) {
    let allowed = true;
    try {
      allowed = game.settings.get(MODULE_ID, 'allowWriteOperations') !== false;
    } catch {
      allowed = true;
    }
    if (!allowed) {
      return { success: false, error: 'Write operations disabled' };
    }
  }

  return null;
}

/** Normalise anything thrown into a message string. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Audit a write the same way data-access does. `auditLog` is private to
 * FoundryDataAccess in TypeScript terms only, so it is reachable at runtime;
 * fall back to the console when it is not.
 */
export function audit(
  dataAccess: any,
  operation: string,
  data: any,
  result: 'success' | 'failure',
  error?: string
): void {
  const target = dataAccess;
  if (typeof target?.auditLog === 'function') {
    try {
      target.auditLog(`session.${operation}`, data, result, error);
      return;
    } catch {
      // fall through to console logging
    }
  }
  console.warn(`[${MODULE_ID}] session.${operation} ${result}`, data, error ?? '');
}

/** Foundry's global CONST table, reached loosely because the bundled types predate it. */
export function foundryConst(): any {
  return (globalThis as any).CONST ?? {};
}

/** Read a numeric CONST value with an explicit fallback for older or newer cores. */
export function constValue(path: string, fallback: any): any {
  const parts = path.split('.');
  let node: any = foundryConst();
  for (const part of parts) {
    if (node === null || node === undefined) return fallback;
    node = node[part];
  }
  return node === undefined || node === null ? fallback : node;
}

// --- Document resolution -----------------------------------------------------

/**
 * Resolve an actor identifier: UUID, then world id, then exact world name,
 * then a case-insensitive partial name match. An ambiguous partial match is an
 * error listing the candidates. With `packId` the lookup is confined to that pack.
 */
export async function resolveActor(identifier: string, packId?: string): Promise<any> {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new Error('actorIdentifier is required');
  }

  if (packId) {
    const pack = resolvePack(packId);
    const found = await findPackActor(pack, identifier);
    if (!found) {
      throw new Error(`Actor "${identifier}" not found in compendium ${pack.collection}`);
    }
    return found;
  }

  // 1. UUID (also covers Compendium.world.xxx.Actor.id)
  if (identifier.includes('.')) {
    try {
      const doc = await (globalThis as any).fromUuid(identifier);
      if (doc?.documentName === 'Actor') return doc;
    } catch {
      // not a UUID - fall through to the name/id lookups
    }
  }

  const actors = (game as any).actors;

  // 2. World id
  const byId = actors?.get(identifier);
  if (byId) return byId;

  // 3. Exact world name
  const byName = actors?.getName?.(identifier);
  if (byName) return byName;

  // 4. Case-insensitive partial name
  const needle = identifier.toLowerCase();
  const partial: any[] =
    actors?.filter(
      (a: any) => typeof a.name === 'string' && a.name.toLowerCase().includes(needle)
    ) ?? [];

  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const candidates = partial.map((a: any) => `${a.name} (${a.id})`).join(', ');
    throw new Error(`Ambiguous actorIdentifier "${identifier}" - candidates: ${candidates}`);
  }

  throw new Error(`Actor not found: ${identifier}`);
}

/** Find an actor inside a compendium by id or exact name. */
async function findPackActor(pack: any, identifier: string): Promise<any> {
  const byId = await pack.getDocument(identifier).catch(() => null);
  if (byId) return byId;

  const byName = await pack.getDocuments({ name: identifier }).catch(() => []);
  if (Array.isArray(byName) && byName.length > 0) return byName[0];

  const index: any[] = Array.from(await pack.getIndex());
  const entry = index.find((e: any) => e.name?.toLowerCase() === identifier.toLowerCase());
  if (entry) return await pack.getDocument(entry._id);

  return null;
}

/** Resolve a compendium by collection id, then exact label, then machine name. */
export function resolvePack(identifier: string): any {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new Error('pack is required');
  }

  const packs = (game as any).packs;
  const direct = packs?.get(identifier);
  if (direct) return direct;

  const all: any[] = Array.from(packs ?? []);
  const byLabel = all.find(p => p.metadata?.label === identifier);
  if (byLabel) return byLabel;

  const byName = all.find(p => p.metadata?.name === identifier);
  if (byName) return byName;

  throw new Error(`Compendium not found: ${identifier}`);
}

/**
 * Generic world-collection lookup: id, then exact name, then a case-insensitive
 * partial name. Ambiguity is reported with the candidate list.
 */
export function resolveInCollection(collection: any, identifier: string, label: string): any {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new Error(`${label} identifier is required`);
  }

  const byId = collection?.get?.(identifier);
  if (byId) return byId;

  const byName = collection?.getName?.(identifier);
  if (byName) return byName;

  const needle = identifier.toLowerCase();
  const all: any[] = Array.from(collection ?? []);
  const exact = all.filter((d: any) => d?.name === identifier);
  if (exact.length === 1) return exact[0];

  const partial = all.filter(
    (d: any) => typeof d?.name === 'string' && d.name.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const candidates = partial.map((d: any) => `${d.name} (${d.id})`).join(', ');
    throw new Error(`Ambiguous ${label} "${identifier}" - candidates: ${candidates}`);
  }

  throw new Error(`${label} not found: ${identifier}`);
}

/**
 * Resolve the scene a call operates on. Without an identifier the active scene is
 * used, and a world with no active scene is an error rather than a silent no-op.
 */
export function resolveScene(identifier?: string): any {
  const scenes = (game as any).scenes;

  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    const active = scenes?.active ?? scenes?.current;
    if (!active) {
      throw new Error('No scene given and no active scene in this world - pass "scene" explicitly');
    }
    return active;
  }

  return resolveInCollection(scenes, identifier, 'Scene');
}

/** Resolve a JournalEntry by UUID, id, exact name or partial name. */
export async function resolveJournal(identifier: string): Promise<any> {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new Error('journal identifier is required');
  }

  if (identifier.includes('.')) {
    try {
      const doc = await (globalThis as any).fromUuid(identifier);
      if (doc?.documentName === 'JournalEntry') return doc;
      if (doc?.documentName === 'JournalEntryPage') return doc.parent;
    } catch {
      // not a UUID - fall through
    }
  }

  return resolveInCollection((game as any).journal, identifier, 'JournalEntry');
}

/** Resolve one page inside a journal by id, exact name or partial name. */
export function resolveJournalPage(journal: any, identifier: string): any {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new Error('page identifier is required');
  }

  const pages: any[] = journal?.pages?.contents ?? Array.from(journal?.pages ?? []);
  const byId = pages.find(p => p.id === identifier);
  if (byId) return byId;

  const exact = pages.filter(p => p.name === identifier);
  if (exact.length === 1) return exact[0];

  const needle = identifier.toLowerCase();
  const partial = pages.filter(
    p => typeof p.name === 'string' && p.name.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const candidates = partial.map(p => `${p.name} (${p.id})`).join(', ');
    throw new Error(`Ambiguous page "${identifier}" - candidates: ${candidates}`);
  }

  throw new Error(`Page not found in journal "${journal?.name}": ${identifier}`);
}

// --- Users and ownership -----------------------------------------------------

/** Every non-GM user in the world, active or not. */
export function playerUsers(): any[] {
  const all: any[] = Array.from((game as any).users ?? []);
  return all.filter(u => u?.isGM !== true);
}

/** Resolve a single user by id, exact name or case-insensitive partial name. */
export function resolveUserId(identifier: string): string {
  const all: any[] = Array.from((game as any).users ?? []);

  const byId = all.find(u => u.id === identifier);
  if (byId) return byId.id;

  const exact = all.filter(u => u.name === identifier);
  if (exact.length === 1) return exact[0].id;

  const needle = identifier.toLowerCase();
  const partial = all.filter(
    u => typeof u.name === 'string' && u.name.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    const candidates = partial.map(u => `${u.name} (${u.id})`).join(', ');
    throw new Error(`Ambiguous user "${identifier}" - candidates: ${candidates}`);
  }

  throw new Error(`User not found: ${identifier}`);
}

/**
 * Turn a `users` argument into user ids. `all`, `players`, an empty array and an
 * omitted value all mean "every non-GM user"; `gm` means every GM.
 */
export function resolveUserIds(spec?: string[] | string): string[] {
  if (spec === undefined || spec === null || spec === 'all' || spec === 'players') {
    return playerUsers().map(u => u.id);
  }

  const entries = Array.isArray(spec) ? spec : [spec];
  if (entries.length === 0) return playerUsers().map(u => u.id);

  const all: any[] = Array.from((game as any).users ?? []);
  const ids = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    const key = entry.trim();
    const lower = key.toLowerCase();

    if (lower === 'all' || lower === 'players') {
      for (const user of playerUsers()) ids.add(user.id);
      continue;
    }
    if (lower === 'gm' || lower === 'gms') {
      for (const user of all.filter(u => u?.isGM === true)) ids.add(user.id);
      continue;
    }

    ids.add(resolveUserId(key));
  }

  if (ids.size === 0) {
    throw new Error('users resolved to nobody - pass names, ids, "all" or "players"');
  }

  return Array.from(ids);
}

/** Translate an ownership level given as a word or a number into Foundry's numeric level. */
export function ownershipLevel(value: any, what = 'ownership level'): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= 3) {
    return value;
  }
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (key in OWNERSHIP_WORDS) return OWNERSHIP_WORDS[key];
  }
  throw new Error(
    `${what}: expected one of none, limited, observer, owner, inherit (got ${String(value)})`
  );
}

/** Merge an ownership request onto a document's current ownership map. */
export function buildOwnership(
  current: any,
  spec: { default?: any; players?: any; users?: Record<string, any> } | undefined
): Record<string, number> {
  const ownership: Record<string, number> = { ...(current ?? {}) };
  if (!spec) return ownership;

  if (spec.default !== undefined) {
    ownership.default = ownershipLevel(spec.default, 'ownership.default');
  }

  if (spec.players !== undefined) {
    const level = ownershipLevel(spec.players, 'ownership.players');
    for (const user of playerUsers()) ownership[user.id] = level;
  }

  if (spec.users && typeof spec.users === 'object') {
    for (const [nameOrId, level] of Object.entries(spec.users)) {
      ownership[resolveUserId(nameOrId)] = ownershipLevel(level, `ownership.users["${nameOrId}"]`);
    }
  }

  return ownership;
}

// --- Folders -----------------------------------------------------------------

/**
 * Find, or create, a folder of the given document type by name. Mirrors the
 * folder helper used by the raw handlers, generalised past Actor folders.
 */
export async function getOrCreateFolder(
  folderName: string | undefined,
  type: string
): Promise<string | null> {
  if (typeof folderName !== 'string' || folderName.trim().length === 0) return null;

  const name = folderName.trim();
  try {
    const existing = (game as any).folders?.find((f: any) => f.name === name && f.type === type);
    if (existing) return existing.id;

    const folder = await (globalThis as any).Folder.create({
      name,
      type,
      sort: 0,
      parent: null,
      flags: {
        [MODULE_ID]: {
          mcpGenerated: true,
          createdAt: new Date().toISOString(),
        },
      },
    });
    return folder?.id ?? null;
  } catch (error) {
    console.warn(
      `[${MODULE_ID}] Failed to create ${type} folder "${name}": ${describeError(error)}`
    );
    // Fall back to a folderless document rather than failing the whole call
    return null;
  }
}

// --- Coordinates -------------------------------------------------------------

/** Grid square size of a scene, in pixels. */
export function gridSizeOf(scene: any): number {
  const size = scene?.grid?.size ?? scene?.grid?.sizeX ?? scene?.gridSize;
  return typeof size === 'number' && size > 0 ? size : DEFAULT_GRID_SIZE;
}

/** Distance covered by one grid square, in scene units. */
export function gridDistanceOf(scene: any): number {
  const distance = scene?.grid?.distance;
  return typeof distance === 'number' && distance > 0 ? distance : 5;
}

/**
 * Top-left corner of the background image in scene pixel space. Foundry pads the
 * canvas around the image, so grid square 0,0 sits at `sceneX/sceneY`, not at 0,0.
 */
export function sceneOrigin(scene: any): { x: number; y: number } {
  const dimensions = scene?.dimensions;
  if (typeof dimensions?.sceneX === 'number' && typeof dimensions?.sceneY === 'number') {
    return { x: dimensions.sceneX, y: dimensions.sceneY };
  }

  // Fallback for a client that cannot compute dimensions: padding rounded up to whole squares
  const size = gridSizeOf(scene);
  const padding = typeof scene?.padding === 'number' ? scene.padding : 0;
  const width = Number(scene?.width) || 0;
  const height = Number(scene?.height) || 0;

  return {
    x: Math.ceil((padding * width) / size) * size,
    y: Math.ceil((padding * height) / size) * size,
  };
}

/**
 * Convert a `{ x, y, units }` point into scene pixels. `grid` (the default) counts
 * squares from the top-left corner of the background image; fractions are allowed.
 */
export function pointToPixels(
  scene: any,
  point: SessionPoint | undefined,
  what = 'position'
): { x: number; y: number } {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    throw new Error(`${what}: numeric "x" and "y" are required`);
  }

  const units = point.units ?? 'grid';
  if (units === 'px') return { x: point.x, y: point.y };
  if (units !== 'grid') {
    throw new Error(`${what}: "units" must be "px" or "grid" (got ${String(units)})`);
  }

  const size = gridSizeOf(scene);
  const origin = sceneOrigin(scene);
  return { x: origin.x + point.x * size, y: origin.y + point.y * size };
}

/** Convert a length given in grid squares or pixels into pixels. */
export function lengthToPixels(scene: any, value: number, units?: 'px' | 'grid'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('length must be a finite number');
  }
  return (units ?? 'grid') === 'px' ? value : value * gridSizeOf(scene);
}

// --- Files and textures ------------------------------------------------------

/** The FilePicker implementation class, whichever namespace this core exposes it in. */
export function getFilePicker(): any {
  const globalAny = globalThis as any;
  const picker =
    globalAny.foundry?.applications?.apps?.FilePicker?.implementation ??
    globalAny.FilePicker?.implementation ??
    globalAny.FilePicker;

  if (!picker) {
    throw new Error('FilePicker is unavailable in this Foundry build');
  }
  return picker;
}

/**
 * Native pixel size of an image in the Data directory. `foundry.canvas.loadTexture`
 * works even in the headless client; `new Image()` is the fallback for anything it
 * cannot decode.
 */
export async function imageDimensions(path: string): Promise<{ width: number; height: number }> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('image path is required to measure its dimensions');
  }

  const loadTexture = (globalThis as any).foundry?.canvas?.loadTexture;
  if (typeof loadTexture === 'function') {
    try {
      const texture: any = await loadTexture(path);
      const width = texture?.width ?? texture?.orig?.width ?? texture?.baseTexture?.width;
      const height = texture?.height ?? texture?.orig?.height ?? texture?.baseTexture?.height;
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        return { width: Math.round(width), height: Math.round(height) };
      }
    } catch {
      // fall through to the Image fallback
    }
  }

  const ImageCtor = (globalThis as any).Image;
  if (typeof ImageCtor === 'function') {
    try {
      return await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new ImageCtor();
        const timer = setTimeout(() => {
          reject(new Error(`Timed out loading image "${path}"`));
        }, IMAGE_PROBE_TIMEOUT_MS);

        image.onload = (): void => {
          clearTimeout(timer);
          const width = image.naturalWidth || image.width;
          const height = image.naturalHeight || image.height;
          if (width > 0 && height > 0) resolve({ width, height });
          else reject(new Error(`Image "${path}" reported no dimensions`));
        };
        image.onerror = (): void => {
          clearTimeout(timer);
          reject(new Error(`Failed to load image "${path}"`));
        };
        image.src = path;
      });
    } catch {
      // fall through to the explicit-size error
    }
  }

  throw new Error(
    `Could not determine the pixel size of "${path}" - pass width and height explicitly`
  );
}

// --- Query registration ------------------------------------------------------

/** Turn a dashed action name into its camelCase alias. */
function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Register one handler under `<module>.<namespace>.<action>` for every action it
 * accepts, plus a `<module>.<namespace>.manage` entry point that reads the action
 * out of the payload. Dashed actions also get a camelCase alias so either spelling
 * reaches the same code.
 */
export function registerNamespaceQueries(
  namespace: string,
  actions: readonly string[],
  handler: (data: any) => Promise<any>
): void {
  const base = `${MODULE_ID}.${namespace}`;
  CONFIG.queries[`${base}.manage`] = handler;

  for (const action of actions) {
    const bound = (data: any): Promise<any> => handler({ ...(data ?? {}), action });
    CONFIG.queries[`${base}.${action}`] = bound;

    const camel = toCamelCase(action);
    if (camel !== action) CONFIG.queries[`${base}.${camel}`] = bound;
  }
}

/** Report an unknown action with the full list of the ones that do work. */
export function unknownAction(action: unknown, valid: readonly string[]): Error {
  return new Error(`Unknown action "${String(action)}". Valid actions: ${valid.join(', ')}`);
}
