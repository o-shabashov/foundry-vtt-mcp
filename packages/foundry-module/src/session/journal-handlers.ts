import { MODULE_ID } from '../constants.js';
import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  buildOwnership,
  checkAccess,
  describeError,
  getOrCreateFolder,
  registerNamespaceQueries,
  resolveInCollection,
  resolveJournal,
  resolveJournalPage,
  resolveUserIds,
  unknownAction,
} from './common.js';

/**
 * Journal handlers: multi-page journal entries with images and per-page ownership,
 * pushing a page or an image onto every player's screen, and ownership management
 * for any world document type.
 */

const JOURNAL_ACTIONS = [
  'create',
  'update',
  'delete',
  'add-pages',
  'update-page',
  'delete-pages',
  'list',
  'get',
] as const;

const OWNERSHIP_ACTIONS = ['set', 'get'] as const;

/** Page types the core ships with. System page types are rejected on purpose. */
const PAGE_TYPES = ['text', 'image', 'pdf', 'video'] as const;

/** Foundry's sort spacing, so pages keep the order they were written in. */
const SORT_DENSITY = 100000;

/** World collections addressed by document type name. */
const OWNERSHIP_COLLECTIONS: Record<string, string> = {
  Actor: 'actors',
  JournalEntry: 'journal',
  Scene: 'scenes',
  Playlist: 'playlists',
  Item: 'items',
  Macro: 'macros',
  RollTable: 'tables',
};

