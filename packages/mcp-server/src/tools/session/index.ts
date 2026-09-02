/**
 * Session tools.
 *
 * Everything needed to prepare and run a session over the bridge: upload maps and
 * music, build scenes with grid, light, walls and tokens, hand out journal pages
 * with the right permissions, drive playlists, combat, chat, roll tables and loot
 * piles.
 *
 * SessionTools owns one instance of each group and dispatches by tool name, so
 * backend.ts constructs a single object and delegates unknown tool names here.
 */

import { SessionToolsOptions } from './common.js';
import { SessionFileTools } from './files.js';
import { SessionSceneTools } from './scene.js';
import { SessionPlaylistTools } from './playlist.js';
import { SessionJournalTools } from './journal.js';
import { SessionOwnershipTools } from './ownership.js';
import { SessionCombatTools } from './combat.js';
import { SessionChatTools } from './chat.js';
import { SessionLootTools } from './loot.js';

export { SessionFileTools } from './files.js';
export { SessionSceneTools } from './scene.js';
export { SessionPlaylistTools } from './playlist.js';
export { SessionJournalTools } from './journal.js';
export { SessionOwnershipTools } from './ownership.js';
export { SessionCombatTools } from './combat.js';
export { SessionChatTools } from './chat.js';
export { SessionLootTools } from './loot.js';
export type { SessionToolsOptions } from './common.js';

/** Every tool name this class answers to, in the order the definitions come out. */
export const SESSION_TOOL_NAMES = [
  'upload-file',
  'manage-files',
  'manage-scene',
  'place-tokens',
  'manage-scene-lights',
  'manage-walls',
  'manage-tiles',
  'manage-scene-notes',
  'manage-playlists',
  'manage-journal',
  'show-to-players',
  'manage-ownership',
  'manage-combat',
  'send-chat',
  'manage-rolltable',
  'manage-loot-pile',
] as const;

export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

export class SessionTools {
  readonly files: SessionFileTools;
  readonly scene: SessionSceneTools;
  readonly playlists: SessionPlaylistTools;
  readonly journal: SessionJournalTools;
  readonly ownership: SessionOwnershipTools;
  readonly combat: SessionCombatTools;
  readonly chat: SessionChatTools;
  readonly loot: SessionLootTools;

  private handlers: Map<string, (args: any) => Promise<any>>;

  constructor(options: SessionToolsOptions) {
    this.files = new SessionFileTools(options);
    this.scene = new SessionSceneTools(options);
    this.playlists = new SessionPlaylistTools(options);
    this.journal = new SessionJournalTools(options);
    this.ownership = new SessionOwnershipTools(options);
    this.combat = new SessionCombatTools(options);
    this.chat = new SessionChatTools(options);
    this.loot = new SessionLootTools(options);

    this.handlers = new Map<string, (args: any) => Promise<any>>([
      ['upload-file', args => this.files.handleUploadFile(args)],
      ['manage-files', args => this.files.handleManageFiles(args)],
      ['manage-scene', args => this.scene.handleManageScene(args)],
      ['place-tokens', args => this.scene.handlePlaceTokens(args)],
      ['manage-scene-lights', args => this.scene.handleManageSceneLights(args)],
      ['manage-walls', args => this.scene.handleManageWalls(args)],
      ['manage-tiles', args => this.scene.handleManageTiles(args)],
      ['manage-scene-notes', args => this.scene.handleManageSceneNotes(args)],
      ['manage-playlists', args => this.playlists.handleManagePlaylists(args)],
      ['manage-journal', args => this.journal.handleManageJournal(args)],
      ['show-to-players', args => this.journal.handleShowToPlayers(args)],
      ['manage-ownership', args => this.ownership.handleManageOwnership(args)],
      ['manage-combat', args => this.combat.handleManageCombat(args)],
      ['send-chat', args => this.chat.handleSendChat(args)],
      ['manage-rolltable', args => this.loot.handleManageRollTable(args)],
      ['manage-loot-pile', args => this.loot.handleManageLootPile(args)],
    ]);
  }

  getToolDefinitions() {
    return [
      ...this.files.getToolDefinitions(),
      ...this.scene.getToolDefinitions(),
      ...this.playlists.getToolDefinitions(),
      ...this.journal.getToolDefinitions(),
      ...this.ownership.getToolDefinitions(),
      ...this.combat.getToolDefinitions(),
      ...this.chat.getToolDefinitions(),
      ...this.loot.getToolDefinitions(),
    ];
  }

  /** True when this class answers to the tool name, used by the backend dispatcher. */
  canHandle(name: string): boolean {
    return this.handlers.has(name);
  }

  async handle(name: string, args: any): Promise<any> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Unknown session tool: ${name}`);
    }
    return await handler(args);
  }
}
