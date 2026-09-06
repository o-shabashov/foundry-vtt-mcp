/**
 * Music tool tests.
 *
 * The providers are HTTP services, so fetch is stubbed and the adapters are checked
 * against the request and answer shapes their documentation shows. On top of that sit
 * the tools themselves: the defaults they fill in, the timeout that reports "pending"
 * rather than an error, and the upload plus playlist step that files a finished track
 * away in Foundry.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MusicTools, MUSIC_TOOL_NAMES } from './index.js';
import { createMusicProvider } from './providers/index.js';
import { ApiframeProvider } from './providers/apiframe.js';
import { SunoApiProvider } from './providers/sunoapi.js';
import { MusicConfig, MusicRequest } from './common.js';

const logger: any = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

function makeConfig(overrides: Partial<MusicConfig> = {}): MusicConfig {
  return {
    provider: 'apiframe',
    apiframe: { apiKey: 'afk_test', baseUrl: 'https://api.apiframe.ai' },
    sunoapi: { apiKey: 'suno_test', baseUrl: 'https://api.sunoapi.org' },
    callbackUrl: 'https://example.invalid/suno-callback',
    pollIntervalMs: 1,
    timeoutMs: 40,
    ...overrides,
  };
}

function request(overrides: Partial<MusicRequest> = {}): MusicRequest {
  return {
    prompt: 'dark ambient, low strings',
    instrumental: true,
    customMode: false,
    model: 'V5',
    ...overrides,
  };
}

/** A fetch answer carrying JSON, the way both providers speak. */
function jsonAnswer(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** A fetch answer carrying an mp3, the way a provider CDN does. */
function fileAnswer(bytes: Buffer, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** Install a fetch stub answering from a queue, and return the calls it recorded. */
function stubFetch(answers: any[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('fetch stub ran out of answers');
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Body of the nth fetch call, parsed back from JSON. */
function bodyOf(fetchMock: any, index = 0): any {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
}

function headersOf(fetchMock: any, index = 0): Record<string, string> {
  return fetchMock.mock.calls[index][1].headers;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// -- apiframe -----------------------------------------------------------------

describe('ApiframeProvider', () => {
  function provider() {
    return new ApiframeProvider({
      apiKey: 'afk_test',
      baseUrl: 'https://api.apiframe.ai',
      callbackUrl: 'https://example.invalid/suno-callback',
      logger,
    });
  }

  it('submits the Suno knobs inside sunoParams and reads back the job id', async () => {
    const fetchMock = stubFetch([jsonAnswer({ jobId: 'job-1', status: 'QUEUED' })]);

    const submitted = await provider().generate(
      request({
        customMode: true,
        style: 'dark ambient',
        title: 'Ozhog',
        negativeTags: 'pop',
        vocalGender: 'f',
        styleWeight: 0.6,
        weirdness: 0.2,
      })
    );

    expect(submitted.taskId).toBe('job-1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.apiframe.ai/v2/music/generate');
    expect(headersOf(fetchMock)['X-API-Key']).toBe('afk_test');
    expect(bodyOf(fetchMock)).toEqual({
      model: 'suno',
      prompt: 'dark ambient, low strings',
      sunoParams: {
        custom_mode: true,
        instrumental: true,
        model_version: 'V5',
        title: 'Ozhog',
        style: 'dark ambient',
        negative_tags: 'pop',
        vocal_gender: 'f',
        style_weight: 0.6,
        weirdness_constraint: 0.2,
      },
    });
  });

  it('warns that apiframe has no track length parameter', async () => {
    stubFetch([jsonAnswer({ jobId: 'job-1' })]);

    const submitted = await provider().generate(request({ durationSec: 120 }));

    expect(submitted.warnings?.join(' ')).toContain('durationSec');
  });

  it('reports a queued job as pending and a completed one with its tracks', async () => {
    stubFetch([
      jsonAnswer({ id: 'job-1', status: 'QUEUED', result: null }),
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [
            {
              id: 't1',
              audioUrl: 'https://cdn2.apiframe.ai/audio/t1.mp3',
              imageUrl: 'https://cdn2.apiframe.ai/audio/t1.jpeg',
              title: 'Neon Skyline',
              tags: 'synthwave',
              duration: 184.2,
            },
            { id: 't2', audioUrl: '', title: 'Neon Skyline', duration: null },
          ],
        },
      }),
    ]);

    const queued = await provider().status('job-1');
    expect(queued.status).toBe('pending');
    expect(queued.tracks).toEqual([]);

    const done = await provider().status('job-1');
    expect(done.status).toBe('complete');
    expect(done.tracks).toEqual([
      {
        id: 't1',
        title: 'Neon Skyline',
        durationSec: 184.2,
        audioUrl: 'https://cdn2.apiframe.ai/audio/t1.mp3',
        imageUrl: 'https://cdn2.apiframe.ai/audio/t1.jpeg',
        tags: 'synthwave',
      },
    ]);
  });

  it('carries the provider reason of a failed job', async () => {
    stubFetch([jsonAnswer({ id: 'job-1', status: 'FAILED', error: 'content policy violation' })]);

    const task = await provider().status('job-1');

    expect(task.status).toBe('failed');
    expect(task.error).toBe('content policy violation');
  });

  it('says an empty balance in plain words on HTTP 402', async () => {
    stubFetch([jsonAnswer({ error: 'Insufficient credits' }, 402)]);

    await expect(provider().generate(request())).rejects.toThrow(/no credits left/i);
  });

  it('names the environment variable when the key is refused', async () => {
    stubFetch([jsonAnswer({ error: 'Unauthorized' }, 401)]);

    await expect(provider().status('job-1')).rejects.toThrow(/APIFRAME_API_KEY/);
  });

  it('reads the credit balance off the team of the account', async () => {
    const fetchMock = stubFetch([
      jsonAnswer({ user: { id: 'u1' }, team: { credits: 4500 }, apiKey: { id: 'k1' } }),
    ]);

    await expect(provider().credits()).resolves.toBe(4500);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.apiframe.ai/v2/me');
  });
});

// -- sunoapi ------------------------------------------------------------------

describe('SunoApiProvider', () => {
  function provider() {
    return new SunoApiProvider({
      apiKey: 'suno_test',
      baseUrl: 'https://api.sunoapi.org',
      callbackUrl: 'https://example.invalid/suno-callback',
      logger,
    });
  }

  it('sends a flat camelCase body with the callback URL and Bearer auth', async () => {
    const fetchMock = stubFetch([
      jsonAnswer({ code: 200, msg: 'success', data: { taskId: 'task-1' } }),
    ]);

    const submitted = await provider().generate(
      request({
        customMode: true,
        style: 'Classical',
        title: 'Rain',
        model: 'V5_5',
        durationSec: 120,
      })
    );

    expect(submitted.taskId).toBe('task-1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sunoapi.org/api/v1/generate');
    expect(headersOf(fetchMock).Authorization).toBe('Bearer suno_test');
    expect(bodyOf(fetchMock)).toEqual({
      customMode: true,
      instrumental: true,
      prompt: 'dark ambient, low strings',
      style: 'Classical',
      title: 'Rain',
      model: 'V5_5',
      duration: 120,
      callBackUrl: 'https://example.invalid/suno-callback',
    });
  });

  it('turns the body code into a readable error, not an empty answer', async () => {
    stubFetch([jsonAnswer({ code: 429, msg: 'Insufficient credits', data: null })]);

    await expect(provider().generate(request())).rejects.toThrow(/no credits left/i);
  });

  it('maps the four task states onto pending, partial and complete', async () => {
    const track = {
      id: 'a1',
      audio_url: 'https://cdn.example.com/a1.mp3',
      image_url: 'https://cdn.example.com/a1.jpeg',
      title: 'Iron Man',
      tags: 'electrifying, rock',
      duration: 198.44,
    };

    stubFetch([
      jsonAnswer({ code: 200, msg: 'ok', data: { taskId: 'task-1', status: 'PENDING' } }),
      jsonAnswer({
        code: 200,
        msg: 'ok',
        data: { taskId: 'task-1', status: 'FIRST_SUCCESS', response: { sunoData: [track] } },
      }),
      jsonAnswer({
        code: 200,
        msg: 'ok',
        data: { taskId: 'task-1', status: 'SUCCESS', response: { sunoData: [track] } },
      }),
    ]);

    expect((await provider().status('task-1')).status).toBe('pending');

    const partial = await provider().status('task-1');
    expect(partial.status).toBe('partial');

    const done = await provider().status('task-1');
    expect(done.status).toBe('complete');
    expect(done.tracks).toEqual([
      {
        id: 'a1',
        title: 'Iron Man',
        durationSec: 198.44,
        audioUrl: 'https://cdn.example.com/a1.mp3',
        imageUrl: 'https://cdn.example.com/a1.jpeg',
        tags: 'electrifying, rock',
      },
    ]);
  });

  it('reports a failed task with the message the service gave', async () => {
    stubFetch([
      jsonAnswer({
        code: 200,
        msg: 'ok',
        data: {
          taskId: 'task-1',
          status: 'GENERATE_AUDIO_FAILED',
          errorMessage: 'audio engine said no',
        },
      }),
    ]);

    const task = await provider().status('task-1');

    expect(task.status).toBe('failed');
    expect(task.error).toBe('audio engine said no');
  });

  it('reads the credit balance out of the plain number in data', async () => {
    const fetchMock = stubFetch([jsonAnswer({ code: 200, msg: 'success', data: 100 })]);

    await expect(provider().credits()).resolves.toBe(100);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sunoapi.org/api/v1/generate/credit');
  });
});

// -- provider factory ---------------------------------------------------------

describe('createMusicProvider', () => {
  it('names the environment variable of a provider without a key', () => {
    const config = makeConfig({ apiframe: { apiKey: '', baseUrl: 'https://api.apiframe.ai' } });

    expect(() => createMusicProvider(config, logger)).toThrow(/APIFRAME_API_KEY/);
  });

  it('takes the provider from the configuration and lets one call override it', () => {
    const config = makeConfig();

    expect(createMusicProvider(config, logger).name).toBe('apiframe');
    expect(createMusicProvider(config, logger, 'sunoapi').name).toBe('sunoapi');
  });
});

// -- tools --------------------------------------------------------------------

/** MusicTools with a bridge that records every query and answers like the module. */
function makeTools(config: MusicConfig = makeConfig()) {
  const query = vi.fn(async (method: string, payload: any) => {
    if (method.endsWith('files.upload')) {
      return { path: `${payload.targetDir}/${payload.fileName}`, size: 4, existed: false };
    }
    if (method.endsWith('playlist.list')) {
      throw new Error(`Playlist "${payload.playlist}" not found`);
    }
    if (method.endsWith('playlist.create')) {
      return { id: 'playlist-1', name: payload.name, tracks: [] };
    }
    return { ok: true };
  });
  const foundryClient: any = { query };

  return { tools: new MusicTools({ foundryClient, logger, config }), query };
}

describe('MusicTools definitions', () => {
  it('advertises the three tools with object input schemas', () => {
    const { tools } = makeTools();
    const defs = tools.getToolDefinitions();

    expect(defs.map(d => d.name)).toEqual([...MUSIC_TOOL_NAMES]);
    for (const def of defs) {
      expect(def.inputSchema.type).toBe('object');
      expect(def.description.length).toBeGreaterThan(50);
    }
  });

  it('answers to exactly the advertised names', () => {
    const { tools } = makeTools();

    for (const name of MUSIC_TOOL_NAMES) expect(tools.canHandle(name)).toBe(true);
    expect(tools.canHandle('upload-file')).toBe(false);
  });

  it('advertises outDir, which only the wrapper acts on', () => {
    const { tools } = makeTools();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d]));

    expect(byName['generate-music'].inputSchema.properties.outDir).toBeDefined();
    expect(byName['music-status'].inputSchema.properties.outDir).toBeDefined();
  });
});