export class JournalHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    const prefix = MODULE_ID;

    registerNamespaceQueries('journal', JOURNAL_ACTIONS, this.handleJournal.bind(this));

    CONFIG.queries[`${prefix}.journal.show`] = this.handleShow.bind(this);
    CONFIG.queries[`${prefix}.journal.showImage`] = this.handleShowImage.bind(this);
    CONFIG.queries[`${prefix}.journal.showToPlayers`] = this.handleShow.bind(this);

    registerNamespaceQueries('ownership', OWNERSHIP_ACTIONS, this.handleOwnership.bind(this));
  }

  // --- 4.1 manage-journal ----------------------------------------------------

  private async handleJournal(data: any): Promise<any> {
    const action = data?.action;
    const isWrite = action !== 'list' && action !== 'get';

    const denied = checkAccess(isWrite);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    switch (action) {
      case 'create':
        return await this.createJournal(data);
      case 'update':
        return await this.updateJournal(data);
      case 'delete':
        return await this.deleteJournal(data);
      case 'add-pages':
        return await this.addPages(data);
      case 'update-page':
        return await this.updatePage(data);
      case 'delete-pages':
        return await this.deletePages(data);
      case 'list':
        return this.listJournals();
      case 'get':
        return await this.getJournal(data);
      default:
        throw unknownAction(action, JOURNAL_ACTIONS);
    }
  }

  private async createJournal(data: any): Promise<any> {
    const name = data?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('name is required to create a journal entry');
    }

    const journalData: Record<string, any> = { name: name.trim() };

    const folderId = await getOrCreateFolder(data?.folder, 'JournalEntry');
    if (folderId) journalData.folder = folderId;

    if (data?.ownership) journalData.ownership = buildOwnership({}, data.ownership);

    if (Array.isArray(data?.pages) && data.pages.length > 0) {
      journalData.pages = data.pages.map((page: any, index: number) =>
        JournalHandlers.buildPage(page, `pages[${index}]`, index)
      );
    }

    const cls =
      (globalThis as any).JournalEntry?.implementation ?? (globalThis as any).JournalEntry;
    const journal = await cls.create(journalData);
    if (!journal) throw new Error(`Foundry returned no document when creating journal "${name}"`);

    audit(
      this.dataAccess,
      'journal.create',
      { id: journal.id, name: journal.name, pages: journal.pages?.size ?? 0 },
      'success'
    );

    return JournalHandlers.journalSummary(journal);
  }

  private async updateJournal(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const update: Record<string, any> = {};

    if (typeof data?.name === 'string') update.name = data.name;
    if (typeof data?.folder === 'string') {
      update.folder = await getOrCreateFolder(data.folder, 'JournalEntry');
    }
    if (data?.ownership) update.ownership = buildOwnership(journal.ownership, data.ownership);

    if (Object.keys(update).length === 0) {
      throw new Error('update needs at least one of name, folder or ownership');
    }

    await journal.update(update);

    audit(
      this.dataAccess,
      'journal.update',
      { id: journal.id, keys: Object.keys(update) },
      'success'
    );

    return JournalHandlers.journalSummary(journal);
  }

  private async deleteJournal(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const ref = { id: journal.id, name: journal.name, uuid: journal.uuid };
    await journal.delete();

    audit(this.dataAccess, 'journal.delete', ref, 'success');

    return { deleted: true, ...ref };
  }

  private async addPages(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const pages = data?.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('pages array is required and must contain at least one entry');
    }

    const offset = journal.pages?.size ?? 0;
    const payload = pages.map((page: any, index: number) =>
      JournalHandlers.buildPage(page, `pages[${index}]`, offset + index)
    );

    const created = (await journal.createEmbeddedDocuments('JournalEntryPage', payload)) as any[];

    audit(
      this.dataAccess,
      'journal.add-pages',
      { id: journal.id, count: created?.length ?? 0 },
      'success'
    );

    return {
      journalId: journal.id,
      journalName: journal.name,
      pages: (created ?? []).map(page => ({
        id: page.id,
        name: page.name,
        type: page.type,
        uuid: page.uuid,
      })),
    };
  }

  private async updatePage(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const page = resolveJournalPage(journal, data?.page);

    // Fields may arrive at the top level or as a single-entry `pages` array
    const source =
      Array.isArray(data?.pages) && data.pages.length > 0 ? data.pages[0] : (data ?? {});
    const built = JournalHandlers.buildPage(
      { type: page.type, ...source },
      'page',
      undefined,
      true
    );

    if (Object.keys(built).length === 0) {
      throw new Error('update-page needs at least one page field to change');
    }

    await journal.updateEmbeddedDocuments('JournalEntryPage', [{ _id: page.id, ...built }]);

    audit(
      this.dataAccess,
      'journal.update-page',
      { id: journal.id, pageId: page.id, keys: Object.keys(built) },
      'success'
    );

    return { journalId: journal.id, pageId: page.id, updated: Object.keys(built) };
  }

  private async deletePages(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const identifiers = data?.pageIds;
    if (!Array.isArray(identifiers) || identifiers.length === 0) {
      throw new Error('pageIds array is required and must contain at least one entry');
    }

    const ids = identifiers.map((identifier: string) => resolveJournalPage(journal, identifier).id);
    const deleted = (await journal.deleteEmbeddedDocuments('JournalEntryPage', ids)) as any[];

    audit(
      this.dataAccess,
      'journal.delete-pages',
      { id: journal.id, count: deleted?.length ?? 0 },
      'success'
    );

    return { journalId: journal.id, deleted: deleted?.length ?? 0 };
  }

  private listJournals(): any[] {
    const journals: any[] = Array.from((game as any).journal ?? []);
    return journals.map(journal => JournalHandlers.journalSummary(journal));
  }

  private async getJournal(data: any): Promise<any> {
    const journal = await resolveJournal(data?.journal);
    const pages: any[] = journal.pages?.contents ?? Array.from(journal.pages ?? []);

    return {
      ...JournalHandlers.journalSummary(journal),
      ownership: journal.ownership ?? {},
      pages: pages.map(page => ({
        id: page.id,
        name: page.name,
        type: page.type,
        src: page.src ?? null,
        caption: page.image?.caption ?? null,
        textLength: typeof page.text?.content === 'string' ? page.text.content.length : 0,
        sort: page.sort,
        ownership: page.ownership ?? {},
        uuid: page.uuid,
      })),
    };
  }

  private static journalSummary(journal: any): Record<string, any> {
    return {
      id: journal.id,
      name: journal.name,
      uuid: journal.uuid,
      folder: journal.folder?.name ?? null,
      pageCount: journal.pages?.size ?? 0,
    };
  }

  /**
   * Build JournalEntryPage data. Text pages carry HTML (`format: 1`); image, pdf and
   * video pages carry a `src` path. With `sparse` only the passed fields are emitted.
   */
  private static buildPage(
    page: any,
    what: string,
    sortIndex?: number,
    sparse = false
  ): Record<string, any> {
    const type = page?.type ?? 'text';
    if (!(PAGE_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `${what}: unknown page type "${String(type)}". Valid: ${PAGE_TYPES.join(', ')}`
      );
    }

    const data: Record<string, any> = {};

    if (typeof page?.name === 'string' && page.name.length > 0) {
      data.name = page.name;
    } else if (!sparse) {
      throw new Error(`${what}: "name" is required`);
    }

    if (!sparse) data.type = type;

    if (type === 'text') {
      if (typeof page?.content === 'string') {
        // format 1 is HTML; markdown is the caller's job to convert
        data.text = { content: page.content, format: 1 };
      } else if (!sparse) {
        data.text = { content: '', format: 1 };
      }
    } else {
      if (typeof page?.src === 'string' && page.src.length > 0) {
        data.src = page.src;
      } else if (!sparse) {
        throw new Error(`${what}: "src" is required for a ${type} page`);
      }
      if (typeof page?.caption === 'string') {
        data.image = { caption: page.caption };
      }
    }

    const showTitle = page?.showTitle;
    const titleLevel = page?.titleLevel;
    if (showTitle !== undefined || titleLevel !== undefined || !sparse) {
      data.title = {
        show: showTitle !== false,
        level: typeof titleLevel === 'number' ? titleLevel : 1,
      };
    }

    if (page?.ownership) data.ownership = buildOwnership({}, page.ownership);
    if (typeof sortIndex === 'number') data.sort = (sortIndex + 1) * SORT_DENSITY;

    return data;
  }

  // --- 4.2 show-to-players ---------------------------------------------------

  private async handleShowImage(data: any): Promise<any> {
    return await this.handleShow({ ...(data ?? {}), what: 'image' });
  }

  private async handleShow(data: any): Promise<any> {
    const denied = checkAccess(true);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const what = data?.what ?? (typeof data?.image === 'string' ? 'image' : 'journal');
    const force = data?.force !== false;
    const users = resolveUserIds(data?.users);

    switch (what) {
      case 'journal': {
        const journal = await resolveJournal(data?.journal);
        await JournalHandlers.showDocument(journal, force);
        audit(this.dataAccess, 'journal.show', { id: journal.id, what }, 'success');
        return { shown: 'journal', id: journal.id, name: journal.name, force };
      }

      case 'page': {
        const journal = await resolveJournal(data?.journal);
        const page = resolveJournalPage(journal, data?.page);

        let pageTargeted = true;
        try {
          await JournalHandlers.showDocument(page, force);
        } catch {
          // Some cores only know how to show whole entries
          await JournalHandlers.showDocument(journal, force);
          pageTargeted = false;
        }

        audit(this.dataAccess, 'journal.show', { id: journal.id, pageId: page.id }, 'success');
        return {
          shown: 'page',
          id: journal.id,
          pageId: page.id,
          name: page.name,
          pageTargeted,
          force,
        };
      }

      case 'image': {
        const src = data?.image;
        if (typeof src !== 'string' || src.trim().length === 0) {
          throw new Error('image (a path in the Data directory) is required to show an image');
        }
        const title = typeof data?.title === 'string' ? data.title : src.split('/').pop();
        const shownTo = await JournalHandlers.shareImage(src, title, users);

        audit(this.dataAccess, 'journal.showImage', { src, users: shownTo.length }, 'success');

        return { shown: 'image', image: src, title, users: shownTo };
      }

      default:
        throw new Error(`Unknown "what" value "${String(what)}". Valid: journal, page, image`);
    }
  }

  /** Push a JournalEntry (or one of its pages) onto every player's screen. */
  private static async showDocument(doc: any, force: boolean): Promise<void> {
    const JournalCls =
      (globalThis as any).foundry?.documents?.collections?.Journal ?? (globalThis as any).Journal;

    if (typeof JournalCls?.show === 'function') {
      await JournalCls.show(doc, { force });
      return;
    }
    if (typeof doc?.show === 'function') {
      await doc.show(force);
      return;
    }

    throw new Error('This Foundry build exposes no way to show a journal entry to players');
  }

  /**
   * Share a standalone image. `ImagePopout#shareImage` emits the socket itself, so the
   * popout is never rendered on the bridge client. The option bag is only passed when
   * the method actually declares a parameter, because older cores take none.
   */
  private static async shareImage(
    src: string,
    title: string | undefined,
    users: string[]
  ): Promise<string[]> {
    const PopoutCls =
      (globalThis as any).foundry?.applications?.apps?.ImagePopout ??
      (globalThis as any).ImagePopout;

    if (typeof PopoutCls !== 'function') {
      throw new Error('foundry.applications.apps.ImagePopout is unavailable in this Foundry build');
    }

    let popout: any;
    try {
      popout = new PopoutCls({ src, window: { title } });
    } catch (error) {
      // Pre-v13 signature: new ImagePopout(src, options)
      try {
        popout = new PopoutCls(src, { title });
      } catch {
        throw new Error(`Could not construct an ImagePopout for "${src}": ${describeError(error)}`);
      }
    }

    const share = popout?.shareImage;
    if (typeof share !== 'function') {
      throw new Error(
        'ImagePopout#shareImage is unavailable in this Foundry build - cannot show the image to players'
      );
    }

    if (share.length >= 1) {
      await popout.shareImage({ image: src, title, users });
      return users;
    }

    // No options accepted: the image goes to everyone
    await popout.shareImage();
    return users;
  }

  // --- 4.3 manage-ownership --------------------------------------------------

  private async handleOwnership(data: any): Promise<any> {
    const action = data?.action ?? 'set';
    const denied = checkAccess(action === 'set');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    if (action !== 'set' && action !== 'get') {
      throw unknownAction(action, OWNERSHIP_ACTIONS);
    }

    const doc = await this.resolveOwnershipTarget(data);

    if (action === 'get') {
      return {
        uuid: doc.uuid,
        name: doc.name,
        documentType: doc.documentName,
        ownership: doc.ownership ?? {},
      };
    }

    if (data?.default === undefined && data?.users === undefined && data?.players === undefined) {
      throw new Error('ownership.set needs at least one of default, players or users');
    }

    const ownership = buildOwnership(doc.ownership, {
      default: data?.default,
      players: data?.players,
      users: data?.users,
    });

    await doc.update({ ownership });

    audit(
      this.dataAccess,
      'ownership.set',
      { uuid: doc.uuid, documentType: doc.documentName },
      'success'
    );

    return {
      uuid: doc.uuid,
      name: doc.name,
      documentType: doc.documentName,
      ownership: doc.ownership ?? ownership,
    };
  }

  /** Resolve the document ownership is being read from or written to. */
  private async resolveOwnershipTarget(data: any): Promise<any> {
    const documentType = data?.documentType ?? 'Actor';

    if (documentType === 'JournalEntryPage') {
      const journal = await resolveJournal(data?.journal ?? data?.identifier);
      const pageId = data?.page ?? data?.identifier;
      return resolveJournalPage(journal, pageId);
    }

    const identifier = data?.identifier;
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      throw new Error('identifier (name, id or uuid) is required');
    }

    if (identifier.includes('.')) {
      try {
        const doc = await (globalThis as any).fromUuid(identifier);
        if (doc) return doc;
      } catch {
        // not a uuid - fall through to the collection lookup
      }
    }

    const collectionName = OWNERSHIP_COLLECTIONS[documentType];
    if (!collectionName) {
      throw new Error(
        `Unknown documentType "${String(documentType)}". Valid: ${Object.keys(OWNERSHIP_COLLECTIONS).join(', ')}, JournalEntryPage`
      );
    }

    return resolveInCollection((game as any)[collectionName], identifier, documentType);
  }
}
