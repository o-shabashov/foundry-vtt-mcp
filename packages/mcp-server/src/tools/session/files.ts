/**
 * Session file tools.
 *
 * Upload maps, portraits, handouts and audio into the Foundry Data directory and
 * browse or create folders there. Every handler forwards to a
 * `foundry-mcp-bridge.files.*` query in the module.
 *
 * The `filePath` argument of upload-file is advertised in the schema so MCP
 * clients can use it, but it is handled entirely by the stdio wrapper
 * (src/tool-files.ts): the file is read there, base64 encoded into `fileData`
 * and never reaches this class.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { BRIDGE, SessionToolsOptions } from './common.js';

/** Largest file the wrapper will inline as base64, kept in sync with tool-files.ts. */
export const MAX_UPLOAD_MB = 25;

export class SessionFileTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionFileTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'upload-file',
        description:
          'Upload one file into the Foundry Data directory: scene backgrounds, tile art, token ' +
          'images, handouts, PDFs, or music and ambience for playlists.\n' +
          '- "filePath" is a path on the machine running this MCP server, which is the MCP ' +
          "client's machine, not the Foundry host. It is read by the wrapper, base64 encoded and " +
          'sent over the bridge; files larger than ' +
          `${MAX_UPLOAD_MB} MB are refused, copy those to the Foundry host over ssh/scp instead.\n` +
          '- "targetDir" is a path inside the Data directory such as "worlds/campaign/maps"; ' +
          'missing folders are created. Non-latin folder and file names work, Foundry encodes ' +
          'the path itself.\n' +
          '- Returns the stored path exactly as Foundry reports it (percent-encoded), which is ' +
          'the string other tools expect for "background", "image", "src" or track "path".',
        inputSchema: {
          type: 'object',
          properties: {
            targetDir: {
              type: 'string',
              description:
                'Destination folder inside the Foundry Data directory, e.g. ' +
                '"worlds/my-world/maps". Created recursively when missing.',
            },
            filePath: {
              type: 'string',
              description:
                'Path to the local file to upload, read by the MCP wrapper on the machine ' +
                `running this server (the MCP client's machine). Limit ${MAX_UPLOAD_MB} MB. ` +
                'Mutually exclusive with "fileData".',
            },
            fileName: {
              type: 'string',
              description: 'Name to store the file under. Defaults to the basename of "filePath".',
            },
            fileData: {
              type: 'string',
              description:
                'Base64 encoded file contents, for callers that do not have the file on disk. ' +
                'Normally filled in by the wrapper from "filePath".',
            },
            mimeType: {
              type: 'string',
              description:
                'MIME type of the upload. Defaults to a type guessed from the file extension.',
            },
            overwrite: {
              type: 'boolean',
              description: 'Replace an existing file of the same name. Defaults to true.',
            },
            source: {
              type: 'string',
              enum: ['data'],
              description: 'Foundry file source. Only the world "data" source is supported.',
            },
          },
          required: ['targetDir'],
        },
      },
      {
        name: 'manage-files',
        description:
          'Browse or create folders in the Foundry Data directory.\n' +
          '- "list": folders and files of one directory, with the paths other tools expect.\n' +
          '- "mkdir": create a directory, parents included.\n' +
          'Foundry exposes no delete endpoint, so files can only be added or overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'mkdir'],
              description: 'Operation to perform.',
            },
            dir: {
              type: 'string',
              description:
                'Directory inside the Data directory, e.g. "worlds/my-world/maps". Use "" or "." ' +
                'for the Data root.',
            },
            source: {
              type: 'string',
              enum: ['data'],
              description: 'Foundry file source. Only the world "data" source is supported.',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For "list": keep only files with these extensions, e.g. [".webp", ".png"].',
            },
          },
          required: ['action', 'dir'],
        },
      },
    ];
  }

  // ── upload-file ───────────────────────────────────────────────────────────

  async handleUploadFile(args: any): Promise<any> {
    if (args?.fileData === undefined && args?.filePath === undefined) {
      throw new Error(
        'upload-file requires "filePath" (read by the MCP wrapper) or inline base64 "fileData"'
      );
    }

    const schema = z.object({
      targetDir: z.string().min(1),
      fileName: z.string().min(1),
      fileData: z.string().min(1),
      mimeType: z.string().min(1).optional(),
      overwrite: z.boolean().default(true),
      source: z.enum(['data']).default('data'),
    });

    const parsed = schema.parse(args);

    this.logger.info('Uploading file', {
      targetDir: parsed.targetDir,
      fileName: parsed.fileName,
      base64Length: parsed.fileData.length,
    });

    return await this.foundryClient.query(`${BRIDGE}.files.upload`, parsed);
  }

  // ── manage-files ──────────────────────────────────────────────────────────

  async handleManageFiles(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(['list', 'mkdir']),
      dir: z.string(),
      source: z.enum(['data']).default('data'),
      extensions: z.array(z.string().min(1)).optional(),
    });

    const { action, dir, source, extensions } = schema.parse(args);

    this.logger.info('Managing files', { action, dir });

    const method = action === 'list' ? `${BRIDGE}.files.browse` : `${BRIDGE}.files.mkdir`;

    return await this.foundryClient.query(method, { dir, source, extensions });
  }
}
