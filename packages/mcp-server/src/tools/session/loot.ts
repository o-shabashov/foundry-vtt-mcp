/**
 * Session table and loot tools.
 *
 * Roll tables for random encounters and treasure, and lootable piles on the map
 * backed by the item-piles module. Handlers forward to
 * `foundry-mcp-bridge.table.*` and `foundry-mcp-bridge.piles.*` queries.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import {
  BRIDGE,
  SCENE_JSON_PROPERTY,
  SessionToolsOptions,
  UNITS_DESCRIPTION,
  compact,
  requireField,
  unitsSchema,
} from './common.js';

const TABLE_ACTIONS = ['create', 'roll', 'list', 'delete', 'get'] as const;

const PILE_ACTIONS = ['create', 'add-items', 'open', 'close', 'lock', 'unlock', 'list'] as const;

/** Query method for each pile action, camelCase of the hyphenated name. */
const PILE_METHODS: Record<(typeof PILE_ACTIONS)[number], string> = {
  create: 'create',
  'add-items': 'addItems',
  open: 'open',
  close: 'close',
  lock: 'lock',
  unlock: 'unlock',
  list: 'list',
};

const DEFAULT_PILE_NAME = 'Loot';
const DEFAULT_PILE_IMAGE = 'icons/svg/chest.svg';

const tableResultSchema = z.object({
  text: z.string().min(1).optional(),
  document: z.string().min(1).optional(),
  weight: z.number().positive().default(1),
  range: z.tuple([z.number().int(), z.number().int()]).optional(),
});

const pileItemSchema = z.object({
  item: z.string().min(1),
  pack: z.string().min(1).optional(),
  quantity: z.number().int().positive().default(1),
});

