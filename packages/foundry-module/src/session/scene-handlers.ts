import { MODULE_ID } from '../constants.js';
import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  buildOwnership,
  checkAccess,
  constValue,
  describeError,
  getOrCreateFolder,
  gridDistanceOf,
  gridSizeOf,
  imageDimensions,
  lengthToPixels,
  pointToPixels,
  registerNamespaceQueries,
  resolveActor,
  resolveInCollection,
  resolveJournal,
  resolveJournalPage,
  resolveScene,
  sceneOrigin,
  unknownAction,
} from './common.js';

/**
 * Scene handlers: the scene document itself plus everything embedded in it -
 * tokens, ambient lights, walls, tiles and journal notes.
 *
 * The bridge client runs with `core.noCanvas`, so every placement goes through
 * `scene.createEmbeddedDocuments(...)`. Nothing here reads `canvas`.
 */

const SCENE_ACTIONS = ['create', 'update', 'delete', 'activate', 'list', 'info'] as const;
const LIGHT_ACTIONS = ['create', 'update', 'delete', 'list', 'clear'] as const;
const WALL_ACTIONS = ['create', 'delete', 'clear', 'list', 'import-uvtt', 'box'] as const;
const TILE_ACTIONS = ['create', 'delete', 'list', 'update'] as const;
const NOTE_ACTIONS = ['create', 'delete', 'list'] as const;

/** Default folder for actors pulled out of a compendium by place-tokens. */
const DEFAULT_IMPORT_FOLDER = 'Imported Actors';

/** Light presets addressed by word. Explicit fields always win over the preset. */
const LIGHT_PRESETS: Record<string, Record<string, any>> = {
  torch: { animation: 'torch', color: '#ff9329', bright: 20, dim: 40 },
  campfire: { animation: 'flame', color: '#ff6a00', bright: 15, dim: 30 },
  candle: { animation: 'torch', color: '#ffd37a', bright: 5, dim: 10 },
  moonlight: { animation: 'none', color: '#8fa9ff', bright: 0, dim: 60, alpha: 0.2 },
  lantern: { animation: 'torch', color: '#f5d576', bright: 30, dim: 60 },
  magical: { animation: 'pulse', color: '#8a5cf5', bright: 15, dim: 30, alpha: 0.4 },
};

/** Token disposition words mapped onto Foundry's numeric constants. */
function dispositionValue(word: unknown): number {
  const key = String(word ?? 'hostile').toLowerCase();
  switch (key) {
    case 'hostile':
      return constValue('TOKEN_DISPOSITIONS.HOSTILE', -1);
    case 'neutral':
      return constValue('TOKEN_DISPOSITIONS.NEUTRAL', 0);
    case 'friendly':
      return constValue('TOKEN_DISPOSITIONS.FRIENDLY', 1);
    case 'secret':
      return constValue('TOKEN_DISPOSITIONS.SECRET', -2);
    default:
      throw new Error(
        `Unknown disposition "${String(word)}". Valid: hostile, neutral, friendly, secret`
      );
  }
}

/** Grid type words mapped onto CONST.GRID_TYPES. */
function gridTypeValue(word: unknown): number {
  const key = String(word ?? 'square');
  switch (key) {
    case 'square':
      return constValue('GRID_TYPES.SQUARE', 1);
    case 'hexOdd':
      return constValue('GRID_TYPES.HEXODDR', 2);
    case 'hexEven':
      return constValue('GRID_TYPES.HEXEVENR', 3);
    case 'gridless':
      return constValue('GRID_TYPES.GRIDLESS', 0);
    default:
      throw new Error(`Unknown gridType "${key}". Valid: square, hexOdd, hexEven, gridless`);
  }
}

/** The document class behind a world collection, preferring the system's subclass. */
function documentClass(name: string): any {
  const globalAny = globalThis as any;
  const cls = globalAny[name];
  return cls?.implementation ?? cls;
}

