/**
 * Session playlist tools.
 *
 * Build the soundtrack of a session: create playlists from uploaded audio, adjust
 * volume and fades, start and stop the whole list or a single track. Every handler
 * forwards to a `foundry-mcp-bridge.playlist.*` query.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { BRIDGE, SessionToolsOptions, compact, requireField } from './common.js';

export const PLAYLIST_MODES = ['sequential', 'shuffle', 'simultaneous', 'soundboard'] as const;

const PLAYLIST_ACTIONS = [
  'list',
  'create',
  'update',
  'delete',
  'add-tracks',
  'remove-tracks',
  'play',
  'stop',
  'play-track',
  'stop-track',
  'set-volume',
] as const;

/** Query method for each action, camelCase of the hyphenated name. */
const PLAYLIST_METHODS: Record<(typeof PLAYLIST_ACTIONS)[number], string> = {
  list: 'list',
  create: 'create',
  update: 'update',
  delete: 'delete',
  'add-tracks': 'addTracks',
  'remove-tracks': 'removeTracks',
  play: 'play',
  stop: 'stop',
  'play-track': 'playTrack',
  'stop-track': 'stopTrack',
  'set-volume': 'setVolume',
};

/** Default crossfade in milliseconds, applied when a playlist is created. */
const DEFAULT_FADE_MS = 2000;

const trackSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  volume: z.number().min(0).max(1).default(0.6),
  repeat: z.boolean().default(false),
  fade: z.number().min(0).optional(),
});

/** Fall back to the file name without its extension, the way Foundry names imports. */
function deriveTrackName(trackPath: string): string {
  const lastSegment = trackPath.split(/[\\/]/).pop() ?? trackPath;
  let name = lastSegment;
  try {
    name = decodeURIComponent(lastSegment);
  } catch {
    // A path that is not valid percent-encoding is used as it is.
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export class SessionPlaylistTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: SessionToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'SessionPlaylistTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-playlists',
        description:
          'Create and drive playlists: session soundtrack, ambience loops, one-shot stingers.\n' +
          '- "create": a playlist and, with "tracks", its sounds in one go. Upload the audio ' +
          'with upload-file first and pass the returned paths.\n' +
          '- "add-tracks" / "remove-tracks": change the sounds of an existing playlist.\n' +
          '- "play" / "stop": the whole playlist. "play-track" / "stop-track": one sound.\n' +
          '- "set-volume": one track with "track", or every track of the playlist without it.\n' +
          '- "list": playlists with their tracks, volumes and what is currently playing.\n' +
          'Modes: "sequential" plays in order, "shuffle" at random, "simultaneous" all at once ' +
          'for layered ambience, "soundboard" plays nothing on its own and waits for clicks. ' +
          'Set "repeat" on ambience tracks so they loop.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...PLAYLIST_ACTIONS],
              description: 'Operation to perform.',
            },
            playlist: {
              type: 'string',
              description:
                'Playlist name or id. Required for everything except "list" and "create".',
            },
            name: {
              type: 'string',
              description: 'Playlist name. Required for "create", renames on "update".',
            },
            folder: {
              type: 'string',
              description: 'Playlist folder name, created when missing.',
            },
            mode: {
              type: 'string',
              enum: [...PLAYLIST_MODES],
              description: 'Playback mode. Defaults to "sequential" on create.',
            },
            fade: {
              type: 'number',
              description: `Crossfade in milliseconds. Defaults to ${DEFAULT_FADE_MS} on create.`,
            },
            description: { type: 'string', description: 'Free-form playlist description.' },
            tracks: {
              type: 'array',
              minItems: 1,
              description: 'Sounds for "create" and "add-tracks".',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description:
                      'Audio path inside the Data directory, e.g. ' +
                      '"worlds/my-world/music/battle.mp3".',
                  },
                  name: {
                    type: 'string',
                    description: 'Track name. Defaults to the file name without its extension.',
                  },
                  volume: {
                    type: 'number',
                    description: 'Track volume from 0 to 1. Defaults to 0.6.',
                  },
                  repeat: {
                    type: 'boolean',
                    description: 'Loop the track. Defaults to false; set true for ambience.',
                  },
                  fade: { type: 'number', description: 'Per-track fade in milliseconds.' },
                },
                required: ['path'],
              },
            },
            trackNames: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Track names or ids to drop. Required for "remove-tracks".',
            },
            track: {
              type: 'string',
              description:
                'One track by name or id. Required for "play-track" and "stop-track", optional ' +
                'for "set-volume".',
            },
            volume: {
              type: 'number',
              description: 'Volume from 0 to 1. Required for "set-volume".',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleManagePlaylists(args: any): Promise<any> {
    const schema = z.object({
      action: z.enum(PLAYLIST_ACTIONS),
      playlist: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      folder: z.string().min(1).optional(),
      mode: z.enum(PLAYLIST_MODES).optional(),
      fade: z.number().min(0).optional(),
      description: z.string().optional(),
      tracks: z.array(trackSchema).min(1).optional(),
      trackNames: z.array(z.string().min(1)).min(1).optional(),
      track: z.string().min(1).optional(),
      volume: z.number().min(0).max(1).optional(),
    });

    const parsed = schema.parse(args);
    const { action } = parsed;

    if (action === 'create') {
      requireField('manage-playlists', action, 'name', parsed.name);
    } else if (action !== 'list') {
      requireField('manage-playlists', action, 'playlist', parsed.playlist);
    }
    if (action === 'add-tracks') {
      requireField('manage-playlists', action, 'tracks', parsed.tracks);
    }
    if (action === 'remove-tracks') {
      requireField('manage-playlists', action, 'trackNames', parsed.trackNames);
    }
    if (action === 'play-track' || action === 'stop-track') {
      requireField('manage-playlists', action, 'track', parsed.track);
    }
    if (action === 'set-volume' && parsed.volume === undefined) {
      throw new Error('manage-playlists action "set-volume" requires "volume"');
    }

    const tracks = parsed.tracks?.map(track => ({
      ...compact(track),
      name: track.name ?? deriveTrackName(track.path),
    }));

    const payload = compact({
      ...parsed,
      action: undefined,
      tracks,
      fade: action === 'create' ? (parsed.fade ?? DEFAULT_FADE_MS) : parsed.fade,
    });

    this.logger.info('Managing playlists', {
      action,
      playlist: parsed.playlist ?? parsed.name,
      tracks: tracks?.length ?? 0,
    });

    return await this.foundryClient.query(
      `${BRIDGE}.playlist.${PLAYLIST_METHODS[action]}`,
      payload
    );
  }
}