export class SessionLootTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionLootTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-rolltable',
        description:
          'Roll tables for wandering monsters, treasure, rumours and complications.\n' +
          '- "create": a table from "results". Each result is either plain "text" or a ' +
          '"document" UUID that links an actor or item; "weight" makes an entry more likely and ' +
          '"range" pins it to explicit numbers.\n' +
          '- "roll": draw from the table, "rolls" times, posted to chat unless "toChat" is false.\n' +
          '- "get" shows a table with its results, "list" every table, "delete" removes one.\n' +
          'The formula defaults to "1d<number of results>". With "replacement" false an entry ' +
          'that came up is not drawn again until the table is reset.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...TABLE_ACTIONS],
              description: 'Operation to perform.',
            },
            table: {
              type: 'string',
              description: 'Roll table name, id, or UUID. Required for "roll", "get" and "delete".',
            },
            name: { type: 'string', description: 'Table name. Required for "create".' },
            folder: { type: 'string', description: 'Roll table folder, created when missing.' },
            formula: {
              type: 'string',
              description: 'Dice formula that picks a row. Defaults to "1d<number of results>".',
            },
            replacement: {
              type: 'boolean',
              description: 'Allow the same row to come up again. Defaults to true.',
            },
            results: {
              type: 'array',
              minItems: 1,
              description: 'Rows of the table. Required for "create".',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Plain text result.' },
                  document: {
                    type: 'string',
                    description:
                      'UUID of a linked document, e.g. ' +
                      '"Compendium.dnd5e.items.Item.abc123". Replaces "text".',
                  },
                  weight: {
                    type: 'number',
                    description: 'Relative likelihood of the row. Defaults to 1.',
                  },
                  range: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Explicit [from, to] range on the formula, e.g. [1, 3].',
                  },
                },
              },
            },
            rolls: {
              type: 'number',
              description: 'How many draws to make for "roll". Defaults to 1.',
            },
            toChat: {
              type: 'boolean',
              description: 'Post the draw to chat. Defaults to true.',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage-loot-pile',
        description:
          'Lootable piles and containers on the map, so players can take treasure themselves. ' +
          'Needs the item-piles module active in the world; without it the call fails with a ' +
          'clear message.\n' +
          '- "create": a pile token at a position on a scene, filled from "items" (compendium ' +
          'UUIDs, or item names together with "pack").\n' +
          '- "type": "container" is a chest that opens, "pile" is loose loot on the ground.\n' +
          '- "add-items": drop more into an existing pile. "open" / "close" show or hide its ' +
          'contents, "lock" / "unlock" gate it behind a check.\n' +
          '- "list": every pile on the scene with its contents.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...PILE_ACTIONS],
              description: 'Operation to perform.',
            },
            scene: SCENE_JSON_PROPERTY,
            x: { type: 'number', description: 'Horizontal position of the pile token.' },
            y: { type: 'number', description: 'Vertical position of the pile token.' },
            units: { type: 'string', enum: ['px', 'grid'], description: UNITS_DESCRIPTION },
            name: {
              type: 'string',
              description: `Pile name shown to players. Defaults to "${DEFAULT_PILE_NAME}".`,
            },
            image: {
              type: 'string',
              description: `Token art path. Defaults to "${DEFAULT_PILE_IMAGE}".`,
            },
            type: {
              type: 'string',
              enum: ['pile', 'container'],
              description: 'Pile flavour. Defaults to "container".',
            },
            items: {
              type: 'array',
              minItems: 1,
              description: 'Items to put in. Required for "create" and "add-items".',
              items: {
                type: 'object',
                properties: {
                  item: {
                    type: 'string',
                    description:
                      'Item UUID such as "Compendium.dnd5e.items.Item.abc123", or an item name ' +
                      'when "pack" is given.',
                  },
                  pack: {
                    type: 'string',
                    description: 'Compendium pack to look the item name up in.',
                  },
                  quantity: { type: 'number', description: 'How many. Defaults to 1.' },
                },
                required: ['item'],
              },
            },
            pile: {
              type: 'string',
              description:
                'Existing pile token by name or id. Required for everything except "create" and ' +
                '"list".',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  // ── manage-rolltable ──────────────────────────────────────────────────────

  async handleManageRollTable(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(TABLE_ACTIONS),
      table: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      folder: z.string().min(1).optional(),
      formula: z.string().min(1).optional(),
      replacement: z.boolean().default(true),
      results: z.array(tableResultSchema).min(1).optional(),
      rolls: z.number().int().positive().default(1),
      toChat: z.boolean().default(true),
    });

    const parsed = schema.parse(args);
    const { action, results } = parsed;

    if (action === 'create') {
      requireField('manage-rolltable', action, 'name', parsed.name);
      requireField('manage-rolltable', action, 'results', results);
      results?.forEach((result, index) => {
        if (!result.text && !result.document) {
          throw new Error(`manage-rolltable result ${index} needs "text" or "document"`);
        }
      });
    } else if (action !== 'list') {
      requireField('manage-rolltable', action, 'table', parsed.table);
    }

    // A table with N rows rolls 1dN unless the caller wants something else.
    const formula =
      action === 'create' ? (parsed.formula ?? `1d${results?.length ?? 1}`) : parsed.formula;

    this.logger.info('Managing roll table', {
      action,
      table: parsed.table ?? parsed.name,
      results: results?.length ?? 0,
    });

    return await this.foundryClient.query(
      `${BRIDGE}.table.${action}`,
      compact({
        ...parsed,
        action: undefined,
        formula,
        results: results?.map(result => compact(result)),
      })
    );
  }

  // ── manage-loot-pile ──────────────────────────────────────────────────────

  async handleManageLootPile(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(PILE_ACTIONS),
      scene: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      units: unitsSchema.optional(),
      name: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
      type: z.enum(['pile', 'container']).optional(),
      items: z.array(pileItemSchema).min(1).optional(),
      pile: z.string().min(1).optional(),
    });

    const parsed = schema.parse(args);
    const { action } = parsed;

    if (action === 'create') {
      if (parsed.x === undefined || parsed.y === undefined) {
        throw new Error('manage-loot-pile action "create" requires "x" and "y"');
      }
    } else if (action !== 'list') {
      requireField('manage-loot-pile', action, 'pile', parsed.pile);
    }
    if (action === 'add-items') {
      requireField('manage-loot-pile', action, 'items', parsed.items);
    }

    const withDefaults =
      action === 'create'
        ? {
            name: parsed.name ?? DEFAULT_PILE_NAME,
            image: parsed.image ?? DEFAULT_PILE_IMAGE,
            type: parsed.type ?? 'container',
          }
        : {};

    this.logger.info('Managing loot pile', {
      action,
      scene: parsed.scene,
      items: parsed.items?.length ?? 0,
    });

    return await this.foundryClient.query(
      `${BRIDGE}.piles.${PILE_METHODS[action]}`,
      compact({
        ...parsed,
        ...withDefaults,
        action: undefined,
        items: parsed.items?.map(item => compact(item)),
      })
    );
  }
}