describe('generate-music', () => {
  it('fills in the defaults: instrumental, description mode and the V5 model', async () => {
    const fetchMock = stubFetch([jsonAnswer({ jobId: 'job-1' })]);
    const { tools } = makeTools();

    const answer = await tools.handle('generate-music', { prompt: 'rain on stone', wait: false });

    expect(bodyOf(fetchMock).sunoParams).toEqual({
      custom_mode: false,
      instrumental: true,
      model_version: 'V5',
    });
    expect(answer.status).toBe('pending');
    expect(answer.taskId).toBe('job-1');
    expect(answer.hint).toContain('music-status');
  });

  it('turns on custom mode as soon as a style or a title is given', async () => {
    const fetchMock = stubFetch([jsonAnswer({ jobId: 'job-1' })]);
    const { tools } = makeTools();

    await tools.handle('generate-music', { prompt: 'rain', style: 'dark ambient', wait: false });

    expect(bodyOf(fetchMock).sunoParams.custom_mode).toBe(true);
  });

  it('drops a track length the model cannot use and says so in warnings', async () => {
    const fetchMock = stubFetch([jsonAnswer({ code: 200, data: { taskId: 'task-1' } })]);
    const { tools } = makeTools(makeConfig({ provider: 'sunoapi' }));

    const answer = await tools.handle('generate-music', {
      prompt: 'rain',
      style: 'ambient',
      model: 'V5',
      durationSec: 120,
      wait: false,
    });

    expect(bodyOf(fetchMock).duration).toBeUndefined();
    expect(answer.warnings.join(' ')).toContain('V5_5');
  });

  it('keeps a track length the model does accept', async () => {
    const fetchMock = stubFetch([jsonAnswer({ code: 200, data: { taskId: 'task-1' } })]);
    const { tools } = makeTools(makeConfig({ provider: 'sunoapi' }));

    const answer = await tools.handle('generate-music', {
      prompt: 'rain',
      style: 'ambient',
      model: 'V5_5',
      durationSec: 120,
      wait: false,
    });

    expect(bodyOf(fetchMock).duration).toBe(120);
    expect(answer.warnings).toEqual([]);
  });

  it('reports a task that outlives the timeout as pending rather than an error', async () => {
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      ...Array.from({ length: 40 }, () => jsonAnswer({ id: 'job-1', status: 'PROCESSING' })),
    ]);
    const { tools } = makeTools(makeConfig({ pollIntervalMs: 1, timeoutMs: 5 }));

    const answer = await tools.handle('generate-music', { prompt: 'rain', wait: true });

    expect(answer.status).toBe('pending');
    expect(answer.taskId).toBe('job-1');
    expect(answer.hint).toContain('job-1');
  });

  it('turns a failed generation into an error the client sees', async () => {
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      jsonAnswer({ id: 'job-1', status: 'FAILED', error: 'content policy violation' }),
    ]);
    const { tools } = makeTools();

    await expect(tools.handle('generate-music', { prompt: 'rain', wait: true })).rejects.toThrow(
      'content policy violation'
    );
  });

  it('uploads both takes and builds the playlist that is missing', async () => {
    const mp3 = Buffer.from('id3-');
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [
            { id: 't1', audioUrl: 'https://cdn.example.com/t1.mp3', title: 'Ozhog', duration: 180 },
            { id: 't2', audioUrl: 'https://cdn.example.com/t2.mp3', title: 'Ozhog', duration: 175 },
          ],
        },
      }),
      fileAnswer(mp3),
      fileAnswer(mp3),
    ]);
    const { tools, query } = makeTools();

    const answer = await tools.handle('generate-music', {
      prompt: 'rain',
      title: 'Ozhog',
      style: 'dark ambient',
      wait: true,
      targetDir: 'worlds/pepel/sessions/Session 15',
      playlist: 'S15',
    });

    expect(answer.status).toBe('complete');
    expect(answer.tracks.map((t: any) => t.path)).toEqual([
      'worlds/pepel/sessions/Session 15/Ozhog.mp3',
      'worlds/pepel/sessions/Session 15/Ozhog (2).mp3',
    ]);
    expect(answer.tracks.every((t: any) => t.playlist === 'S15')).toBe(true);

    const uploads = query.mock.calls.filter(([method]) => String(method).endsWith('files.upload'));
    expect(uploads).toHaveLength(2);
    expect(uploads[0][1]).toMatchObject({
      targetDir: 'worlds/pepel/sessions/Session 15',
      fileName: 'Ozhog.mp3',
      mimeType: 'audio/mpeg',
      overwrite: true,
      fileData: mp3.toString('base64'),
    });

    const created = query.mock.calls.find(([method]) => String(method).endsWith('playlist.create'));
    expect(created?.[1]).toMatchObject({ name: 'S15', mode: 'sequential' });
    expect(created?.[1].tracks).toHaveLength(2);
  });

  it('names the files after the task when there is no title and no fileName', async () => {
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [{ id: 't1', audioUrl: 'https://cdn.example.com/t1.mp3', duration: 10 }],
        },
      }),
      fileAnswer(Buffer.from('id3-')),
    ]);
    const { tools, query } = makeTools();

    await tools.handle('generate-music', {
      prompt: 'rain',
      wait: true,
      targetDir: 'worlds/w/music',
    });

    const upload = query.mock.calls.find(([method]) => String(method).endsWith('files.upload'));
    expect(upload?.[1].fileName).toBe('Suno job-1.mp3');
  });

  it('leaves a track that is too big to upload alone and explains why', async () => {
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [{ id: 't1', audioUrl: 'https://cdn.example.com/t1.mp3', duration: 10 }],
        },
      }),
      fileAnswer(Buffer.alloc(26 * 1024 * 1024)),
    ]);
    const { tools, query } = makeTools();

    const answer = await tools.handle('generate-music', {
      prompt: 'rain',
      wait: true,
      targetDir: 'worlds/w/music',
    });

    expect(answer.tracks[0].path).toBeUndefined();
    expect(answer.tracks[0].audioUrl).toBe('https://cdn.example.com/t1.mp3');
    expect(answer.warnings.join(' ')).toContain('25 MB upload limit');
    expect(query.mock.calls.some(([method]) => String(method).endsWith('files.upload'))).toBe(
      false
    );
  });

  it('skips the playlist without a targetDir, since a playlist points at stored files', async () => {
    stubFetch([
      jsonAnswer({ jobId: 'job-1' }),
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [{ id: 't1', audioUrl: 'https://cdn.example.com/t1.mp3', duration: 10 }],
        },
      }),
    ]);
    const { tools, query } = makeTools();

    const answer = await tools.handle('generate-music', {
      prompt: 'rain',
      wait: true,
      playlist: 'S15',
    });

    expect(answer.warnings.join(' ')).toContain('targetDir');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('music-status', () => {
  it('adds only the tracks the playlist does not have yet', async () => {
    stubFetch([
      jsonAnswer({
        id: 'job-1',
        status: 'COMPLETED',
        result: {
          tracks: [
            { id: 't1', audioUrl: 'https://cdn.example.com/t1.mp3', title: 'Ozhog', duration: 180 },
            { id: 't2', audioUrl: 'https://cdn.example.com/t2.mp3', title: 'Ozhog', duration: 175 },
          ],
        },
      }),
      fileAnswer(Buffer.from('id3-')),
      fileAnswer(Buffer.from('id3-')),
    ]);

    const query = vi.fn(async (method: string, payload: any) => {
      if (method.endsWith('files.upload')) {
        return { path: `${payload.targetDir}/${payload.fileName}`, size: 4, existed: true };
      }
      if (method.endsWith('playlist.list')) {
        return [
          {
            id: 'playlist-1',
            name: 'S15',
            tracks: [{ id: 's1', name: 'Ozhog', path: 'worlds/w/music/Ozhog.mp3' }],
          },
        ];
      }
      return { ok: true };
    });
    const tools = new MusicTools({ foundryClient: { query } as any, logger, config: makeConfig() });

    await tools.handle('music-status', {
      taskId: 'job-1',
      targetDir: 'worlds/w/music',
      fileName: 'Ozhog',
      playlist: 'S15',
    });

    const added = query.mock.calls.find(([method]) =>
      String(method).endsWith('playlist.addTracks')
    );
    expect(added?.[1].tracks).toEqual([
      { path: 'worlds/w/music/Ozhog (2).mp3', name: 'Ozhog (2)', volume: 0.6, repeat: false },
    ]);
    expect(query.mock.calls.some(([method]) => String(method).endsWith('playlist.create'))).toBe(
      false
    );
  });
});

describe('music-credits', () => {
  it('answers with the provider and its balance', async () => {
    stubFetch([jsonAnswer({ team: { credits: 4500 } })]);
    const { tools } = makeTools();

    await expect(tools.handle('music-credits', {})).resolves.toEqual({
      provider: 'apiframe',
      credits: 4500,
    });
  });
});
