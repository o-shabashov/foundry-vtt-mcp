/**
 * Session journal tools.
 *
 * Multi-page journal entries with text, image, PDF and video pages, per-page
 * permissions, and pushing an entry, a page or a bare image onto the players'
 * screens. Handlers forward to `foundry-mcp-bridge.journal.*` queries.
 *
 * The `contentFile` argument of a page is advertised in the schema so MCP clients
 * can use it, but the stdio wrapper (src/tool-files.ts) reads the file into
 * `content` before the call reaches this class.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import {
  BRIDGE,
  OWNERSHIP_JSON_SCHEMA,
  SessionToolsOptions,
  USERS_JSON_SCHEMA,
  compact,
  ownershipSchema,
  requireField,
  usersSchema,
} from './common.js';

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

/** Query method for each action, camelCase of the hyphenated name. */
const JOURNAL_METHODS: Record<(typeof JOURNAL_ACTIONS)[number], string> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  'add-pages': 'addPages',
  'update-page': 'updatePage',
  'delete-pages': 'deletePages',
  list: 'list',
  get: 'get',
};

const PAGE_TYPES = ['text', 'image', 'pdf', 'video'] as const;

const pageSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(PAGE_TYPES).default('text'),
  content: z.string().optional(),
  src: z.string().min(1).optional(),
  caption: z.string().optional(),
  titleLevel: z.number().int().min(1).max(6).default(1),
  showTitle: z.boolean().default(true),
  ownership: ownershipSchema.optional(),
});

