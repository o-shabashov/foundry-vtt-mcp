/**
 * Session scene tools.
 *
 * Build a playable map from an uploaded background: create the scene and its grid,
 * drop tokens, place ambient light, raise walls and doors (hand-made, from a
 * rectangle, or imported from a Universal VTT export), lay tiles and pin journal
 * notes. Every handler forwards to a `foundry-mcp-bridge.scene.*` query.
 *
 * Light presets are expanded here rather than in the module, so the bridge always
 * receives fully explicit light configurations.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import {
  BRIDGE,
  SCENE_JSON_PROPERTY,
  OWNERSHIP_JSON_SCHEMA,
  SessionToolsOptions,
  UNITS_DESCRIPTION,
  compact,
  ownershipSchema,
  pointFields,
  pointJsonProperties,
  pointJsonSchema,
  pointSchema,
  requireField,
  unitsSchema,
} from './common.js';

// ── constants ─────────────────────────────────────────────────────────────────

export const GRID_TYPES = ['square', 'hexOdd', 'hexEven', 'gridless'] as const;

export const LIGHT_ANIMATIONS = [
  'none',
  'torch',
  'flame',
  'pulse',
  'chroma',
  'wave',
  'fog',
  'sunburst',
  'dome',
  'emanation',
  'hexa',
  'ghost',
  'energy',
  'roiling',
  'hole',
  'vortex',
  'witchwave',
  'rainbowswirl',
  'radialrainbow',
  'fairy',
  'grid',
  'starlight',
  'smokepatch',
  'siren',
  'reverse',
  'blackhole',
  'revolving',
] as const;

export const LIGHT_PRESETS = [
  'torch',
  'campfire',
  'candle',
  'moonlight',
  'lantern',
  'magical',
] as const;

/** Preset light configurations, in scene distance units. Explicit fields win over these. */
const LIGHT_PRESET_VALUES: Record<string, Record<string, unknown>> = {
  torch: { animation: 'torch', color: '#ff9329', bright: 20, dim: 40 },
  campfire: { animation: 'flame', color: '#ff6a00', bright: 15, dim: 30 },
  candle: { animation: 'torch', color: '#ffd37a', bright: 5, dim: 10 },
  moonlight: { animation: 'none', color: '#8fa9ff', bright: 0, dim: 60, alpha: 0.2 },
  lantern: { animation: 'none', color: '#f7d9a0', bright: 15, dim: 35, alpha: 0.4 },
  magical: {
    animation: 'pulse',
    color: '#8bd3ff',
    bright: 10,
    dim: 25,
    alpha: 0.5,
    animationSpeed: 3,
    animationIntensity: 4,
  },
};

/** Applied to every created light before the preset and the explicit fields. */
const LIGHT_DEFAULTS: Record<string, unknown> = {
  bright: 20,
  dim: 40,
  alpha: 0.5,
  angle: 360,
  animation: 'none',
  animationSpeed: 5,
  animationIntensity: 5,
  walls: true,
  vision: false,
};

/** Defaults filled in when a scene is created; updates stay sparse. */
const SCENE_CREATE_DEFAULTS = {
  gridSize: 100,
  gridType: 'square',
  gridDistance: 5,
  gridUnits: 'ft',
  padding: 0.25,
  darkness: 0,
  tokenVision: true,
  fogExploration: true,
  navigation: true,
} as const;

// ── schemas ───────────────────────────────────────────────────────────────────

const sceneSettingsShape = {
  name: z.string().min(1).optional(),
  background: z.string().min(1).optional(),
  folder: z.string().min(1).optional(),
  gridSize: z.number().positive().optional(),
  gridType: z.enum(GRID_TYPES).optional(),
  gridDistance: z.number().positive().optional(),
  gridUnits: z.string().min(1).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  padding: z.number().min(0).max(0.5).optional(),
  backgroundColor: z.string().min(1).optional(),
  darkness: z.number().min(0).max(1).optional(),
  globalLight: z.boolean().optional(),
  tokenVision: z.boolean().optional(),
  fogExploration: z.boolean().optional(),
  navigation: z.boolean().optional(),
  navName: z.string().optional(),
  playlist: z.string().min(1).optional(),
  initialView: z.object({ x: z.number(), y: z.number(), scale: z.number().positive() }).optional(),
  activate: z.boolean().optional(),
  ownership: ownershipSchema.optional(),
};

