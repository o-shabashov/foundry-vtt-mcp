/**
 * Music tools.
 *
 * Turn a prompt into a finished Suno track and put it where a session needs it: the
 * Foundry Data directory, a playlist, and a copy in the session folder on the game
 * master's machine.
 *
 * Suno has no official API, so generation goes through a proxy provider chosen by
 * configuration (see providers/). Delivery reuses the session tools: the same
 * foundry-mcp-bridge.files.upload query as upload-file and the same playlist queries
 * as manage-playlists, so the Foundry module needs no new handler.
 *
 * MusicTools owns the provider handling and dispatches by tool name, the way
 * SessionTools does, so backend.ts constructs one object and delegates to it.
 */

import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { SessionFileTools, MAX_UPLOAD_MB } from '../session/files.js';
import { SessionPlaylistTools } from '../session/playlist.js';
import {
  DEFAULT_MODEL,
  DURATION_MODEL,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  MUSIC_MODELS,
  MUSIC_PROVIDERS,
  MusicConfig,
  MusicProvider,
  MusicTask,
  VOCAL_GENDERS,
  errorMessage,
  sleep,
} from './common.js';
import { createMusicProvider } from './providers/index.js';

export { createMusicProvider } from './providers/index.js';
export type { MusicConfig, MusicProvider, MusicTask, MusicTrack } from './common.js';

/** Every tool name this class answers to, in the order the definitions come out. */
export const MUSIC_TOOL_NAMES = ['generate-music', 'music-status', 'music-credits'] as const;

export type MusicToolName = (typeof MUSIC_TOOL_NAMES)[number];

export interface MusicToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
  config: MusicConfig;
}

const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Audio is always mp3, whatever the provider names the file behind the URL. */
const TRACK_MIME_TYPE = 'audio/mpeg';

/** Arguments describing the music itself. */
const requestFields = {
  prompt: z.string().min(1),
  style: z.string().min(1).max(1000).optional(),
  title: z.string().min(1).max(80).optional(),
  instrumental: z.boolean().optional(),
  customMode: z.boolean().optional(),
  model: z.enum(MUSIC_MODELS).optional(),
  negativeTags: z.string().min(1).optional(),
  vocalGender: z.enum(VOCAL_GENDERS).optional(),
  styleWeight: z.number().min(0).max(1).optional(),
  weirdness: z.number().min(0).max(1).optional(),
  durationSec: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC).optional(),
};

/** Arguments describing where a finished track goes, shared by both track tools. */
const deliveryFields = {
  targetDir: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  playlist: z.string().min(1).optional(),
  outDir: z.string().min(1).optional(),
  provider: z.enum(MUSIC_PROVIDERS).optional(),
};

const DELIVERY_JSON_PROPERTIES = {
  targetDir: {
    type: 'string',
    description:
      'Folder inside the Foundry Data directory, e.g. "worlds/my-world/sessions/Session 15". ' +
      'When given, finished tracks are downloaded by the backend and uploaded there.',
  },
  fileName: {
    type: 'string',
    description:
      'Base name without extension. The first track is stored as "<fileName>.mp3", the second ' +
      'as "<fileName> (2).mp3". Defaults to "title", or "Suno <taskId>" without one.',
  },
  playlist: {
    type: 'string',
    description:
      'Foundry playlist name. An existing playlist gets the tracks appended, a missing one is ' +
      'created in "sequential" mode. Needs "targetDir", since a playlist points at stored files.',
  },
  outDir: {
    type: 'string',
    description:
      'Folder on the machine running the MCP client, for a local copy of the mp3 files. Handled ' +
      'by the wrapper, which then fills in "localPath" on every track.',
  },
  provider: {
    type: 'string',
    enum: [...MUSIC_PROVIDERS],
    description: 'Override the configured proxy provider for this one call.',
  },
};

/**
 * Strip what a file name cannot hold, so a title can be used as one. Kept in step
 * with the same helper in tool-files.ts, which names the local copies.
 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\p{Cc}/gu, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'Suno';
}

/** Where a finished task has to be filed, shared by generate-music and music-status. */
interface DeliveryOptions {
  targetDir?: string | undefined;
  fileName?: string | undefined;
  playlist?: string | undefined;
  /** Fallback base name, the request title of generate-music. */
  defaultName?: string | undefined;
}

