/**
 * Session combat tool.
 *
 * Start an encounter from the tokens already on a scene, roll initiative, walk the
 * turn order and end it again. Forwards to `foundry-mcp-bridge.combat.*` queries.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { BRIDGE, SCENE_JSON_PROPERTY, SessionToolsOptions, compact } from './common.js';

const COMBAT_ACTIONS = [
  'create',
  'add',
  'remove',
  'roll-initiative',
  'start',
  'next',
  'previous',
  'end',
  'status',
] as const;

/** Query method for each action, camelCase of the hyphenated name. */
const COMBAT_METHODS: Record<(typeof COMBAT_ACTIONS)[number], string> = {
  create: 'create',
  add: 'add',
  remove: 'remove',
  'roll-initiative': 'rollInitiative',
  start: 'start',
  next: 'next',
  previous: 'previous',
  end: 'end',
  status: 'status',
};

export class SessionCombatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionCombatTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-combat',
        description:
          'Run the encounter tracker from the tokens on a scene.\n' +
          '- "create": a new combat with combatants. Pick them with "tokens" (names or ids) or ' +
          '"select"; without either, every token on the scene joins.\n' +
          '- "add" / "remove": change the roster of the running combat.\n' +
          '- "roll-initiative": roll for the combatants you name, or for the NPCs with ' +
          '"rollNpc", or for everyone with "rollAll". Fixed numbers go in "initiative".\n' +
          '- "start", "next", "previous", "end": drive the turn order.\n' +
          '- "status": round, current turn and every combatant with initiative and flags.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...COMBAT_ACTIONS],
              description: 'Operation to perform.',
            },
            scene: SCENE_JSON_PROPERTY,
            tokens: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Token names or ids on the scene.',
            },
            select: {
              type: 'string',
              enum: ['all', 'hostile', 'friendly', 'npc', 'pc'],
              description:
                'Pick combatants in bulk instead of naming them: every token, by disposition, ' +
                'or by whether the actor is player owned.',
            },
            initiative: {
              type: 'object',
              additionalProperties: { type: 'number' },
              description:
                'Fixed initiative values, keyed by token name or id, e.g. {"Ozhog": 20}.',
            },
            rollNpc: {
              type: 'boolean',
              description: 'Roll initiative for NPC combatants. Defaults to true.',
            },
            rollAll: {
              type: 'boolean',
              description: 'Roll initiative for every combatant, players included.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleManageCombat(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(COMBAT_ACTIONS),
      scene: z.string().min(1).optional(),
      tokens: z.array(z.string().min(1)).min(1).optional(),
      select: z.enum(['all', 'hostile', 'friendly', 'npc', 'pc']).optional(),
      initiative: z.record(z.number()).optional(),
      rollNpc: z.boolean().default(true),
      rollAll: z.boolean().optional(),
    });

    const parsed = schema.parse(args);
    const { action } = parsed;

    if ((action === 'add' || action === 'remove') && !parsed.tokens && !parsed.select) {
      throw new Error(`manage-combat action "${action}" requires "tokens" or "select"`);
    }

    this.logger.info('Managing combat', {
      action,
      scene: parsed.scene,
      tokens: parsed.tokens?.length ?? 0,
      select: parsed.select,
    });

    return await this.foundryClient.query(
      `${BRIDGE}.combat.${COMBAT_METHODS[action]}`,
      compact({ ...parsed, action: undefined })
    );
  }
}