export class SessionJournalTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionJournalTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-journal',
        description:
          'Journal entries with several pages, mixed page types and per-page permissions: ' +
          'handouts, letters, maps, read-aloud text, background reading for one player.\n' +
          '- "create": an entry, with its pages when "pages" is given.\n' +
          '- "add-pages" / "update-page" / "delete-pages": work on the pages of an entry.\n' +
          '- "update": rename the entry, move it to a folder, change its permissions.\n' +
          '- "get": the entry with every page listed; "list": all entries.\n' +
          'Text pages store HTML in "content"; pass HTML, not Markdown. "contentFile" loads it ' +
          'from a local .html or .txt file instead. Image, PDF and video pages take a Data ' +
          'directory path in "src" - upload it with upload-file first.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...JOURNAL_ACTIONS],
              description: 'Operation to perform.',
            },
            journal: {
              type: 'string',
              description:
                'Journal entry name, id, or UUID. Required for everything except "create" and ' +
                '"list".',
            },
            name: {
              type: 'string',
              description: 'Entry name. Required for "create", renames on "update".',
            },
            folder: { type: 'string', description: 'Journal folder name, created when missing.' },
            ownership: OWNERSHIP_JSON_SCHEMA,
            pages: {
              type: 'array',
              minItems: 1,
              description:
                'Pages for "create" and "add-pages", or the single set of changes for ' +
                '"update-page".',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Page title.' },
                  type: {
                    type: 'string',
                    enum: [...PAGE_TYPES],
                    description: 'Page type. Defaults to "text".',
                  },
                  content: {
                    type: 'string',
                    description: 'HTML body of a text page. Markdown is not converted, send HTML.',
                  },
                  contentFile: {
                    type: 'string',
                    description:
                      'Path to a local .html or .txt file holding the page body, read by the MCP ' +
                      'wrapper on the machine running this server. Markdown files are refused. ' +
                      'Mutually exclusive with "content".',
                  },
                  src: {
                    type: 'string',
                    description:
                      'Data directory path of the image, PDF or video shown by the page.',
                  },
                  caption: { type: 'string', description: 'Caption under an image page.' },
                  titleLevel: {
                    type: 'number',
                    description: 'Heading level of the page title, 1 to 6. Defaults to 1.',
                  },
                  showTitle: {
                    type: 'boolean',
                    description: 'Show the page title in the entry. Defaults to true.',
                  },
                  ownership: OWNERSHIP_JSON_SCHEMA,
                },
              },
            },
            page: {
              type: 'string',
              description: 'Page name or id. Required for "update-page".',
            },
            pageIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Page ids to remove. Required for "delete-pages".',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'show-to-players',
        description:
          "Push something onto the players' screens right now: a journal entry, one page of it, " +
          'or a bare image such as an NPC portrait or a handout.\n' +
          '- "what": "journal" opens the whole entry, "page" opens one page, "image" pops the ' +
          'picture up on its own.\n' +
          '- "users" limits the audience; by default everyone gets it.\n' +
          '- "force" (default true) shows the entry even to players who have no permission to ' +
          'read it, which is what you usually want for a one-off reveal. Set it false to respect ' +
          'existing permissions.',
        inputSchema: {
          type: 'object',
          properties: {
            what: {
              type: 'string',
              enum: ['journal', 'page', 'image'],
              description: 'What to show.',
            },
            journal: {
              type: 'string',
              description: 'Journal entry name, id, or UUID. Required for "journal" and "page".',
            },
            page: {
              type: 'string',
              description: 'Page name or id inside the entry. Required for "page".',
            },
            image: {
              type: 'string',
              description: 'Image path inside the Data directory. Required for "image".',
            },
            title: {
              type: 'string',
              description: 'Window title for an image popout. Defaults to the file name.',
            },
            users: USERS_JSON_SCHEMA,
            force: {
              type: 'boolean',
              description: 'Show the entry even without read permission. Defaults to true.',
            },
          },
          required: ['what'],
        },
      },
    ];
  }

  // ── manage-journal ────────────────────────────────────────────────────────

  async handleManageJournal(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(JOURNAL_ACTIONS),
      journal: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      folder: z.string().min(1).optional(),
      ownership: ownershipSchema.optional(),
      pages: z.array(pageSchema).min(1).optional(),
      page: z.string().min(1).optional(),
      pageIds: z.array(z.string().min(1)).min(1).optional(),
    });

    const parsed = schema.parse(args);
    const { action, pages } = parsed;

    if (action === 'create') {
      requireField('manage-journal', action, 'name', parsed.name);
    } else if (action !== 'list') {
      requireField('manage-journal', action, 'journal', parsed.journal);
    }
    if (action === 'create' || action === 'add-pages') {
      if (action === 'add-pages') requireField('manage-journal', action, 'pages', pages);
      pages?.forEach((entry, index) => {
        if (!entry.name) {
          throw new Error(`manage-journal action "${action}" requires "name" on page ${index}`);
        }
        if (entry.type !== 'text' && !entry.src) {
          throw new Error(
            `manage-journal page ${index} of type "${entry.type}" requires "src", a path in the Data directory`
          );
        }
      });
    }
    if (action === 'update-page') {
      requireField('manage-journal', action, 'page', parsed.page);
      if (!pages || pages.length !== 1) {
        throw new Error(
          'manage-journal action "update-page" requires exactly one entry in "pages" holding the changed fields'
        );
      }
    }
    if (action === 'delete-pages') {
      requireField('manage-journal', action, 'pageIds', parsed.pageIds);
    }

    this.logger.info('Managing journal', {
      action,
      journal: parsed.journal ?? parsed.name,
      pages: pages?.length ?? 0,
    });

    const payload = compact({
      ...parsed,
      action: undefined,
      pages: pages?.map(entry => compact(entry)),
    });

    return await this.foundryClient.query(`${BRIDGE}.journal.${JOURNAL_METHODS[action]}`, payload);
  }

  // ── show-to-players ───────────────────────────────────────────────────────

  async handleShowToPlayers(args: any): Promise<any> {
    const schema = z.object({
      what: z.enum(['journal', 'page', 'image']),
      journal: z.string().min(1).optional(),
      page: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
      title: z.string().optional(),
      users: usersSchema.default('all'),
      force: z.boolean().default(true),
    });

    const parsed = schema.parse(args);
    const { what } = parsed;

    if (what === 'image') {
      requireField('show-to-players', what, 'image', parsed.image);
    } else {
      requireField('show-to-players', what, 'journal', parsed.journal);
      if (what === 'page') requireField('show-to-players', what, 'page', parsed.page);
    }

    this.logger.info('Showing to players', { what, users: parsed.users });

    const method = what === 'image' ? 'showImage' : 'show';

    return await this.foundryClient.query(
      `${BRIDGE}.journal.${method}`,
      compact({ ...parsed, what })
    );
  }
}
