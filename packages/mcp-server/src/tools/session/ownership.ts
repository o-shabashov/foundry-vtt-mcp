/**
 * Session ownership tool.
 *
 * Read and set permissions on any document a session hands to players: handouts,
 * maps, loot actors, playlists, roll tables, single journal pages. Forwards to
 * `foundry-mcp-bridge.ownership.set` and `.get`.
 *
 * The existing assign-actor-ownership tool stays as it is; this one covers the
 * other document types and the "everyone" shortcut.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import {
  BRIDGE,
  OWNERSHIP_LEVELS_WITH_INHERIT,
  SessionToolsOptions,
  compact,
  ownershipLevelSchema,
} from './common.js';

const DOCUMENT_TYPES = [
  'Actor',
  'JournalEntry',
  'Scene',
  'Playlist',
  'Item',
  'Macro',
  'RollTable',
  'JournalEntryPage',
] as const;

export class SessionOwnershipTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionOwnershipTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-ownership',
        description:
          'Read or set who may see and edit a document: journal handouts, scenes, playlists, ' +
          'roll tables, loot actors, single journal pages.\n' +
          '- Pass "default", "users" or "players" to set permissions; pass none of them to read ' +
          'the current ones. "action" makes that explicit when you want it spelled out.\n' +
          '- "players" grants one level to every non-GM player at once, the usual way to hand a ' +
          'handout to the table.\n' +
          '- Levels: "none" hides it, "limited" shows a summary, "observer" shows everything ' +
          'read-only, "owner" allows editing. "inherit" only applies to journal pages, which ' +
          'follow their entry by default.\n' +
          '- For "JournalEntryPage" pass the entry in "journal" and the page in "identifier".',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['set', 'get'],
              description:
                'Operation to perform. Inferred when omitted: "set" if any permission field is ' +
                'given, otherwise "get".',
            },
            documentType: {
              type: 'string',
              enum: [...DOCUMENT_TYPES],
              description: 'Type of document to work on.',
            },
            identifier: {
              type: 'string',
              description:
                'Document name, id, or UUID. For "JournalEntryPage" the page name or id inside ' +
                '"journal".',
            },
            journal: {
              type: 'string',
              description: 'Journal entry holding the page. Required for "JournalEntryPage".',
            },
            default: {
              type: 'string',
              enum: [...OWNERSHIP_LEVELS_WITH_INHERIT],
              description: 'Level for every user without an explicit entry.',
            },
            users: {
              type: 'object',
              additionalProperties: {
                type: 'string',
                enum: [...OWNERSHIP_LEVELS_WITH_INHERIT],
              },
              description: 'Per-user levels, keyed by player name or user id.',
            },
            players: {
              type: 'string',
              enum: [...OWNERSHIP_LEVELS_WITH_INHERIT],
              description: 'One level applied to every non-GM player at once.',
            },
          },
          required: ['documentType', 'identifier'],
        },
      },
    ];
  }

  async handleManageOwnership(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(['set', 'get']).optional(),
      documentType: z.enum(DOCUMENT_TYPES),
      identifier: z.string().min(1),
      journal: z.string().min(1).optional(),
      default: ownershipLevelSchema.optional(),
      users: z.record(ownershipLevelSchema).optional(),
      players: ownershipLevelSchema.optional(),
    });

    const parsed = schema.parse(args);

    const hasPermissions =
      parsed.default !== undefined || parsed.users !== undefined || parsed.players !== undefined;
    const action = parsed.action ?? (hasPermissions ? 'set' : 'get');

    if (action === 'set' && !hasPermissions) {
      throw new Error('manage-ownership action "set" requires "default", "users" or "players"');
    }
    if (parsed.documentType === 'JournalEntryPage' && !parsed.journal) {
      throw new Error('manage-ownership documentType "JournalEntryPage" requires "journal"');
    }

    this.logger.info('Managing ownership', {
      action,
      documentType: parsed.documentType,
      identifier: parsed.identifier,
    });

    return await this.foundryClient.query(
      `${BRIDGE}.ownership.${action}`,
      compact({ ...parsed, action })
    );
  }
}