const tokenSchema = z.object({
  actor: z.string().min(1),
  ...pointFields,
  name: z.string().min(1).optional(),
  hidden: z.boolean().optional(),
  disposition: z.enum(['hostile', 'neutral', 'friendly', 'secret']).optional(),
  elevation: z.number().optional(),
  count: z.number().int().positive().max(50).default(1),
  scale: z.number().positive().optional(),
});

const lightSchema = z.object({
  id: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  units: unitsSchema.optional(),
  preset: z.enum(LIGHT_PRESETS).optional(),
  bright: z.number().min(0).optional(),
  dim: z.number().min(0).optional(),
  color: z.string().min(1).optional(),
  alpha: z.number().min(0).max(1).optional(),
  angle: z.number().min(0).max(360).optional(),
  rotation: z.number().optional(),
  animation: z.enum(LIGHT_ANIMATIONS).optional(),
  animationSpeed: z.number().min(0).max(10).optional(),
  animationIntensity: z.number().min(0).max(10).optional(),
  walls: z.boolean().optional(),
  vision: z.boolean().optional(),
  hidden: z.boolean().optional(),
  luminosity: z.number().min(-1).max(1).optional(),
  negative: z.boolean().optional(),
});

const wallSchema = z.object({
  from: pointSchema,
  to: pointSchema,
  door: z.enum(['none', 'door', 'secret']).default('none'),
  doorState: z.enum(['closed', 'open', 'locked']).optional(),
  move: z.boolean().default(true),
  sight: z.boolean().default(true),
  light: z.boolean().default(true),
  sound: z.boolean().default(true),
  oneWay: z.enum(['none', 'left', 'right']).default('none'),
});

const tileSchema = z.object({
  id: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  units: unitsSchema.optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  overhead: z.boolean().optional(),
  hidden: z.boolean().optional(),
  rotation: z.number().optional(),
  alpha: z.number().min(0).max(1).optional(),
  sort: z.number().int().optional(),
});

const noteSchema = z.object({
  journal: z.string().min(1),
  page: z.string().min(1).optional(),
  ...pointFields,
  label: z.string().optional(),
  icon: z.string().min(1).default('icons/svg/book.svg'),
  iconSize: z.number().int().positive().default(40),
  global: z.boolean().optional(),
});

// ── tool ──────────────────────────────────────────────────────────────────────

