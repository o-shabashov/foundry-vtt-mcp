import type { FoundryDataAccess } from '../data-access.js';
import { CombatChatHandlers } from './combat-chat-handlers.js';
import { FilesHandlers } from './files-handlers.js';
import { JournalHandlers } from './journal-handlers.js';
import { LootHandlers } from './loot-handlers.js';
import { PlaylistHandlers } from './playlist-handlers.js';
import { SceneHandlers } from './scene-handlers.js';

/**
 * Session preparation tools.
 *
 * Everything registered from here lives under
 * `CONFIG.queries['foundry-mcp-bridge.<files|scene|playlist|journal|ownership|combat|chat|table|piles>.*']`
 * and is deliberately kept out of `queries.ts` so upstream merges stay conflict-free.
 * The theme is preparing and running a whole session: upload the maps and the music,
 * build scenes with grids, light, walls and tokens, hand out journals and images,
 * run the combat and narrate it in chat, then hand out the loot.
 *
 * Unregistration is handled by QueryHandlers.unregisterHandlers(), which drops every
 * key carrying the module prefix.
 */
export function registerSessionHandlers(dataAccess: FoundryDataAccess): void {
  new FilesHandlers(dataAccess).registerHandlers();
  new SceneHandlers(dataAccess).registerHandlers();
  new PlaylistHandlers(dataAccess).registerHandlers();
  new JournalHandlers(dataAccess).registerHandlers();
  new CombatChatHandlers(dataAccess).registerHandlers();
  new LootHandlers(dataAccess).registerHandlers();
}

export {
  CombatChatHandlers,
  FilesHandlers,
  JournalHandlers,
  LootHandlers,
  PlaylistHandlers,
  SceneHandlers,
};