/** Name of the nth track of a task: the base name, then " (2)", " (3)" and so on. */
function trackFileName(base: string, index: number): string {
  return index === 0 ? base : `${base} (${index + 1})`;
}

export class MusicTools {
  private logger: Logger;
  private config: MusicConfig;
  private files: SessionFileTools;
  private playlists: SessionPlaylistTools;

  private handlers: Map<string, (args: any) => Promise<any>>;

  constructor({ foundryClient, logger, config }: MusicToolsOptions) {
    this.logger = logger.child({ component: 'MusicTools' });
    this.config = config;
    this.files = new SessionFileTools({ foundryClient, logger });
    this.playlists = new SessionPlaylistTools({ foundryClient, logger });

    this.handlers = new Map<string, (args: any) => Promise<any>>([
      ['generate-music', args => this.handleGenerateMusic(args)],
      ['music-status', args => this.handleMusicStatus(args)],
      ['music-credits', args => this.handleMusicCredits(args)],
    ]);
  }

  getToolDefinitions() {
    return [
      {
        name: 'generate-music',
        description:
          'Generate a music track with Suno through the configured proxy provider and, when ' +
          'asked, put it straight into Foundry.\n' +
          '- "prompt" describes the music. With "customMode" the prompt is sung as lyrics ' +
          'instead, and "style" carries the description.\n' +
          '- Instrumental by default, which is what session ambience and battle music want. ' +
          'Set "instrumental": false for a song with vocals.\n' +
          '- Suno answers with two takes of every prompt, so there is a choice at the table.\n' +
          '- "targetDir" uploads them into the Foundry Data directory, "playlist" files them ' +
          'into a playlist, "outDir" keeps a local copy next to the session notes.\n' +
          '- Waits for the tracks by default; generation takes a couple of minutes. With ' +
          '"wait": false the call returns a taskId to hand to music-status later.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'What the music should be. In custom mode this is the lyrics that get sung, so ' +
                'the description belongs in "style" then.',
            },
            style: {
              type: 'string',
              description:
                'Genre, mood, instruments and tempo, e.g. "dark ambient, low strings, 60 bpm". ' +
                'Up to 1000 characters. Setting it turns on custom mode.',
            },
            title: {
              type: 'string',
              description: 'Track title, up to 80 characters. Setting it turns on custom mode.',
            },
            instrumental: {
              type: 'boolean',
              description: 'Keep the track free of vocals. Defaults to true.',
            },
            customMode: {
              type: 'boolean',
              description:
                'Treat "prompt" as lyrics and take the description from "style". Defaults to ' +
                'true when "style" or "title" is given, false otherwise.',
            },
            model: {
              type: 'string',
              enum: [...MUSIC_MODELS],
              description: `Suno model version. Defaults to ${DEFAULT_MODEL}.`,
            },
            negativeTags: {
              type: 'string',
              description: 'Styles to keep out, e.g. "pop, upbeat, brass".',
            },
            vocalGender: {
              type: 'string',
              enum: [...VOCAL_GENDERS],
              description: 'Voice for a track with vocals: "m" or "f".',
            },
            styleWeight: {
              type: 'number',
              description: 'How closely to follow "style", from 0 to 1.',
            },
            weirdness: {
              type: 'number',
              description: 'How experimental the result may get, from 0 to 1.',
            },
            durationSec: {
              type: 'number',
              description:
                `Track length in seconds, ${MIN_DURATION_SEC} to ${MAX_DURATION_SEC}. Only model ` +
                `${DURATION_MODEL} in custom mode accepts one; anywhere else it is dropped and ` +
                'the answer says so in "warnings".',
            },
            wait: {
              type: 'boolean',
              description:
                'Poll until the tracks are ready. Defaults to true. False returns a taskId ' +
                'immediately, for music-status to pick up.',
            },
            ...DELIVERY_JSON_PROPERTIES,
          },
          required: ['prompt'],
        },
      },
      {
        name: 'music-status',
        description:
          'Check a music generation started earlier and finish delivering it.\n' +
          '- Pass the taskId from generate-music. The answer has the same shape.\n' +
          '- "targetDir", "playlist" and "outDir" work exactly as in generate-music, so a track ' +
          'started with "wait": false gets filed away here. Repeating the call is safe: uploads ' +
          'overwrite and a track already in the playlist is left alone.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'Task id returned by generate-music.',
            },
            ...DELIVERY_JSON_PROPERTIES,
          },
          required: ['taskId'],
        },
      },
      {
        name: 'music-credits',
        description:
          'Remaining credit balance of the music provider, worth a look before a long batch of ' +
          'generations. Answers with "credits": null when the provider exposes no balance.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: DELIVERY_JSON_PROPERTIES.provider,
          },
        },
      },
    ];
  }

  /** True when this class answers to the tool name, used by the backend dispatcher. */
  canHandle(name: string): boolean {
    return this.handlers.has(name);
  }

  async handle(name: string, args: any): Promise<any> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Unknown music tool: ${name}`);
    }
    return await handler(args);
  }

  // -- generate-music --------------------------------------------------------

  async handleGenerateMusic(args: any): Promise<any> {
    const schema = z.object({
      ...requestFields,
      ...deliveryFields,
      wait: z.boolean().default(true),
    });

    const parsed = schema.parse(args);
    const warnings: string[] = [];

    const customMode =
      parsed.customMode ?? (parsed.style !== undefined || parsed.title !== undefined);
    const model = parsed.model ?? DEFAULT_MODEL;

    let durationSec = parsed.durationSec;
    if (durationSec !== undefined && (model !== DURATION_MODEL || !customMode)) {
      warnings.push(
        `"durationSec" needs model ${DURATION_MODEL} in custom mode, so it was dropped for ` +
          `${model} in ${customMode ? 'custom' : 'description'} mode.`
      );
      durationSec = undefined;
    }

    const provider = createMusicProvider(this.config, this.logger, parsed.provider);

    this.logger.info('Generating music', {
      provider: provider.name,
      model,
      customMode,
      instrumental: parsed.instrumental ?? true,
      wait: parsed.wait,
    });

    const submitted = await provider.generate({
      prompt: parsed.prompt,
      style: parsed.style,
      title: parsed.title,
      instrumental: parsed.instrumental ?? true,
      customMode,
      model,
      negativeTags: parsed.negativeTags,
      vocalGender: parsed.vocalGender,
      styleWeight: parsed.styleWeight,
      weirdness: parsed.weirdness,
      durationSec,
    });
    warnings.push(...(submitted.warnings ?? []));

    const task: MusicTask = parsed.wait
      ? await this.poll(provider, submitted.taskId)
      : { provider: provider.name, taskId: submitted.taskId, status: 'pending', tracks: [] };

    return await this.finish(task, { ...parsed, defaultName: parsed.title }, warnings);
  }

  // -- music-status ----------------------------------------------------------

  async handleMusicStatus(args: any): Promise<any> {
    const schema = z.object({ taskId: z.string().min(1), ...deliveryFields });
    const parsed = schema.parse(args);

    const provider = createMusicProvider(this.config, this.logger, parsed.provider);
    const task = await provider.status(parsed.taskId);

    this.logger.info('Music task status', {
      provider: provider.name,
      taskId: parsed.taskId,
      status: task.status,
      tracks: task.tracks.length,
    });

    return await this.finish(task, parsed, []);
  }

  // -- music-credits ---------------------------------------------------------

  async handleMusicCredits(args: any): Promise<any> {
    const schema = z.object({ provider: z.enum(MUSIC_PROVIDERS).optional() });
    const parsed = schema.parse(args ?? {});

    const provider = createMusicProvider(this.config, this.logger, parsed.provider);
    const credits = provider.credits ? await provider.credits() : null;

    return { provider: provider.name, credits };
  }

  // -- generation ------------------------------------------------------------

  /** Ask the provider for the task until it settles, or until the timeout runs out. */
  private async poll(provider: MusicProvider, taskId: string): Promise<MusicTask> {
    const deadline = Date.now() + this.config.timeoutMs;

    let task = await provider.status(taskId);
    while (task.status !== 'complete' && task.status !== 'failed') {
      if (Date.now() >= deadline) {
        this.logger.warn('Music task still running when the timeout ran out', {
          provider: provider.name,
          taskId,
          timeoutMs: this.config.timeoutMs,
        });
        return { ...task, status: 'pending' };
      }
      await sleep(this.config.pollIntervalMs);
      task = await provider.status(taskId);
    }

    return task;
  }

  // -- delivery --------------------------------------------------------------

  /**
   * Shape the answer both track tools return: a failed task throws so the client sees
   * an error, a finished one is uploaded and filed into a playlist first. A task that
   * is still running comes back as "pending" with the taskId to poll.
   */
  private async finish(
    task: MusicTask,
    options: DeliveryOptions,
    warnings: string[]
  ): Promise<any> {
    if (task.status === 'failed') {
      throw new Error(task.error ?? `${task.provider} could not generate this track`);
    }

    await this.deliver(task, options, warnings);

    const answer: Record<string, unknown> = {
      provider: task.provider,
      taskId: task.taskId,
      status: task.status,
      tracks: task.tracks,
      warnings,
    };

    if (task.status !== 'complete') {
      answer.hint =
        `Generation is still running. Call music-status with taskId "${task.taskId}" in a minute ` +
        'to collect the tracks.';
    }

    return answer;
  }

  /** Download every finished track, upload it into Foundry and add it to a playlist. */
  private async deliver(
    task: MusicTask,
    options: DeliveryOptions,
    warnings: string[]
  ): Promise<void> {
    const ready = task.tracks.filter(track => track.audioUrl);
    if (ready.length === 0) return;

    if (!options.targetDir) {
      if (options.playlist) {
        warnings.push(
          'A playlist points at files stored in Foundry, so "playlist" was skipped without "targetDir".'
        );
      }
      return;
    }

    const base = safeFileName(options.fileName ?? options.defaultName ?? `Suno ${task.taskId}`);

    for (const [index, track] of task.tracks.entries()) {
      if (!track.audioUrl) continue;

      const fileName = `${trackFileName(base, index)}.mp3`;
      try {
        const bytes = await downloadTrack(track.audioUrl);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          warnings.push(
            `"${fileName}" is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, over the ` +
              `${MAX_UPLOAD_MB} MB upload limit. It stays at ${track.audioUrl}.`
          );
          continue;
        }

        const stored = await this.files.handleUploadFile({
          targetDir: options.targetDir,
          fileName,
          fileData: bytes.toString('base64'),
          mimeType: TRACK_MIME_TYPE,
          overwrite: true,
        });

        track.path = stored?.path ?? `${options.targetDir}/${fileName}`;
      } catch (error) {
        warnings.push(`Cannot store "${fileName}": ${errorMessage(error)}`);
      }
    }

    await this.fileIntoPlaylist(task, options.playlist, warnings);
  }

  /**
   * Add the stored tracks to a playlist, creating it when it is missing. Running the
   * same task twice changes nothing: a track already listed by path is skipped.
   */
  private async fileIntoPlaylist(
    task: MusicTask,
    playlist: string | undefined,
    warnings: string[]
  ): Promise<void> {
    if (!playlist) return;

    const stored = task.tracks.filter(track => track.path);
    if (stored.length === 0) return;

    try {
      const existing = await this.findPlaylist(playlist);

      if (existing) {
        const present = new Set(
          (existing.tracks ?? []).map((entry: any) => entry?.path).filter(Boolean)
        );
        const missing = stored.filter(track => !present.has(track.path));

        if (missing.length > 0) {
          await this.playlists.handleManagePlaylists({
            action: 'add-tracks',
            playlist: existing.id ?? playlist,
            tracks: missing.map(track => ({ path: track.path })),
          });
        }
      } else {
        await this.playlists.handleManagePlaylists({
          action: 'create',
          name: playlist,
          mode: 'sequential',
          tracks: stored.map(track => ({ path: track.path })),
        });
      }

      for (const track of stored) track.playlist = playlist;
    } catch (error) {
      warnings.push(`Cannot put the tracks into playlist "${playlist}": ${errorMessage(error)}`);
    }
  }

  /** The playlist with that name, or null when Foundry has none. */
  private async findPlaylist(name: string): Promise<any> {
    try {
      const found = await this.playlists.handleManagePlaylists({ action: 'list', playlist: name });
      const entries = Array.isArray(found) ? found : found ? [found] : [];
      return entries[0] ?? null;
    } catch {
      // A name Foundry cannot resolve means the playlist has to be created.
      return null;
    }
  }
}

/** Fetch one mp3 into memory; the bytes go on to base64 for the bridge. */
async function downloadTrack(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the provider CDN answered HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
