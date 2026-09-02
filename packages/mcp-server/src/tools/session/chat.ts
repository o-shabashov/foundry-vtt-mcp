/**
 * Session chat tool.
 *
 * Post read-aloud text, NPC lines, whispers and rolls into the Foundry chat log.
 * Forwards to the `foundry-mcp-bridge.chat.send` query.
 *
 * The `messageFile` argument is advertised in the schema so MCP clients can use
 * it, but the stdio wrapper (src/tool-files.ts) reads the file into `message`
 * before the call reaches this class.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { BRIDGE, SessionToolsOptions, compact } from './common.js';

export class SessionChatTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionChatTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'send-chat',
        description:
          'Post a message into the Foundry chat log: read-aloud boxed text, an NPC line, a ' +
          'whisper to one player, a picture, or a roll.\n' +
          '- "message" is HTML, so paragraphs, emphasis and blockquotes all work. ' +
          '"messageFile" loads it from a local .html or .txt file instead.\n' +
          '- "speaker" makes an actor or a token say it; without one the GM speaks.\n' +
          '- "style": "ic" in character, "ooc" out of character, "emote" as an action, "other" ' +
          'as a plain narrator card. Defaults to "ic" with a speaker, "other" without.\n' +
          '- "whisperTo": "gm" or a list of player names keeps it private.\n' +
          '- "roll": a dice formula such as "2d6+3" is rolled and shown with the message.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Message body as HTML. Mutually exclusive with "messageFile".',
            },
            messageFile: {
              type: 'string',
              description:
                'Path to a local .html or .txt file holding the message, read by the MCP wrapper ' +
                'on the machine running this server. Mutually exclusive with "message".',
            },
            speaker: {
              type: 'string',
              description:
                'Actor or token name to speak as. Without it the message comes from the GM.',
            },
            style: {
              type: 'string',
              enum: ['ic', 'ooc', 'emote', 'other'],
              description:
                'Message style. Defaults to "ic" when a speaker is given, otherwise "other".',
            },
            whisperTo: {
              description: 'Keep the message private: "gm", or a list of player names or ids.',
              oneOf: [
                { type: 'string', enum: ['gm'] },
                { type: 'array', items: { type: 'string' }, minItems: 1 },
              ],
            },
            image: {
              type: 'string',
              description:
                'Image path inside the Data directory, appended to the message as a picture.',
            },
            flavor: { type: 'string', description: 'Small line above the message body.' },
            roll: {
              type: 'string',
              description: 'Dice formula rolled and attached to the message, e.g. "1d20+5".',
            },
          },
        },
      },
    ];
  }

  async handleSendChat(args: any): Promise<any> {
    if (args?.message === undefined) {
      throw new Error('send-chat requires "message" or "messageFile" (read by the MCP wrapper)');
    }

    const schema = z.object({
      message: z.string().min(1),
      speaker: z.string().min(1).optional(),
      style: z.enum(['ic', 'ooc', 'emote', 'other']).optional(),
      whisperTo: z.union([z.literal('gm'), z.array(z.string().min(1)).min(1)]).optional(),
      image: z.string().min(1).optional(),
      flavor: z.string().optional(),
      roll: z.string().min(1).optional(),
    });

    const parsed = schema.parse(args);
    const style = parsed.style ?? (parsed.speaker ? 'ic' : 'other');

    this.logger.info('Sending chat message', {
      length: parsed.message.length,
      speaker: parsed.speaker,
      style,
      whisper: parsed.whisperTo !== undefined,
    });

    return await this.foundryClient.query(`${BRIDGE}.chat.send`, compact({ ...parsed, style }));
  }
}
