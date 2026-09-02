import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  checkAccess,
  constValue,
  describeError,
  getOrCreateFolder,
  pointToPixels,
  registerNamespaceQueries,
  resolveInCollection,
  resolvePack,
  resolveScene,
  unknownAction,
} from './common.js';

/**
 * Roll tables and loot piles.
 *
 * Loot piles lean on the item-piles module. Its API is not part of the core, so
 * every call is guarded and a missing module is reported as such instead of
 * failing with an undefined-property error.
 */

const TABLE_ACTIONS = ['create', 'roll', 'list', 'delete', 'get'] as const;
const PILE_ACTIONS = ['create', 'add-items', 'open', 'close', 'lock', 'unlock', 'list'] as const;

/** Default pile name and artwork. */
const DEFAULT_PILE_NAME = 'Loot';
const DEFAULT_PILE_IMAGE = 'icons/svg/chest.svg';

export class LootHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    registerNamespaceQueries('table', TABLE_ACTIONS, this.handleTable.bind(this));
    registerNamespaceQueries('piles', PILE_ACTIONS, this.handlePiles.bind(this));
  }

  // --- 6.1 manage-rolltable --------------------------------------------------

  private async handleTable(data: any): Promise<any> {
    const action = data?.action;
    const isWrite = action !== 'list' && action !== 'get';

    const denied = checkAccess(isWrite);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    switch (action) {
      case 'create':
        return await this.createTable(data);
      case 'roll':
        return await this.rollTable(data);
      case 'list':
        return this.listTables();
      case 'delete':
        return await this.deleteTable(data);
      case 'get':
        return this.getTable(data);
      default:
        throw unknownAction(action, TABLE_ACTIONS);
    }
  }

  private async createTable(data: any): Promise<any> {
    const name = data?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('name is required to create a roll table');
    }

    const entries = Array.isArray(data?.results) ? data.results : [];
    if (entries.length === 0) {
      throw new Error('results array is required and must contain at least one entry');
    }

    const textType = constValue('TABLE_RESULT_TYPES.TEXT', 'text');
    const documentType = constValue('TABLE_RESULT_TYPES.DOCUMENT', 'document');

    const results: Array<Record<string, any>> = [];
    let cursor = 1;

    for (const [index, entry] of entries.entries()) {
      const weight = typeof entry?.weight === 'number' && entry.weight > 0 ? entry.weight : 1;
      const range =
        Array.isArray(entry?.range) && entry.range.length === 2
          ? [Number(entry.range[0]), Number(entry.range[1])]
          : [cursor, cursor + weight - 1];
      cursor = Math.max(cursor, range[1] + 1);

      const result: Record<string, any> = { weight, range };

      if (typeof entry?.document === 'string' && entry.document.trim().length > 0) {
        const doc = await this.resolveTableDocument(entry.document, `results[${index}]`);
        result.type = documentType;
        result.documentUuid = doc.uuid;
        result.text = typeof entry?.text === 'string' ? entry.text : doc.name;
        if (doc.img) result.img = doc.img;
      } else {
        if (typeof entry?.text !== 'string' || entry.text.length === 0) {
          throw new Error(`results[${index}]: either "text" or "document" is required`);
        }
        result.type = textType;
        result.text = entry.text;
      }

      results.push(result);
    }

    const maxRange = results.reduce((max, result) => Math.max(max, result.range[1]), 1);
    const tableData: Record<string, any> = {
      name: name.trim(),
      formula: typeof data?.formula === 'string' ? data.formula : `1d${maxRange}`,
      replacement: data?.replacement !== false,
      results,
    };

    const folderId = await getOrCreateFolder(data?.folder, 'RollTable');
    if (folderId) tableData.folder = folderId;

    const cls = (globalThis as any).RollTable?.implementation ?? (globalThis as any).RollTable;
    const table = await cls.create(tableData);
    if (!table) throw new Error(`Foundry returned no document when creating table "${name}"`);

    audit(
      this.dataAccess,
      'table.create',
      { id: table.id, name: table.name, results: results.length },
      'success'
    );

    return {
      id: table.id,
      name: table.name,
      uuid: table.uuid,
      formula: table.formula,
      results: results.length,
    };
  }

  private async rollTable(data: any): Promise<any> {
    const table = this.resolveTable(data);
    const rolls = Math.max(1, Math.floor(Number(data?.rolls ?? 1)));
    const displayChat = data?.toChat !== false;

    const draws: Array<Record<string, any>> = [];

    for (let i = 0; i < rolls; i += 1) {
      const drawn: any = await table.draw({ displayChat });
      const total = drawn?.roll?.total ?? null;
      const results: any[] = Array.isArray(drawn?.results) ? drawn.results : [];

      for (const result of results) {
        draws.push({
          text: result.text ?? result.name ?? null,
          documentUuid: result.documentUuid ?? result.uuid ?? null,
          roll: total,
        });
      }
    }

    audit(this.dataAccess, 'table.roll', { id: table.id, rolls, results: draws.length }, 'success');

    return { id: table.id, name: table.name, results: draws };
  }

  private listTables(): any[] {
    const tables: any[] = Array.from((game as any).tables ?? []);
    return tables.map(table => ({
      id: table.id,
      name: table.name,
      uuid: table.uuid,
      formula: table.formula,
      replacement: table.replacement === true,
      results: table.results?.size ?? 0,
      folder: table.folder?.name ?? null,
    }));
  }

  private getTable(data: any): any {
    const table = this.resolveTable(data);
    const results: any[] = Array.from(table.results ?? []);

    return {
      id: table.id,
      name: table.name,
      uuid: table.uuid,
      formula: table.formula,
      replacement: table.replacement === true,
      folder: table.folder?.name ?? null,
      results: results.map(result => ({
        id: result.id,
        type: result.type,
        text: result.text ?? result.name ?? null,
        documentUuid: result.documentUuid ?? null,
        weight: result.weight,
        range: result.range,
        drawn: result.drawn === true,
      })),
    };
  }

  private async deleteTable(data: any): Promise<any> {
    const table = this.resolveTable(data);
    const ref = { id: table.id, name: table.name };
    await table.delete();

    audit(this.dataAccess, 'table.delete', ref, 'success');

    return { deleted: true, ...ref };
  }

  private resolveTable(data: any): any {
    return resolveInCollection((game as any).tables, data?.table, 'RollTable');
  }

  /** Resolve a table result document by UUID, then by world name. */
  private async resolveTableDocument(identifier: string, what: string): Promise<any> {
    if (identifier.includes('.')) {
      try {
        const doc = await (globalThis as any).fromUuid(identifier);
        if (doc) return doc;
      } catch {
        // not a uuid - fall through
      }
    }

    try {
      return resolveInCollection((game as any).items, identifier, 'Item');
    } catch (error) {
      throw new Error(
        `${what}: could not resolve document "${identifier}" - ${describeError(error)}`
      );
    }
  }

  // --- 6.2 manage-loot-pile --------------------------------------------------

  private async handlePiles(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    switch (action) {
      case 'create':
        return await this.createPile(data);
      case 'add-items':
        return await this.addPileItems(data);
      case 'open':
      case 'close':
      case 'lock':
      case 'unlock':
        return await this.pileState(action, data);
      case 'list':
        return this.listPiles(data);
      default:
        throw unknownAction(action, PILE_ACTIONS);
    }
  }

  /** The item-piles API, or a clear error naming the missing module. */
  private static api(): any {
    const api = (game as any).itempiles?.API;
    if (!api) {
      throw new Error(
        'item-piles module is not active - install and enable "Item Piles" to manage loot piles'
      );
    }
    return api;
  }

  private async createPile(data: any): Promise<any> {
    const api = LootHandlers.api();
    if (typeof api.createItemPile !== 'function') {
      throw new Error('item-piles is active but exposes no createItemPile API');
    }

    const scene = resolveScene(data?.scene);
    const position = pointToPixels(
      scene,
      { x: data?.x, y: data?.y, units: data?.units },
      'loot pile position'
    );

    const name =
      typeof data?.name === 'string' && data.name.length > 0 ? data.name : DEFAULT_PILE_NAME;
    const image =
      typeof data?.image === 'string' && data.image.length > 0 ? data.image : DEFAULT_PILE_IMAGE;
    const isContainer = (data?.type ?? 'container') === 'container';

    const items = await this.buildItemData(data?.items);

    const options: Record<string, any> = {
      sceneId: scene.id,
      position,
      createActor: true,
      tokenOverrides: { name, texture: { src: image } },
      actorOverrides: { name, img: image },
      itemPileFlags: { enabled: true, isContainer },
    };
    if (items.length > 0) options.items = items.map(entry => entry.data);

    let created: any;
    try {
      created = await api.createItemPile(options);
    } catch (error) {
      const message = describeError(error);
      audit(this.dataAccess, 'piles.create', { sceneId: scene.id, name }, 'failure', message);
      throw new Error(`item-piles rejected createItemPile: ${message}`);
    }

    audit(
      this.dataAccess,
      'piles.create',
      { sceneId: scene.id, name, items: items.length },
      'success'
    );

    return {
      sceneId: scene.id,
      name,
      isContainer,
      items: items.length,
      tokenUuid: created?.tokenUuid ?? created?.tokenId ?? null,
      actorUuid: created?.actorUuid ?? created?.actorId ?? null,
      raw: created ?? null,
    };
  }

  private async addPileItems(data: any): Promise<any> {
    const api = LootHandlers.api();
    if (typeof api.addItems !== 'function') {
      throw new Error('item-piles is active but exposes no addItems API');
    }

    const target = this.resolvePileToken(data);
    const items = await this.buildItemData(data?.items);
    if (items.length === 0) {
      throw new Error('items array is required and must contain at least one entry');
    }

    // item-piles expects [{ item: <item data>, quantity: <number> }]
    const payload = items.map(entry => ({ item: entry.data, quantity: entry.quantity }));

    let result: any;
    try {
      result = await api.addItems(target.uuid ?? target, payload);
    } catch (error) {
      throw new Error(`item-piles rejected addItems: ${describeError(error)}`);
    }

    audit(
      this.dataAccess,
      'piles.add-items',
      { pile: target.name ?? target.id, count: payload.length },
      'success'
    );

    return { pile: target.name ?? null, added: payload.length, raw: result ?? null };
  }

  private async pileState(action: string, data: any): Promise<any> {
    const api = LootHandlers.api();
    const method = `${action}ItemPile`;
    if (typeof api[method] !== 'function') {
      throw new Error(`item-piles is active but exposes no ${method} API`);
    }

    const target = this.resolvePileToken(data);

    let result: any;
    try {
      result = await api[method](target.uuid ?? target);
    } catch (error) {
      throw new Error(`item-piles rejected ${method}: ${describeError(error)}`);
    }

    audit(this.dataAccess, `piles.${action}`, { pile: target.name ?? target.id }, 'success');

    return { pile: target.name ?? null, action, raw: result ?? null };
  }

  private listPiles(data: any): any[] {
    const scene = resolveScene(data?.scene);
    const api = (game as any).itempiles?.API;
    const tokens: any[] = Array.from(scene.tokens ?? []);

    return tokens
      .filter(token => {
        if (typeof api?.isValidItemPile === 'function') {
          try {
            return api.isValidItemPile(token) === true;
          } catch {
            // fall through to the flag check
          }
        }
        const flags = token.flags?.['item-piles'] ?? token.actor?.flags?.['item-piles'];
        return flags?.data?.enabled === true || flags?.enabled === true;
      })
      .map(token => ({
        tokenId: token.id,
        name: token.name,
        uuid: token.uuid,
        actorId: token.actorId ?? token.actor?.id ?? null,
        x: token.x,
        y: token.y,
      }));
  }

  /** Find the pile token on a scene by id or name. */
  private resolvePileToken(data: any): any {
    const scene = resolveScene(data?.scene);
    const identifier = data?.pile;
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      throw new Error('pile (token name or id) is required');
    }

    const tokens: any[] = Array.from(scene.tokens ?? []);
    const byId = tokens.find(token => token.id === identifier);
    if (byId) return byId;

    const exact = tokens.filter(token => token.name === identifier);
    if (exact.length === 1) return exact[0];

    const needle = identifier.toLowerCase();
    const partial = tokens.filter(
      token => typeof token.name === 'string' && token.name.toLowerCase().includes(needle)
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const candidates = partial.map(token => `${token.name} (${token.id})`).join(', ');
      throw new Error(`Ambiguous pile "${identifier}" - candidates: ${candidates}`);
    }

    throw new Error(`Pile token "${identifier}" not found on scene "${scene.name}"`);
  }

  /**
   * Turn item references into item source data paired with the quantity asked for.
   * The quantity is written into `system.quantity` as well, which is where dnd5e and
   * the systems item-piles supports keep it.
   */
  private async buildItemData(entries: any): Promise<Array<{ data: any; quantity: number }>> {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const built: Array<{ data: any; quantity: number }> = [];

    for (const [index, entry] of entries.entries()) {
      const identifier = entry?.item;
      if (typeof identifier !== 'string' || identifier.trim().length === 0) {
        throw new Error(`items[${index}]: "item" (uuid or name) is required`);
      }

      const quantity = typeof entry?.quantity === 'number' ? entry.quantity : 1;
      const doc = await this.resolveItemDocument(identifier, entry?.pack, `items[${index}]`);
      const source = doc.toObject();
      delete source._id;

      if (!source.system || typeof source.system !== 'object') source.system = {};
      source.system.quantity = quantity;

      built.push({ data: source, quantity });
    }

    return built;
  }

  private async resolveItemDocument(
    identifier: string,
    packId: string | undefined,
    what: string
  ): Promise<any> {
    if (typeof packId === 'string' && packId.trim().length > 0) {
      const pack = resolvePack(packId);
      const index: any[] = Array.from(await pack.getIndex());
      const entry =
        index.find(e => e._id === identifier) ??
        index.find(e => e.name === identifier) ??
        index.find(e => e.name?.toLowerCase() === identifier.toLowerCase());

      if (!entry) {
        throw new Error(`${what}: "${identifier}" not found in compendium ${pack.collection}`);
      }
      return await pack.getDocument(entry._id);
    }

    if (identifier.includes('.')) {
      try {
        const doc = await (globalThis as any).fromUuid(identifier);
        if (doc) return doc;
      } catch {
        // not a uuid - fall through to the world lookup
      }
    }

    try {
      return resolveInCollection((game as any).items, identifier, 'Item');
    } catch (error) {
      throw new Error(`${what}: ${describeError(error)}`);
    }
  }
}