export class SessionSceneTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionSceneTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-scene',
        description:
          'Create and manage scenes: grid, dimensions, darkness, vision, navigation, background ' +
          'playlist and permissions.\n' +
          '- "create": needs "name" and "background" (a path in the Data directory, upload it ' +
          'with upload-file first). Width and height are read from the image when omitted.\n' +
          '- "update": only the fields you pass are changed, everything else stays as it is.\n' +
          '- "delete", "activate": act on one scene.\n' +
          '- "list": every scene with size, grid and token count.\n' +
          '- "info": one scene in detail, with counts of tokens, lights, walls, tiles, notes and ' +
          'sounds.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete', 'activate', 'list', 'info'],
              description: 'Operation to perform.',
            },
            scene: SCENE_JSON_PROPERTY,
            name: {
              type: 'string',
              description: 'Scene name. Required for "create".',
            },
            background: {
              type: 'string',
              description:
                'Background image path inside the Data directory, e.g. ' +
                '"worlds/my-world/maps/crypt.webp". Required for "create".',
            },
            folder: { type: 'string', description: 'Scene folder name, created when missing.' },
            gridSize: {
              type: 'number',
              description: 'Grid square size in pixels of the background image. Defaults to 100.',
            },
            gridType: {
              type: 'string',
              enum: [...GRID_TYPES],
              description: 'Grid layout. Defaults to "square".',
            },
            gridDistance: {
              type: 'number',
              description: 'Distance one grid square represents. Defaults to 5.',
            },
            gridUnits: {
              type: 'string',
              description: 'Unit label for grid distance, e.g. "ft" or "m". Defaults to "ft".',
            },
            width: {
              type: 'number',
              description: 'Scene width in pixels. Defaults to the background image width.',
            },
            height: {
              type: 'number',
              description: 'Scene height in pixels. Defaults to the background image height.',
            },
            padding: {
              type: 'number',
              description:
                'Empty border around the background as a fraction of its size. Defaults to 0.25.',
            },
            backgroundColor: {
              type: 'string',
              description: 'Hex colour shown in the padding area, e.g. "#111111".',
            },
            darkness: {
              type: 'number',
              description: 'Scene darkness from 0 (daylight) to 1 (pitch black). Defaults to 0.',
            },
            globalLight: {
              type: 'boolean',
              description:
                'Illuminate the whole scene without light sources. Defaults to true when ' +
                'darkness is 0, otherwise false.',
            },
            tokenVision: {
              type: 'boolean',
              description: 'Limit what players see to their token vision. Defaults to true.',
            },
            fogExploration: {
              type: 'boolean',
              description: 'Remember explored areas as fog of war. Defaults to true.',
            },
            navigation: {
              type: 'boolean',
              description: 'Show the scene in the navigation bar. Defaults to true.',
            },
            navName: { type: 'string', description: 'Short label for the navigation bar.' },
            playlist: {
              type: 'string',
              description: 'Playlist name or id started when the scene is viewed.',
            },
            initialView: {
              type: 'object',
              description: 'Camera position players start at.',
              properties: {
                x: { type: 'number', description: 'Centre x in pixels.' },
                y: { type: 'number', description: 'Centre y in pixels.' },
                scale: { type: 'number', description: 'Zoom factor, e.g. 0.6.' },
              },
              required: ['x', 'y', 'scale'],
            },
            activate: {
              type: 'boolean',
              description: 'Activate the scene for all players right after creating it.',
            },
            ownership: OWNERSHIP_JSON_SCHEMA,
          },
          required: ['action'],
        },
      },
      {
        name: 'place-tokens',
        description:
          'Place actor tokens on a scene. Actors are resolved by id, name, or compendium UUID ' +
          '("Compendium.world.my-bestiary.Actor.abc123"); a compendium actor is imported into ' +
          'the world once per call and reused if an earlier import is still there.\n' +
          '- "count" above 1 places that many copies in a row, one grid square apart, named ' +
          '"Name 1" ... "Name N".\n' +
          `- ${UNITS_DESCRIPTION} A grid coordinate marks the top-left corner of the token.`,
        inputSchema: {
          type: 'object',
          properties: {
            scene: SCENE_JSON_PROPERTY,
            tokens: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              description: 'Tokens to create.',
              items: {
                type: 'object',
                properties: {
                  actor: {
                    type: 'string',
                    description:
                      'Actor id, name, or compendium UUID such as ' +
                      '"Compendium.world.my-bestiary.Actor.abc123".',
                  },
                  ...pointJsonProperties('the token'),
                  name: {
                    type: 'string',
                    description: 'Token name. Defaults to the actor name.',
                  },
                  hidden: {
                    type: 'boolean',
                    description: 'Create the token hidden from players.',
                  },
                  disposition: {
                    type: 'string',
                    enum: ['hostile', 'neutral', 'friendly', 'secret'],
                    description: 'Token disposition. Defaults to the actor prototype.',
                  },
                  elevation: { type: 'number', description: 'Elevation in scene units.' },
                  count: {
                    type: 'number',
                    description: 'How many copies to place in a row. Defaults to 1.',
                  },
                  scale: { type: 'number', description: 'Token art scale, e.g. 1.2.' },
                },
                required: ['actor', 'x', 'y'],
              },
            },
            importCompendiumTo: {
              type: 'string',
              description:
                'Actor folder that compendium actors are imported into. Defaults to ' +
                '"Imported Actors".',
            },
          },
          required: ['tokens'],
        },
      },
      {
        name: 'manage-scene-lights',
        description:
          'Place and manage ambient light on a scene.\n' +
          '- "create": add lights. "preset" fills colour, radii and animation in one word; any ' +
          'field you pass explicitly wins over the preset.\n' +
          '- "update": change lights by id. "delete": remove them by id. "clear": remove all.\n' +
          '- "list": every light with its position and configuration.\n' +
          '"bright" and "dim" are radii in scene distance units, the same units as the grid.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: SCENE_JSON_PROPERTY,
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete', 'list', 'clear'],
              description: 'Operation to perform.',
            },
            lights: {
              type: 'array',
              minItems: 1,
              description: 'Lights to create or update.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Light id. Required for "update".' },
                  ...pointJsonProperties('the light'),
                  preset: {
                    type: 'string',
                    enum: [...LIGHT_PRESETS],
                    description:
                      'Ready-made look: torch (20/40 orange, torch animation), campfire (15/30 ' +
                      'deep orange, flame), candle (5/10 warm, torch), moonlight (0/60 pale blue, ' +
                      'still, faint), lantern (15/35 warm, still), magical (10/25 pale blue, pulse).',
                  },
                  bright: {
                    type: 'number',
                    description: 'Bright radius in scene units. Defaults to 20.',
                  },
                  dim: {
                    type: 'number',
                    description: 'Dim radius in scene units. Defaults to 40.',
                  },
                  color: { type: 'string', description: 'Light colour as hex, e.g. "#ff9329".' },
                  alpha: {
                    type: 'number',
                    description: 'Colour intensity from 0 to 1. Defaults to 0.5.',
                  },
                  angle: {
                    type: 'number',
                    description: 'Emission cone in degrees. Defaults to 360.',
                  },
                  rotation: {
                    type: 'number',
                    description: 'Direction the cone points, in degrees.',
                  },
                  animation: {
                    type: 'string',
                    enum: [...LIGHT_ANIMATIONS],
                    description: 'Animation type. Defaults to "none".',
                  },
                  animationSpeed: {
                    type: 'number',
                    description: 'Animation speed from 0 to 10. Defaults to 5.',
                  },
                  animationIntensity: {
                    type: 'number',
                    description: 'Animation intensity from 0 to 10. Defaults to 5.',
                  },
                  walls: {
                    type: 'boolean',
                    description: 'Let walls block the light. Defaults to true.',
                  },
                  vision: {
                    type: 'boolean',
                    description: 'Provide vision as well as light. Defaults to false.',
                  },
                  hidden: { type: 'boolean', description: 'Create the light switched off.' },
                  luminosity: {
                    type: 'number',
                    description: 'Luminosity from -1 to 1, negative values darken.',
                  },
                  negative: {
                    type: 'boolean',
                    description: 'Subtract light instead of adding it.',
                  },
                },
              },
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Light ids. Required for "delete".',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage-walls',
        description:
          'Raise walls, doors and windows on a scene.\n' +
          '- "create": walls given as endpoint pairs.\n' +
          '- "box": four walls around a rectangle, the usual way to fence off a map.\n' +
          '- "import-uvtt": walls, doors and lights from a Universal VTT export (Dungeon ' +
          'Alchemist, dd2vtt). Pass "uvttFile" and the wrapper reads the JSON; the embedded map ' +
          'image is ignored, upload the background separately with upload-file.\n' +
          '- "delete" by id, "clear" for all, "list" to read them back.\n' +
          'Each of "move", "sight", "light" and "sound" is a blocking flag: true blocks, false ' +
          'lets it through, so a window is sight true with light false.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: SCENE_JSON_PROPERTY,
            action: {
              type: 'string',
              enum: ['create', 'delete', 'clear', 'list', 'import-uvtt', 'box'],
              description: 'Operation to perform.',
            },
            walls: {
              type: 'array',
              minItems: 1,
              description: 'Walls to create.',
              items: {
                type: 'object',
                properties: {
                  from: pointJsonSchema('the first endpoint'),
                  to: pointJsonSchema('the second endpoint'),
                  door: {
                    type: 'string',
                    enum: ['none', 'door', 'secret'],
                    description: 'Door type. Defaults to "none".',
                  },
                  doorState: {
                    type: 'string',
                    enum: ['closed', 'open', 'locked'],
                    description: 'Initial door state. Defaults to "closed".',
                  },
                  move: { type: 'boolean', description: 'Block movement. Defaults to true.' },
                  sight: { type: 'boolean', description: 'Block sight. Defaults to true.' },
                  light: { type: 'boolean', description: 'Block light. Defaults to true.' },
                  sound: { type: 'boolean', description: 'Block sound. Defaults to true.' },
                  oneWay: {
                    type: 'string',
                    enum: ['none', 'left', 'right'],
                    description:
                      'Restrict the wall to one side, seen from the first endpoint. Defaults to "none".',
                  },
                },
                required: ['from', 'to'],
              },
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Wall ids. Required for "delete".',
            },
            uvtt: {
              type: 'object',
              additionalProperties: true,
              description:
                'Universal VTT data with "resolution", "line_of_sight", "portals" and "lights". ' +
                'Normally filled in by the wrapper from "uvttFile".',
            },
            uvttFile: {
              type: 'string',
              description:
                'Path to a .uvtt / .dd2vtt / .json Universal VTT file, read by the MCP wrapper ' +
                'on the machine running this server. Mutually exclusive with "uvtt".',
            },
            box: {
              type: 'object',
              description: 'For "box": rectangle to fence in.',
              properties: {
                x: { type: 'number', description: 'Left edge.' },
                y: { type: 'number', description: 'Top edge.' },
                width: { type: 'number', description: 'Rectangle width.' },
                height: { type: 'number', description: 'Rectangle height.' },
                units: { type: 'string', enum: ['px', 'grid'], description: UNITS_DESCRIPTION },
              },
              required: ['x', 'y', 'width', 'height'],
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage-tiles',
        description:
          'Place image tiles on a scene: props, blood, rubble, roofs and other art layered over ' +
          'the background.\n' +
          '- "create": needs "image" (a Data directory path) and a position; width and height ' +
          'default to the image size.\n' +
          '- "overhead": true puts the tile above tokens as a roof that fades when a token walks ' +
          'under it.\n' +
          '- "update" by id, "delete" by id, "list" to read them back.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: SCENE_JSON_PROPERTY,
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete', 'list'],
              description: 'Operation to perform.',
            },
            tiles: {
              type: 'array',
              minItems: 1,
              description: 'Tiles to create or update.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Tile id. Required for "update".' },
                  image: {
                    type: 'string',
                    description: 'Image path inside the Data directory. Required for "create".',
                  },
                  ...pointJsonProperties('the tile top-left corner'),
                  width: {
                    type: 'number',
                    description: 'Width in pixels. Defaults to the image width.',
                  },
                  height: {
                    type: 'number',
                    description: 'Height in pixels. Defaults to the image height.',
                  },
                  overhead: {
                    type: 'boolean',
                    description:
                      'Place the tile above tokens as a fading roof (elevation 20, fade occlusion).',
                  },
                  hidden: { type: 'boolean', description: 'Create the tile hidden from players.' },
                  rotation: { type: 'number', description: 'Rotation in degrees.' },
                  alpha: { type: 'number', description: 'Opacity from 0 to 1.' },
                  sort: { type: 'number', description: 'Draw order within the layer.' },
                },
              },
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Tile ids. Required for "delete".',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'manage-scene-notes',
        description:
          'Pin journal entries to places on the map, so clicking the pin opens the room ' +
          'description, the trap, or the read-aloud text.\n' +
          '- "create": needs a journal (name, id or UUID) and a position; "page" pins one page ' +
          'of a multi-page entry.\n' +
          '- "delete" by id, "list" to read them back.\n' +
          'Players only see a pin for an entry they have permission to read, so set that with ' +
          'manage-ownership when a note is meant for them.',
        inputSchema: {
          type: 'object',
          properties: {
            scene: SCENE_JSON_PROPERTY,
            action: {
              type: 'string',
              enum: ['create', 'delete', 'list'],
              description: 'Operation to perform.',
            },
            notes: {
              type: 'array',
              minItems: 1,
              description: 'Notes to create.',
              items: {
                type: 'object',
                properties: {
                  journal: {
                    type: 'string',
                    description: 'Journal entry name, id, or UUID.',
                  },
                  page: { type: 'string', description: 'Page name or id inside the entry.' },
                  ...pointJsonProperties('the pin'),
                  label: {
                    type: 'string',
                    description: 'Text under the pin. Defaults to the journal name.',
                  },
                  icon: {
                    type: 'string',
                    description: 'Icon path. Defaults to "icons/svg/book.svg".',
                  },
                  iconSize: { type: 'number', description: 'Icon size in pixels. Defaults to 40.' },
                  global: {
                    type: 'boolean',
                    description: 'Show the pin even outside token vision.',
                  },
                },
                required: ['journal', 'x', 'y'],
              },
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Note ids. Required for "delete".',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  // ── manage-scene ──────────────────────────────────────────────────────────

  async handleManageScene(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(['create', 'update', 'delete', 'activate', 'list', 'info']),
      scene: z.string().min(1).optional(),
      ...sceneSettingsShape,
    });

    const { action, scene, ...settings } = schema.parse(args);

    if (action === 'create') {
      requireField('manage-scene', action, 'name', settings.name);
      requireField('manage-scene', action, 'background', settings.background);
    }
    if (action !== 'create' && action !== 'list') {
      requireField('manage-scene', action, 'scene', scene);
    }

    this.logger.info('Managing scene', { action, scene: scene ?? settings.name });

    const payload = this.buildScenePayload(action, scene, settings);

    return await this.foundryClient.query(`${BRIDGE}.scene.${action}`, payload);
  }

  /**
   * "create" gets the documented defaults spelled out, "update" carries only what the
   * caller passed so untouched scene fields survive, the rest need just the scene.
   */
  private buildScenePayload(
    action: string,
    scene: string | undefined,
    settings: Record<string, unknown>
  ): Record<string, unknown> {
    if (action === 'list') return {};
    if (action !== 'create' && action !== 'update') return { scene };

    const provided = compact(settings);
    if (action === 'update') return { scene, ...provided };

    const darkness = (provided.darkness as number | undefined) ?? SCENE_CREATE_DEFAULTS.darkness;

    return {
      ...SCENE_CREATE_DEFAULTS,
      globalLight: darkness === 0,
      ...provided,
    };
  }

  // ── place-tokens ──────────────────────────────────────────────────────────

  async handlePlaceTokens(args: any): Promise<any> {
    const schema = z.object({
      scene: z.string().min(1).optional(),
      tokens: z.array(tokenSchema).min(1).max(100),
      importCompendiumTo: z.string().min(1).default('Imported Actors'),
    });

    const { scene, tokens, importCompendiumTo } = schema.parse(args);

    this.logger.info('Placing tokens', { scene, count: tokens.length });

    return await this.foundryClient.query(`${BRIDGE}.scene.placeTokens`, {
      scene,
      tokens: tokens.map(token => compact(token)),
      importCompendiumTo,
    });
  }

  // ── manage-scene-lights ───────────────────────────────────────────────────

  async handleManageSceneLights(args: any): Promise<any> {
    const schema = z.object({
      scene: z.string().min(1).optional(),
      action: z.enum(['create', 'update', 'delete', 'list', 'clear']),
      lights: z.array(lightSchema).min(1).optional(),
      ids: z.array(z.string().min(1)).min(1).optional(),
    });

    const { scene, action, lights, ids } = schema.parse(args);

    if (action === 'create' || action === 'update') {
      requireField('manage-scene-lights', action, 'lights', lights);
    }
    if (action === 'delete') {
      requireField('manage-scene-lights', action, 'ids', ids);
    }

    const prepared = lights?.map((light, index) => this.expandLight(light, action, index));

    this.logger.info('Managing scene lights', { scene, action, count: prepared?.length ?? 0 });

    return await this.foundryClient.query(`${BRIDGE}.scene.lights`, {
      scene,
      action,
      lights: prepared,
      ids,
    });
  }

  /**
   * Turn one light entry into an explicit configuration: defaults first, then the
   * preset, then whatever the caller spelled out.
   */
  private expandLight(
    light: z.infer<typeof lightSchema>,
    action: string,
    index: number
  ): Record<string, unknown> {
    const { preset, ...explicit } = light;
    const provided = compact(explicit);

    if (action === 'update') {
      if (!light.id) {
        throw new Error(`manage-scene-lights action "update" requires "id" on light ${index}`);
      }
      return { ...(preset ? LIGHT_PRESET_VALUES[preset] : {}), ...provided };
    }

    if (light.x === undefined || light.y === undefined) {
      throw new Error(`manage-scene-lights action "create" requires "x" and "y" on light ${index}`);
    }

    return {
      ...LIGHT_DEFAULTS,
      ...(preset ? LIGHT_PRESET_VALUES[preset] : {}),
      ...provided,
    };
  }

  // ── manage-walls ──────────────────────────────────────────────────────────

  async handleManageWalls(args: any): Promise<any> {
    const schema = z.object({
      scene: z.string().min(1).optional(),
      action: z.enum(['create', 'delete', 'clear', 'list', 'import-uvtt', 'box']),
      walls: z.array(wallSchema).min(1).optional(),
      ids: z.array(z.string().min(1)).min(1).optional(),
      uvtt: z.record(z.any()).optional(),
      box: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
          units: unitsSchema.optional(),
        })
        .optional(),
    });

    const { scene, action, walls, ids, uvtt, box } = schema.parse(args);

    if (action === 'create') requireField('manage-walls', action, 'walls', walls);
    if (action === 'delete') requireField('manage-walls', action, 'ids', ids);
    if (action === 'box') requireField('manage-walls', action, 'box', box);
    if (action === 'import-uvtt') {
      if (!uvtt) {
        throw new Error('manage-walls action "import-uvtt" requires "uvtt" or "uvttFile"');
      }
      if (!uvtt.line_of_sight && !uvtt.portals && !uvtt.lights) {
        throw new Error(
          'manage-walls "uvtt" holds no "line_of_sight", "portals" or "lights"; it does not look ' +
            'like a Universal VTT export'
        );
      }
    }

    this.logger.info('Managing walls', { scene, action, count: walls?.length ?? 0 });

    return await this.foundryClient.query(`${BRIDGE}.scene.walls`, {
      scene,
      action,
      walls,
      ids,
      uvtt,
      box,
    });
  }

  // ── manage-tiles ──────────────────────────────────────────────────────────

  async handleManageTiles(args: any): Promise<any> {
    const schema = z.object({
      scene: z.string().min(1).optional(),
      action: z.enum(['create', 'update', 'delete', 'list']),
      tiles: z.array(tileSchema).min(1).optional(),
      ids: z.array(z.string().min(1)).min(1).optional(),
    });

    const { scene, action, tiles, ids } = schema.parse(args);

    if (action === 'create' || action === 'update') {
      requireField('manage-tiles', action, 'tiles', tiles);
    }
    if (action === 'delete') requireField('manage-tiles', action, 'ids', ids);

    tiles?.forEach((tile, index) => {
      if (action === 'create' && (!tile.image || tile.x === undefined || tile.y === undefined)) {
        throw new Error(
          `manage-tiles action "create" requires "image", "x" and "y" on tile ${index}`
        );
      }
      if (action === 'update' && !tile.id) {
        throw new Error(`manage-tiles action "update" requires "id" on tile ${index}`);
      }
    });

    this.logger.info('Managing tiles', { scene, action, count: tiles?.length ?? 0 });

    return await this.foundryClient.query(`${BRIDGE}.scene.tiles`, {
      scene,
      action,
      tiles: tiles?.map(tile => compact(tile)),
      ids,
    });
  }

  // ── manage-scene-notes ────────────────────────────────────────────────────

  async handleManageSceneNotes(args: any): Promise<any> {
    const schema = z.object({
      scene: z.string().min(1).optional(),
      action: z.enum(['create', 'delete', 'list']),
      notes: z.array(noteSchema).min(1).optional(),
      ids: z.array(z.string().min(1)).min(1).optional(),
    });

    const { scene, action, notes, ids } = schema.parse(args);

    if (action === 'create') requireField('manage-scene-notes', action, 'notes', notes);
    if (action === 'delete') requireField('manage-scene-notes', action, 'ids', ids);

    this.logger.info('Managing scene notes', { scene, action, count: notes?.length ?? 0 });

    return await this.foundryClient.query(`${BRIDGE}.scene.notes`, {
      scene,
      action,
      notes: notes?.map(note => compact(note)),
      ids,
    });
  }
}