export class SceneHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    const prefix = `${MODULE_ID}.scene`;

    registerNamespaceQueries('scene', SCENE_ACTIONS, this.handleScene.bind(this));

    CONFIG.queries[`${prefix}.placeTokens`] = this.handlePlaceTokens.bind(this);
    CONFIG.queries[`${prefix}.place-tokens`] = this.handlePlaceTokens.bind(this);
    CONFIG.queries[`${prefix}.lights`] = this.handleLights.bind(this);
    CONFIG.queries[`${prefix}.walls`] = this.handleWalls.bind(this);
    CONFIG.queries[`${prefix}.tiles`] = this.handleTiles.bind(this);
    CONFIG.queries[`${prefix}.notes`] = this.handleNotes.bind(this);
  }

  // --- 2.1 manage-scene ------------------------------------------------------

  private async handleScene(data: any): Promise<any> {
    const action = data?.action;
    const isWrite = action !== 'list' && action !== 'info';

    const denied = checkAccess(isWrite);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    switch (action) {
      case 'create':
        return await this.createScene(data);
      case 'update':
        return await this.updateScene(data);
      case 'delete':
        return await this.deleteScene(data);
      case 'activate':
        return await this.activateScene(data);
      case 'list':
        return this.listScenes();
      case 'info':
        return this.sceneInfo(data);
      default:
        throw unknownAction(action, SCENE_ACTIONS);
    }
  }

  private async createScene(data: any): Promise<any> {
    const name = data?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('name is required to create a scene');
    }
    const background = data?.background;
    if (typeof background !== 'string' || background.trim().length === 0) {
      throw new Error('background (a path to an image in the Data directory) is required');
    }

    let width = typeof data?.width === 'number' ? data.width : null;
    let height = typeof data?.height === 'number' ? data.height : null;
    if (width === null || height === null) {
      const measured = await imageDimensions(background);
      width = width ?? measured.width;
      height = height ?? measured.height;
    }

    const darkness = typeof data?.darkness === 'number' ? data.darkness : 0;
    const globalLight = typeof data?.globalLight === 'boolean' ? data.globalLight : darkness === 0;

    const sceneData: Record<string, any> = {
      name: name.trim(),
      background: { src: background },
      width,
      height,
      padding: typeof data?.padding === 'number' ? data.padding : 0.25,
      grid: {
        type: gridTypeValue(data?.gridType ?? 'square'),
        size: typeof data?.gridSize === 'number' ? data.gridSize : 100,
        distance: typeof data?.gridDistance === 'number' ? data.gridDistance : 5,
        units: typeof data?.gridUnits === 'string' ? data.gridUnits : 'ft',
      },
      tokenVision: data?.tokenVision !== false,
      fog: { exploration: data?.fogExploration !== false },
      environment: {
        darknessLevel: darkness,
        globalLight: { enabled: globalLight },
      },
      navigation: data?.navigation !== false,
    };

    if (typeof data?.navName === 'string') sceneData.navName = data.navName;
    if (data?.initialView) sceneData.initial = SceneHandlers.buildInitialView(data.initialView);
    if (typeof data?.backgroundColor === 'string') {
      SceneHandlers.applyBackgroundColor(sceneData, data.backgroundColor);
    }

    const folderId = await getOrCreateFolder(data?.folder, 'Scene');
    if (folderId) sceneData.folder = folderId;

    if (typeof data?.playlist === 'string' && data.playlist.trim().length > 0) {
      sceneData.playlist = resolveInCollection(
        (game as any).playlists,
        data.playlist,
        'Playlist'
      ).id;
    }

    if (data?.ownership) {
      sceneData.ownership = buildOwnership({}, data.ownership);
    }

    const scene = await documentClass('Scene').create(sceneData);
    if (!scene) throw new Error(`Foundry returned no document when creating scene "${name}"`);

    await SceneHandlers.applyBackground(scene, background);

    if (data?.activate === true) await scene.activate();

    audit(this.dataAccess, 'scene.create', { name: scene.name, id: scene.id }, 'success');

    return {
      id: scene.id,
      name: scene.name,
      width: scene.width,
      height: scene.height,
      gridSize: gridSizeOf(scene),
      uuid: scene.uuid,
      active: scene.active === true,
    };
  }

  private async updateScene(data: any): Promise<any> {
    const scene = resolveScene(data?.scene);
    const update: Record<string, any> = {};

    if (typeof data?.name === 'string') update.name = data.name;
    if (typeof data?.background === 'string') await SceneHandlers.applyBackground(scene, data.background);
    if (typeof data?.width === 'number') update.width = data.width;
    if (typeof data?.height === 'number') update.height = data.height;
    if (typeof data?.padding === 'number') update.padding = data.padding;
    if (typeof data?.navigation === 'boolean') update.navigation = data.navigation;
    if (typeof data?.navName === 'string') update.navName = data.navName;
    if (typeof data?.tokenVision === 'boolean') update.tokenVision = data.tokenVision;
    if (typeof data?.fogExploration === 'boolean') {
      update.fog = { exploration: data.fogExploration };
    }

    const grid: Record<string, any> = {};
    if (data?.gridType !== undefined) grid.type = gridTypeValue(data.gridType);
    if (typeof data?.gridSize === 'number') grid.size = data.gridSize;
    if (typeof data?.gridDistance === 'number') grid.distance = data.gridDistance;
    if (typeof data?.gridUnits === 'string') grid.units = data.gridUnits;
    if (Object.keys(grid).length > 0) update.grid = grid;

    const environment: Record<string, any> = {};
    if (typeof data?.darkness === 'number') environment.darknessLevel = data.darkness;
    if (typeof data?.globalLight === 'boolean') {
      environment.globalLight = { enabled: data.globalLight };
    }
    if (Object.keys(environment).length > 0) update.environment = environment;

    if (typeof data?.backgroundColor === 'string') {
      SceneHandlers.applyBackgroundColor(update, data.backgroundColor);
    }
    if (data?.initialView) update.initial = SceneHandlers.buildInitialView(data.initialView);

    if (typeof data?.folder === 'string') {
      update.folder = await getOrCreateFolder(data.folder, 'Scene');
    }
    if (typeof data?.playlist === 'string') {
      update.playlist =
        data.playlist.trim().length === 0
          ? null
          : resolveInCollection((game as any).playlists, data.playlist, 'Playlist').id;
    }
    if (data?.ownership) {
      update.ownership = buildOwnership(scene.ownership, data.ownership);
    }

    if (Object.keys(update).length === 0) {
      throw new Error('update needs at least one field to change');
    }

    await scene.update(update);
    if (data?.activate === true) await scene.activate();

    audit(this.dataAccess, 'scene.update', { id: scene.id, keys: Object.keys(update) }, 'success');

    return { id: scene.id, name: scene.name, uuid: scene.uuid, updated: Object.keys(update) };
  }

  private async deleteScene(data: any): Promise<any> {
    const scene = resolveScene(data?.scene);
    const ref = { id: scene.id, name: scene.name, uuid: scene.uuid };
    await scene.delete();

    audit(this.dataAccess, 'scene.delete', ref, 'success');

    return { deleted: true, ...ref };
  }

  private async activateScene(data: any): Promise<any> {
    const scene = resolveScene(data?.scene);
    await scene.activate();

    audit(this.dataAccess, 'scene.activate', { id: scene.id, name: scene.name }, 'success');

    return { id: scene.id, name: scene.name, active: true };
  }

  private listScenes(): any[] {
    const scenes: any[] = Array.from((game as any).scenes ?? []);

    return scenes.map(scene => ({
      id: scene.id,
      name: scene.name,
      active: scene.active === true,
      navigation: scene.navigation === true,
      width: scene.width,
      height: scene.height,
      gridSize: gridSizeOf(scene),
      tokens: scene.tokens?.size ?? 0,
      folder: scene.folder?.name ?? null,
      uuid: scene.uuid,
    }));
  }

  private sceneInfo(data: any): any {
    const scene = resolveScene(data?.scene);
    const origin = sceneOrigin(scene);

    return {
      id: scene.id,
      name: scene.name,
      uuid: scene.uuid,
      active: scene.active === true,
      navigation: scene.navigation === true,
      navName: scene.navName ?? null,
      background: SceneHandlers.readBackground(scene),
      width: scene.width,
      height: scene.height,
      padding: scene.padding,
      origin,
      grid: {
        type: scene.grid?.type,
        size: gridSizeOf(scene),
        distance: gridDistanceOf(scene),
        units: scene.grid?.units ?? null,
      },
      tokenVision: scene.tokenVision === true,
      fogExploration: scene.fog?.exploration === true,
      darkness: scene.environment?.darknessLevel ?? null,
      globalLight: scene.environment?.globalLight?.enabled ?? null,
      playlist: scene.playlist?.name ?? null,
      folder: scene.folder?.name ?? null,
      ownership: scene.ownership ?? {},
      counts: {
        tokens: scene.tokens?.size ?? 0,
        lights: scene.lights?.size ?? 0,
        walls: scene.walls?.size ?? 0,
        tiles: scene.tiles?.size ?? 0,
        notes: scene.notes?.size ?? 0,
        sounds: scene.sounds?.size ?? 0,
      },
    };
  }

  /**
   * Foundry 14 keeps the background image on the scene's default Level document
   * (`scene.levels`), and ignores a top-level `background.src` on create. Older cores
   * still use the top-level field, so both paths are handled.
   */
  private static async applyBackground(scene: any, src: string): Promise<void> {
    const level = scene.levels?.contents?.[0] ?? null;
    if (level) {
      await scene.updateEmbeddedDocuments('Level', [{ _id: level.id, 'background.src': src }]);
      return;
    }
    await scene.update({ 'background.src': src });
  }

  private static readBackground(scene: any): string | null {
    const level = scene.levels?.contents?.[0] ?? null;
    return level?.background?.src ?? scene.background?.src ?? null;
  }

  /** `backgroundColor` sits at the top level on some cores and under `environment` on others. */
  private static applyBackgroundColor(target: Record<string, any>, color: string): void {
    const cls = documentClass('Scene');
    const fields = cls?.schema?.fields;

    if (fields && !fields.backgroundColor && fields.environment?.fields?.backgroundColor) {
      target.environment = { ...(target.environment ?? {}), backgroundColor: color };
      return;
    }
    target.backgroundColor = color;
  }

  private static buildInitialView(view: any): Record<string, any> {
    const initial: Record<string, any> = {};
    if (typeof view?.x === 'number') initial.x = view.x;
    if (typeof view?.y === 'number') initial.y = view.y;
    if (typeof view?.scale === 'number') initial.scale = view.scale;
    return initial;
  }

  // --- 2.2 place-tokens ------------------------------------------------------

  private async handlePlaceTokens(data: any): Promise<any> {
    const denied = checkAccess(true);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);
    const entries = data?.tokens;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('tokens array is required and must contain at least one entry');
    }

    const folderName =
      typeof data?.importCompendiumTo === 'string' && data.importCompendiumTo.trim().length > 0
        ? data.importCompendiumTo.trim()
        : DEFAULT_IMPORT_FOLDER;

    const gridSize = gridSizeOf(scene);
    const importCache = new Map<string, any>();
    const importedActors: Array<{ id: string; name: string; source: string }> = [];
    const payload: any[] = [];

    for (const [index, entry] of entries.entries()) {
      const actor = await this.resolveTokenActor(
        entry?.actor,
        folderName,
        importCache,
        importedActors
      );

      const base = pointToPixels(
        scene,
        { x: entry?.x, y: entry?.y, units: entry?.units },
        `tokens[${index}]`
      );
      const count = Math.max(1, Math.floor(Number(entry?.count ?? 1)));
      const baseName = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : null;

      for (let copy = 0; copy < count; copy += 1) {
        const overrides: Record<string, any> = {
          x: base.x + copy * gridSize,
          y: base.y,
        };

        const name = baseName ?? actor.name;
        if (count > 1) overrides.name = `${name} ${copy + 1}`;
        else if (baseName) overrides.name = baseName;

        if (typeof entry?.hidden === 'boolean') overrides.hidden = entry.hidden;
        if (entry?.disposition !== undefined) {
          overrides.disposition = dispositionValue(entry.disposition);
        }
        if (typeof entry?.elevation === 'number') overrides.elevation = entry.elevation;

        const tokenData = await SceneHandlers.tokenSource(actor, scene, overrides);

        if (typeof entry?.scale === 'number') {
          tokenData.texture = {
            ...(tokenData.texture ?? {}),
            scaleX: entry.scale,
            scaleY: entry.scale,
          };
        }

        payload.push(tokenData);
      }
    }

    const createdDocs = (await scene.createEmbeddedDocuments('Token', payload)) as any[];
    const created = (createdDocs ?? []).map(doc => ({
      tokenId: doc.id,
      actorId: doc.actorId ?? doc.actor?.id ?? null,
      name: doc.name,
      x: doc.x,
      y: doc.y,
    }));

    audit(
      this.dataAccess,
      'scene.placeTokens',
      { sceneId: scene.id, created: created.length, imported: importedActors.length },
      'success'
    );

    return { sceneId: scene.id, sceneName: scene.name, created, importedActors };
  }

  /**
   * Token source data for one placement. `Actor#getTokenDocument` applies the
   * prototype token, the linked-actor delta and the system's own defaults, so it is
   * the preferred route; a client that lacks it falls back to the prototype token.
   */
  private static async tokenSource(
    actor: any,
    scene: any,
    overrides: Record<string, any>
  ): Promise<Record<string, any>> {
    let tokenData: Record<string, any> | null = null;

    if (typeof actor?.getTokenDocument === 'function') {
      try {
        const tokenDoc = await actor.getTokenDocument(overrides, { parent: scene });
        if (tokenDoc?.toObject) tokenData = tokenDoc.toObject();
      } catch (error) {
        console.warn(
          `[${MODULE_ID}] getTokenDocument failed for "${actor?.name}", falling back to the prototype token: ${describeError(error)}`
        );
      }
    }

    if (!tokenData) {
      const prototype: Record<string, any> = actor?.prototypeToken?.toObject
        ? actor.prototypeToken.toObject()
        : { name: actor?.name };
      const fallback: Record<string, any> = {
        ...prototype,
        ...overrides,
        actorId: actor?.id,
      };
      tokenData = fallback;
    }

    delete tokenData._id;
    return tokenData;
  }

  /**
   * Resolve the actor a token entry points at. Compendium actors are imported into
   * the world once per world, not once per token: an earlier import is recognised by
   * `_stats.compendiumSource` (or the legacy `flags.core.sourceId`) and reused.
   */
  private async resolveTokenActor(
    identifier: string,
    folderName: string,
    cache: Map<string, any>,
    imported: Array<{ id: string; name: string; source: string }>
  ): Promise<any> {
    const doc = await resolveActor(identifier);
    if (!doc?.pack) return doc;

    const uuid = doc.uuid;
    const cached = cache.get(uuid);
    if (cached) return cached;

    const existing = (game as any).actors?.find(
      (a: any) =>
        a?._stats?.compendiumSource === uuid ||
        a?.flags?.core?.sourceId === uuid ||
        a?.getFlag?.('core', 'sourceId') === uuid
    );
    if (existing) {
      cache.set(uuid, existing);
      return existing;
    }

    const folderId = await getOrCreateFolder(folderName, 'Actor');
    const updateData: Record<string, any> = folderId ? { folder: folderId } : {};
    let created: any = null;

    const collection = (game as any).actors;
    const pack = (game as any).packs?.get(doc.pack);
    if (pack && typeof collection?.importFromCompendium === 'function') {
      try {
        created = await collection.importFromCompendium(pack, doc.id, updateData, {
          keepId: false,
        });
      } catch (error) {
        console.warn(
          `[${MODULE_ID}] importFromCompendium failed for ${uuid}: ${describeError(error)}`
        );
      }
    }

    if (!created) {
      // Manual import: strip the compendium ids and leave our own trail back to the pack
      const source = doc.toObject();
      delete source._id;
      delete source.folder;
      source._stats = { ...(source._stats ?? {}), compendiumSource: uuid };
      source.flags = {
        ...(source.flags ?? {}),
        core: { ...(source.flags?.core ?? {}), sourceId: uuid },
      };
      if (folderId) source.folder = folderId;
      created = await documentClass('Actor').create(source);
    }

    if (!created) throw new Error(`Could not import actor ${uuid} into the world`);

    cache.set(uuid, created);
    imported.push({ id: created.id, name: created.name, source: uuid });
    return created;
  }

  // --- 2.3 manage-scene-lights ----------------------------------------------

  private async handleLights(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);

    switch (action) {
      case 'create': {
        const lights = SceneHandlers.requireArray(data?.lights, 'lights');
        const payload = lights.map((light, index) =>
          SceneHandlers.buildLightData(scene, light, `lights[${index}]`)
        );
        const created = (await scene.createEmbeddedDocuments('AmbientLight', payload)) as any[];
        audit(
          this.dataAccess,
          'scene.lights.create',
          { sceneId: scene.id, count: created?.length ?? 0 },
          'success'
        );
        return { created: created?.length ?? 0, ids: (created ?? []).map(doc => doc.id) };
      }

      case 'update': {
        const lights = SceneHandlers.requireArray(data?.lights, 'lights');
        const updates = lights.map((light, index) => {
          if (typeof light?.id !== 'string' || light.id.length === 0) {
            throw new Error(`lights[${index}]: "id" is required to update a light`);
          }
          const built = SceneHandlers.buildLightData(scene, light, `lights[${index}]`, true);
          return { _id: light.id, ...built };
        });
        const updated = (await scene.updateEmbeddedDocuments('AmbientLight', updates)) as any[];
        audit(
          this.dataAccess,
          'scene.lights.update',
          { sceneId: scene.id, count: updated?.length ?? 0 },
          'success'
        );
        return { updated: updated?.length ?? 0 };
      }

      case 'delete': {
        const ids = SceneHandlers.requireArray(data?.ids, 'ids');
        const deleted = (await scene.deleteEmbeddedDocuments('AmbientLight', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.lights.delete',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { deleted: deleted?.length ?? 0 };
      }

      case 'clear': {
        const ids = Array.from(scene.lights ?? []).map((light: any) => light.id);
        const deleted = (await scene.deleteEmbeddedDocuments('AmbientLight', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.lights.clear',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { deleted: deleted?.length ?? 0 };
      }

      case 'list': {
        const lights: any[] = Array.from(scene.lights ?? []);
        return lights.map(light => ({
          id: light.id,
          x: light.x,
          y: light.y,
          rotation: light.rotation,
          hidden: light.hidden === true,
          walls: light.walls !== false,
          vision: light.vision === true,
          config: {
            bright: light.config?.bright,
            dim: light.config?.dim,
            color: light.config?.color ?? null,
            alpha: light.config?.alpha,
            angle: light.config?.angle,
            luminosity: light.config?.luminosity,
            negative: light.config?.negative === true,
            animation: light.config?.animation?.type ?? null,
          },
        }));
      }

      default:
        throw unknownAction(action, LIGHT_ACTIONS);
    }
  }

  /**
   * Build AmbientLight data. `bright` and `dim` are radii in scene distance units,
   * which is exactly what `config.bright` and `config.dim` hold.
   * With `sparse` only the fields the caller actually passed are emitted, so an
   * update never resets the rest of the light.
   */
  private static buildLightData(
    scene: any,
    light: any,
    what: string,
    sparse = false
  ): Record<string, any> {
    const preset =
      typeof light?.preset === 'string' ? (LIGHT_PRESETS[light.preset.toLowerCase()] ?? {}) : {};
    if (typeof light?.preset === 'string' && !LIGHT_PRESETS[light.preset.toLowerCase()]) {
      throw new Error(
        `${what}: unknown preset "${light.preset}". Valid: ${Object.keys(LIGHT_PRESETS).join(', ')}`
      );
    }

    const merged: Record<string, any> = { ...preset, ...SceneHandlers.definedOnly(light) };
    const data: Record<string, any> = {};
    const config: Record<string, any> = {};

    const hasPosition = typeof light?.x === 'number' && typeof light?.y === 'number';
    if (hasPosition || !sparse) {
      const point = pointToPixels(scene, { x: merged.x, y: merged.y, units: merged.units }, what);
      data.x = point.x;
      data.y = point.y;
    }

    if (merged.rotation !== undefined) data.rotation = merged.rotation;
    if (merged.hidden !== undefined) data.hidden = merged.hidden === true;
    data.walls = merged.walls !== undefined ? merged.walls !== false : sparse ? undefined : true;
    data.vision = merged.vision !== undefined ? merged.vision === true : sparse ? undefined : false;
    if (data.walls === undefined) delete data.walls;
    if (data.vision === undefined) delete data.vision;

    if (merged.bright !== undefined || !sparse) config.bright = merged.bright ?? 20;
    if (merged.dim !== undefined || !sparse) config.dim = merged.dim ?? 40;
    if (merged.alpha !== undefined || !sparse) config.alpha = merged.alpha ?? 0.5;
    if (merged.angle !== undefined || !sparse) config.angle = merged.angle ?? 360;
    if (merged.color !== undefined) config.color = merged.color;
    if (merged.luminosity !== undefined) config.luminosity = merged.luminosity;
    if (merged.negative !== undefined) config.negative = merged.negative === true;

    if (merged.animation !== undefined || !sparse) {
      const type = merged.animation ?? 'none';
      config.animation = {
        type: type === 'none' || type === null ? null : String(type),
        speed: merged.animationSpeed ?? 5,
        intensity: merged.animationIntensity ?? 5,
      };
    }

    if (Object.keys(config).length > 0) data.config = config;
    return data;
  }

  // --- 2.4 manage-walls ------------------------------------------------------

  private async handleWalls(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);

    switch (action) {
      case 'create': {
        const walls = SceneHandlers.requireArray(data?.walls, 'walls');
        const payload = walls.map((wall, index) =>
          SceneHandlers.buildWallData(scene, wall, `walls[${index}]`)
        );
        const created = (await scene.createEmbeddedDocuments('Wall', payload)) as any[];
        audit(
          this.dataAccess,
          'scene.walls.create',
          { sceneId: scene.id, count: created?.length ?? 0 },
          'success'
        );
        return { created: created?.length ?? 0, deleted: 0, lights: 0 };
      }

      case 'delete': {
        const ids = SceneHandlers.requireArray(data?.ids, 'ids');
        const deleted = (await scene.deleteEmbeddedDocuments('Wall', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.walls.delete',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { created: 0, deleted: deleted?.length ?? 0, lights: 0 };
      }

      case 'clear': {
        const ids = Array.from(scene.walls ?? []).map((wall: any) => wall.id);
        const deleted = (await scene.deleteEmbeddedDocuments('Wall', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.walls.clear',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { created: 0, deleted: deleted?.length ?? 0, lights: 0 };
      }

      case 'list': {
        const walls: any[] = Array.from(scene.walls ?? []);
        return walls.map(wall => ({
          id: wall.id,
          c: wall.c,
          move: wall.move,
          sight: wall.sight,
          light: wall.light,
          sound: wall.sound,
          door: wall.door,
          ds: wall.ds,
          dir: wall.dir,
        }));
      }

      case 'box': {
        const payload = SceneHandlers.buildBoxWalls(scene, data?.box);
        const created = (await scene.createEmbeddedDocuments('Wall', payload)) as any[];
        audit(
          this.dataAccess,
          'scene.walls.box',
          { sceneId: scene.id, count: created?.length ?? 0 },
          'success'
        );
        return { created: created?.length ?? 0, deleted: 0, lights: 0 };
      }

      case 'import-uvtt':
        return await this.importUvtt(scene, data?.uvtt);

      default:
        throw unknownAction(action, WALL_ACTIONS);
    }
  }

  private static buildWallData(scene: any, wall: any, what: string): Record<string, any> {
    const from = pointToPixels(scene, wall?.from, `${what}.from`);
    const to = pointToPixels(scene, wall?.to, `${what}.to`);

    const senseNone = constValue('WALL_SENSE_TYPES.NONE', 0);
    const senseNormal = constValue('WALL_SENSE_TYPES.NORMAL', 20);
    const moveNone = constValue('WALL_MOVEMENT_TYPES.NONE', 0);
    const moveNormal = constValue('WALL_MOVEMENT_TYPES.NORMAL', 20);

    const doorWord = String(wall?.door ?? 'none').toLowerCase();
    const door =
      doorWord === 'door'
        ? constValue('WALL_DOOR_TYPES.DOOR', 1)
        : doorWord === 'secret'
          ? constValue('WALL_DOOR_TYPES.SECRET', 2)
          : constValue('WALL_DOOR_TYPES.NONE', 0);

    const stateWord = String(wall?.doorState ?? 'closed').toLowerCase();
    const ds =
      stateWord === 'open'
        ? constValue('WALL_DOOR_STATES.OPEN', 1)
        : stateWord === 'locked'
          ? constValue('WALL_DOOR_STATES.LOCKED', 2)
          : constValue('WALL_DOOR_STATES.CLOSED', 0);

    const dirWord = String(wall?.oneWay ?? 'none').toLowerCase();
    const dir =
      dirWord === 'left'
        ? constValue('WALL_DIRECTIONS.LEFT', 1)
        : dirWord === 'right'
          ? constValue('WALL_DIRECTIONS.RIGHT', 2)
          : constValue('WALL_DIRECTIONS.BOTH', 0);

    return {
      c: [from.x, from.y, to.x, to.y],
      move: wall?.move === false ? moveNone : moveNormal,
      sight: wall?.sight === false ? senseNone : senseNormal,
      light: wall?.light === false ? senseNone : senseNormal,
      sound: wall?.sound === false ? senseNone : senseNormal,
      door,
      ds,
      dir,
    };
  }

  /** Four walls around a rectangle; without `box` the whole scene rectangle is used. */
  private static buildBoxWalls(scene: any, box: any): Array<Record<string, any>> {
    let left: number;
    let top: number;
    let right: number;
    let bottom: number;

    if (box && typeof box.x === 'number' && typeof box.y === 'number') {
      const origin = pointToPixels(scene, { x: box.x, y: box.y, units: box.units }, 'box');
      if (typeof box.width !== 'number' || typeof box.height !== 'number') {
        throw new Error('box: numeric "width" and "height" are required');
      }
      left = origin.x;
      top = origin.y;
      right = origin.x + lengthToPixels(scene, box.width, box.units);
      bottom = origin.y + lengthToPixels(scene, box.height, box.units);
    } else {
      const origin = sceneOrigin(scene);
      const width = scene?.dimensions?.sceneWidth ?? scene?.width ?? 0;
      const height = scene?.dimensions?.sceneHeight ?? scene?.height ?? 0;
      left = origin.x;
      top = origin.y;
      right = origin.x + width;
      bottom = origin.y + height;
    }

    const corners = [
      [left, top, right, top],
      [right, top, right, bottom],
      [right, bottom, left, bottom],
      [left, bottom, left, top],
    ];

    return corners.map(c =>
      SceneHandlers.buildWallData(
        scene,
        {
          from: { x: c[0], y: c[1], units: 'px' },
          to: { x: c[2], y: c[3], units: 'px' },
        },
        'box'
      )
    );
  }

  /**
   * Import a Universal VTT payload (Dungeon Alchemist, dd2vtt). Cell coordinates are
   * converted with the scene's own grid size, which is what the embedded documents
   * are measured in; `resolution.pixels_per_grid` is reported back so a mismatch with
   * the scene grid is visible to the caller.
   */
  private async importUvtt(scene: any, uvtt: any): Promise<any> {
    if (!uvtt || typeof uvtt !== 'object') {
      throw new Error('uvtt must be the parsed contents of a .uvtt/.dd2vtt file');
    }

    const pixelsPerGrid = Number(uvtt?.resolution?.pixels_per_grid) || null;
    const gridSize = gridSizeOf(scene);
    const gridDistance = gridDistanceOf(scene);

    const wallPayload: Array<Record<string, any>> = [];
    const cell = (point: any): { x: number; y: number } =>
      pointToPixels(scene, { x: Number(point?.x), y: Number(point?.y), units: 'grid' }, 'uvtt');

    const polylines: any[] = [
      ...(Array.isArray(uvtt.line_of_sight) ? uvtt.line_of_sight : []),
      // Newer exports split object outlines into their own list
      ...(Array.isArray(uvtt.objects_line_of_sight) ? uvtt.objects_line_of_sight : []),
    ];

    for (const line of polylines) {
      if (!Array.isArray(line) || line.length < 2) continue;
      for (let i = 0; i < line.length - 1; i += 1) {
        const from = cell(line[i]);
        const to = cell(line[i + 1]);
        wallPayload.push(
          SceneHandlers.buildWallData(
            scene,
            {
              from: { x: from.x, y: from.y, units: 'px' },
              to: { x: to.x, y: to.y, units: 'px' },
            },
            'uvtt.line_of_sight'
          )
        );
      }
    }

    const portals: any[] = Array.isArray(uvtt.portals) ? uvtt.portals : [];
    for (const portal of portals) {
      const bounds = portal?.bounds;
      if (!Array.isArray(bounds) || bounds.length < 2) continue;
      const from = cell(bounds[0]);
      const to = cell(bounds[1]);
      wallPayload.push(
        SceneHandlers.buildWallData(
          scene,
          {
            from: { x: from.x, y: from.y, units: 'px' },
            to: { x: to.x, y: to.y, units: 'px' },
            door: 'door',
            doorState: portal?.closed === false ? 'open' : 'closed',
          },
          'uvtt.portals'
        )
      );
    }

    const lightPayload: Array<Record<string, any>> = [];
    const lights: any[] = Array.isArray(uvtt.lights) ? uvtt.lights : [];
    for (const light of lights) {
      const position = cell(light?.position);
      const range = Number(light?.range) || 0;
      const dim = range * gridDistance;
      const parsed = SceneHandlers.parseUvttColor(light?.color);
      const intensity = Number(light?.intensity);

      lightPayload.push(
        SceneHandlers.buildLightData(
          scene,
          {
            x: position.x,
            y: position.y,
            units: 'px',
            dim,
            bright: dim / 2,
            ...(parsed.color ? { color: parsed.color } : {}),
            alpha: parsed.alpha ?? (Number.isFinite(intensity) ? Math.min(intensity, 1) : 0.5),
          },
          'uvtt.lights'
        )
      );
    }

    const createdWalls =
      wallPayload.length > 0
        ? ((await scene.createEmbeddedDocuments('Wall', wallPayload)) as any[])
        : [];
    const createdLights =
      lightPayload.length > 0
        ? ((await scene.createEmbeddedDocuments('AmbientLight', lightPayload)) as any[])
        : [];

    audit(
      this.dataAccess,
      'scene.walls.import-uvtt',
      {
        sceneId: scene.id,
        walls: createdWalls?.length ?? 0,
        lights: createdLights?.length ?? 0,
      },
      'success'
    );

    const result: Record<string, any> = {
      created: createdWalls?.length ?? 0,
      deleted: 0,
      lights: createdLights?.length ?? 0,
      pixelsPerGrid,
      sceneGridSize: gridSize,
    };

    if (pixelsPerGrid && pixelsPerGrid !== gridSize) {
      result.warning =
        `UVTT pixels_per_grid is ${pixelsPerGrid} while the scene grid is ${gridSize}px. ` +
        'Walls were placed on the scene grid - set the scene grid size to match the map if they look off.';
    }

    return result;
  }

  /** UVTT colours are hex without a leading hash, optionally carrying an alpha byte. */
  private static parseUvttColor(raw: unknown): { color: string | null; alpha: number | null } {
    if (typeof raw !== 'string' || raw.trim().length === 0) return { color: null, alpha: null };

    const hex = raw.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return { color: null, alpha: null };

    const color = `#${hex.slice(0, 6)}`;
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : null;
    return { color, alpha };
  }

  // --- 2.5 manage-tiles ------------------------------------------------------

  private async handleTiles(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);

    switch (action) {
      case 'create': {
        const tiles = SceneHandlers.requireArray(data?.tiles, 'tiles');
        const payload: any[] = [];
        for (const [index, tile] of tiles.entries()) {
          payload.push(await SceneHandlers.buildTileData(scene, tile, `tiles[${index}]`));
        }
        const created = (await scene.createEmbeddedDocuments('Tile', payload)) as any[];
        audit(
          this.dataAccess,
          'scene.tiles.create',
          { sceneId: scene.id, count: created?.length ?? 0 },
          'success'
        );
        return { created: created?.length ?? 0, ids: (created ?? []).map(doc => doc.id) };
      }

      case 'update': {
        const tiles = SceneHandlers.requireArray(data?.tiles, 'tiles');
        const updates: any[] = [];
        for (const [index, tile] of tiles.entries()) {
          if (typeof tile?.id !== 'string' || tile.id.length === 0) {
            throw new Error(`tiles[${index}]: "id" is required to update a tile`);
          }
          const built = await SceneHandlers.buildTileData(scene, tile, `tiles[${index}]`, true);
          updates.push({ _id: tile.id, ...built });
        }
        const updated = (await scene.updateEmbeddedDocuments('Tile', updates)) as any[];
        audit(
          this.dataAccess,
          'scene.tiles.update',
          { sceneId: scene.id, count: updated?.length ?? 0 },
          'success'
        );
        return { updated: updated?.length ?? 0 };
      }

      case 'delete': {
        const ids = SceneHandlers.requireArray(data?.ids, 'ids');
        const deleted = (await scene.deleteEmbeddedDocuments('Tile', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.tiles.delete',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { deleted: deleted?.length ?? 0 };
      }

      case 'list': {
        const tiles: any[] = Array.from(scene.tiles ?? []);
        return tiles.map(tile => ({
          id: tile.id,
          image: tile.texture?.src ?? null,
          x: tile.x,
          y: tile.y,
          width: tile.width,
          height: tile.height,
          elevation: tile.elevation,
          sort: tile.sort,
          rotation: tile.rotation,
          alpha: tile.alpha,
          hidden: tile.hidden === true,
          locked: tile.locked === true,
        }));
      }

      default:
        throw unknownAction(action, TILE_ACTIONS);
    }
  }

  private static async buildTileData(
    scene: any,
    tile: any,
    what: string,
    sparse = false
  ): Promise<Record<string, any>> {
    const data: Record<string, any> = {};

    if (typeof tile?.image === 'string' && tile.image.length > 0) {
      data.texture = { src: tile.image };
    } else if (!sparse) {
      throw new Error(`${what}: "image" is required`);
    }

    const hasPosition = typeof tile?.x === 'number' && typeof tile?.y === 'number';
    if (hasPosition || !sparse) {
      const point = pointToPixels(scene, { x: tile?.x, y: tile?.y, units: tile?.units }, what);
      data.x = point.x;
      data.y = point.y;
    }

    let width = typeof tile?.width === 'number' ? tile.width : null;
    let height = typeof tile?.height === 'number' ? tile.height : null;
    if ((width === null || height === null) && !sparse && typeof tile?.image === 'string') {
      const measured = await imageDimensions(tile.image);
      width = width ?? measured.width;
      height = height ?? measured.height;
    }
    if (width !== null) data.width = width;
    if (height !== null) data.height = height;

    if (typeof tile?.rotation === 'number') data.rotation = tile.rotation;
    if (typeof tile?.alpha === 'number') data.alpha = tile.alpha;
    if (typeof tile?.sort === 'number') data.sort = tile.sort;
    if (typeof tile?.hidden === 'boolean') data.hidden = tile.hidden;
    if (typeof tile?.elevation === 'number') data.elevation = tile.elevation;

    // "Overhead" is elevation above the tokens plus fade occlusion, the v12+ replacement
    // for the old overhead flag.
    if (tile?.overhead === true) {
      data.elevation = typeof tile?.elevation === 'number' ? tile.elevation : 20;
      data.occlusion = { mode: constValue('OCCLUSION_MODES.FADE', 3), alpha: 0.5 };
      data.restrictions = { light: true, weather: false };
    }

    return data;
  }

  // --- 2.6 manage-scene-notes ------------------------------------------------

  private async handleNotes(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const scene = resolveScene(data?.scene);

    switch (action) {
      case 'create': {
        const notes = SceneHandlers.requireArray(data?.notes, 'notes');
        const payload: any[] = [];

        for (const [index, note] of notes.entries()) {
          const what = `notes[${index}]`;
          const journal = await resolveJournal(note?.journal);
          const point = pointToPixels(scene, { x: note?.x, y: note?.y, units: note?.units }, what);

          const entry: Record<string, any> = {
            entryId: journal.id,
            x: point.x,
            y: point.y,
            texture: { src: note?.icon ?? 'icons/svg/book.svg' },
            iconSize: typeof note?.iconSize === 'number' ? note.iconSize : 40,
            global: note?.global === true,
          };

          if (typeof note?.page === 'string' && note.page.length > 0) {
            entry.pageId = resolveJournalPage(journal, note.page).id;
          }
          if (typeof note?.label === 'string' && note.label.length > 0) {
            entry.text = note.label;
          }

          payload.push(entry);
        }

        const created = (await scene.createEmbeddedDocuments('Note', payload)) as any[];
        audit(
          this.dataAccess,
          'scene.notes.create',
          { sceneId: scene.id, count: created?.length ?? 0 },
          'success'
        );
        return { created: created?.length ?? 0, ids: (created ?? []).map(doc => doc.id) };
      }

      case 'delete': {
        const ids = SceneHandlers.requireArray(data?.ids, 'ids');
        const deleted = (await scene.deleteEmbeddedDocuments('Note', ids)) as any[];
        audit(
          this.dataAccess,
          'scene.notes.delete',
          { sceneId: scene.id, count: deleted?.length ?? 0 },
          'success'
        );
        return { deleted: deleted?.length ?? 0 };
      }

      case 'list': {
        const notes: any[] = Array.from(scene.notes ?? []);
        return notes.map(note => ({
          id: note.id,
          entryId: note.entryId,
          pageId: note.pageId ?? null,
          journal: note.entry?.name ?? null,
          label: note.text ?? null,
          x: note.x,
          y: note.y,
          icon: note.texture?.src ?? null,
          iconSize: note.iconSize,
          global: note.global === true,
        }));
      }

      default:
        throw unknownAction(action, NOTE_ACTIONS);
    }
  }

  // --- shared ----------------------------------------------------------------

  private static requireArray(value: any, name: string): any[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${name} array is required and must contain at least one entry`);
    }
    return value;
  }

  /** Drop undefined keys so a preset is not overwritten by an absent field. */
  private static definedOnly(source: any): Record<string, any> {
    const result: Record<string, any> = {};
    if (!source || typeof source !== 'object') return result;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
}
