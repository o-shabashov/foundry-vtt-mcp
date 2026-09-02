/**
 * Shared building blocks for the session tools.
 *
 * Coordinates, ownership levels and user selectors repeat across scenes,
 * journals, chat and loot piles, so the zod validators and the JSON schema
 * fragments handed to MCP clients live in one place.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface SessionToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/** Query namespace prefix every session tool talks to. */
export const BRIDGE = 'foundry-mcp-bridge';

// ── ownership ─────────────────────────────────────────────────────────────────

/** Ownership levels as words, mirroring CONST.DOCUMENT_OWNERSHIP_LEVELS. */
export const OWNERSHIP_LEVELS = ['none', 'limited', 'observer', 'owner'] as const;

/** Embedded documents such as journal pages may also inherit from their parent. */
export const OWNERSHIP_LEVELS_WITH_INHERIT = ['inherit', ...OWNERSHIP_LEVELS] as const;

export const ownershipLevelSchema = z.enum(OWNERSHIP_LEVELS_WITH_INHERIT);

export const ownershipSchema = z.object({
  default: ownershipLevelSchema.optional(),
  players: ownershipLevelSchema.optional(),
  users: z.record(ownershipLevelSchema).optional(),
});

export const OWNERSHIP_JSON_SCHEMA = {
  type: 'object',
  description:
    'Permissions. "default" applies to everybody without an explicit entry, "users" keys are ' +
    'player names or user ids. "inherit" is only meaningful on embedded documents.',
  properties: {
    default: {
      type: 'string',
      enum: [...OWNERSHIP_LEVELS_WITH_INHERIT],
      description: 'Level granted to every user without an explicit entry.',
    },
    players: {
      type: 'string',
      enum: [...OWNERSHIP_LEVELS_WITH_INHERIT],
      description: 'Level granted to every non-GM user at once.',
    },
    users: {
      type: 'object',
      additionalProperties: { type: 'string', enum: [...OWNERSHIP_LEVELS_WITH_INHERIT] },
      description: 'Per-user levels, keyed by player name or user id.',
    },
  },
};

// ── user selection ────────────────────────────────────────────────────────────

export const usersSchema = z.union([z.enum(['all', 'players']), z.array(z.string().min(1)).min(1)]);

export const USERS_JSON_SCHEMA = {
  description:
    'Target users: "all" or "players" for every non-GM player (active or not), or an array of ' +
    'player names / user ids.',
  oneOf: [
    { type: 'string', enum: ['all', 'players'] },
    { type: 'array', items: { type: 'string' }, minItems: 1 },
  ],
};

// ── coordinates ───────────────────────────────────────────────────────────────

export const unitsSchema = z.enum(['px', 'grid']);

/** Flat coordinate fields, as used by tokens, lights, tiles and notes. */
export const pointFields = {
  x: z.number(),
  y: z.number(),
  units: unitsSchema.optional(),
};

/** Nested coordinate object, as used by wall endpoints. */
export const pointSchema = z.object(pointFields);

export const UNITS_DESCRIPTION =
  'Coordinate units. "grid" (default) counts grid squares from the top-left corner of the scene ' +
  'background and accepts fractions; "px" uses raw canvas pixels, padding included.';

/** JSON schema properties for a flat x/y/units triple. */
export function pointJsonProperties(what: string): Record<string, unknown> {
  return {
    x: { type: 'number', description: `Horizontal position of ${what}.` },
    y: { type: 'number', description: `Vertical position of ${what}.` },
    units: { type: 'string', enum: ['px', 'grid'], description: UNITS_DESCRIPTION },
  };
}

/** JSON schema for a nested coordinate object. */
export function pointJsonSchema(what: string): Record<string, unknown> {
  return {
    type: 'object',
    description: `Coordinates of ${what}.`,
    properties: pointJsonProperties(what),
    required: ['x', 'y'],
  };
}

export const SCENE_JSON_PROPERTY = {
  type: 'string',
  description:
    'Scene id, exact name, or an unambiguous case-insensitive partial name. Defaults to the ' +
    'active scene.',
};

// ── helpers ───────────────────────────────────────────────────────────────────

/** Drop keys whose value is undefined so update payloads stay sparse. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Partial<T>;
}

/** Throw a uniform "action X needs field Y" error. */
export function requireField(tool: string, action: string, field: string, value: unknown): void {
  const missing =
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'string' && value.trim().length === 0);
  if (missing) {
    throw new Error(`${tool} action "${action}" requires "${field}"`);
  }
}
