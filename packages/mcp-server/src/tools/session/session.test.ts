/**
 * Session tool tests.
 *
 * The Foundry side runs browser-side, so these cover the MCP tool layer: the tool
 * definitions clients see, the zod validation of arguments, and that every tool
 * reaches the right foundry-mcp-bridge query with the payload the module expects,
 * including the defaults and presets this layer fills in.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionTools, SESSION_TOOL_NAMES } from './index.js';

function makeTools() {
  const query = vi.fn(async () => ({ ok: true }));
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  return { tools: new SessionTools({ foundryClient, logger }), query };
}

/** Method and payload of the single bridge call a handler made. */
function lastCall(query: ReturnType<typeof makeTools>['query']) {
  expect(query).toHaveBeenCalledTimes(1);
  const [method, payload] = query.mock.calls[0] as unknown as [string, any];
  return { method, payload };
}

// ── definitions ───────────────────────────────────────────────────────────────

describe('SessionTools definitions', () => {
  it('advertises all sixteen tools with object input schemas', () => {
    const { tools } = makeTools();
    const defs = tools.getToolDefinitions();

    expect(defs.map(d => d.name)).toEqual([...SESSION_TOOL_NAMES]);
    expect(defs).toHaveLength(16);
    for (const def of defs) {
      expect(def.inputSchema.type).toBe('object');
      expect(def.description.length).toBeGreaterThan(50);
    }
  });

  it('answers to exactly the advertised names', () => {
    const { tools } = makeTools();

    for (const name of SESSION_TOOL_NAMES) {
      expect(tools.canHandle(name)).toBe(true);
    }
    expect(tools.canHandle('import-actor')).toBe(false);
    expect(tools.canHandle('nonsense')).toBe(false);
  });

  it('tells clients upload-file reads the path on the MCP client machine, with a 25 MB limit', () => {
    const { tools } = makeTools();
    const def = tools.getToolDefinitions().find(d => d.name === 'upload-file');

    expect(def!.description).toContain('25 MB');
    expect(def!.description).toContain("client's machine");
    expect(def!.description).toContain('ssh/scp');
  });

  it('advertises the file-backed arguments so clients can pass them', () => {
    const { tools } = makeTools();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d]));

    expect(byName['upload-file'].inputSchema.properties.filePath).toBeDefined();
    expect(byName['manage-walls'].inputSchema.properties.uvttFile).toBeDefined();
    expect(byName['send-chat'].inputSchema.properties.messageFile).toBeDefined();
    expect(
      (byName['manage-journal'].inputSchema.properties.pages as any).items.properties.contentFile
    ).toBeDefined();
  });

  it('spells out the action enums, coordinate units and light presets', () => {
    const { tools } = makeTools();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d]));

    expect(byName['manage-scene'].inputSchema.properties.action.enum).toEqual([
      'create',
      'update',
      'delete',
      'activate',
      'list',
      'info',
    ]);

    const tokenItems = (byName['place-tokens'].inputSchema.properties.tokens as any).items;
    expect(tokenItems.properties.units.enum).toEqual(['px', 'grid']);
    expect(tokenItems.required).toEqual(['actor', 'x', 'y']);

    const lightItems = (byName['manage-scene-lights'].inputSchema.properties.lights as any).items;
    expect(lightItems.properties.preset.enum).toEqual([
      'torch',
      'campfire',
      'candle',
      'moonlight',
      'lantern',
      'magical',
    ]);

    const trackItems = (byName['manage-playlists'].inputSchema.properties.tracks as any).items;
    expect(trackItems.required).toEqual(['path']);
    expect(byName['manage-playlists'].inputSchema.properties.mode.enum).toEqual([
      'sequential',
      'shuffle',
      'simultaneous',
      'soundboard',
    ]);

    const pageItems = (byName['manage-journal'].inputSchema.properties.pages as any).items;
    expect(pageItems.properties.type.enum).toEqual(['text', 'image', 'pdf', 'video']);
  });

  it('refuses an unknown tool name through handle', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('nonsense', {})).rejects.toThrow('Unknown session tool');
    expect(query).not.toHaveBeenCalled();
  });
});

// ── files ─────────────────────────────────────────────────────────────────────

describe('upload-file', () => {
  it('forwards the hydrated payload with overwrite and source defaults', async () => {
    const { tools, query } = makeTools();

    await tools.handle('upload-file', {
      targetDir: 'worlds/my-world/maps',
      fileName: 'склеп.webp',
      fileData: 'AAAA',
      mimeType: 'image/webp',
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.files.upload',
      payload: {
        targetDir: 'worlds/my-world/maps',
        fileName: 'склеп.webp',
        fileData: 'AAAA',
        mimeType: 'image/webp',
        overwrite: true,
        source: 'data',
      },
    });
  });

  it('names filePath in the error when nothing was hydrated', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('upload-file', { targetDir: 'maps' })).rejects.toThrow(/filePath/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-files', () => {
  it('browses on list and creates on mkdir', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-files', { action: 'list', dir: 'music', extensions: ['.mp3'] });
    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.files.browse',
      payload: { dir: 'music', source: 'data', extensions: ['.mp3'] },
    });

    query.mockClear();
    await tools.handle('manage-files', { action: 'mkdir', dir: 'worlds/my-world/handouts' });
    expect(lastCall(query).method).toBe('foundry-mcp-bridge.files.mkdir');
  });

  it('rejects an unknown action', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('manage-files', { action: 'delete', dir: 'x' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

// ── scenes ────────────────────────────────────────────────────────────────────

describe('manage-scene', () => {
  it('spells out the documented defaults on create', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene', {
      action: 'create',
      name: 'Crypt',
      background: 'worlds/my-world/maps/crypt.webp',
    });

    const { method, payload } = lastCall(query);
    expect(method).toBe('foundry-mcp-bridge.scene.create');
    expect(payload).toEqual({
      name: 'Crypt',
      background: 'worlds/my-world/maps/crypt.webp',
      gridSize: 100,
      gridType: 'square',
      gridDistance: 5,
      gridUnits: 'ft',
      padding: 0.25,
      darkness: 0,
      globalLight: true,
      tokenVision: true,
      fogExploration: true,
      navigation: true,
    });
  });

  it('turns global light off when the scene starts dark, unless told otherwise', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene', {
      action: 'create',
      name: 'Crypt',
      background: 'crypt.webp',
      darkness: 1,
    });
    expect(lastCall(query).payload.globalLight).toBe(false);

    query.mockClear();
    await tools.handle('manage-scene', {
      action: 'create',
      name: 'Crypt',
      background: 'crypt.webp',
      darkness: 1,
      globalLight: true,
    });
    expect(lastCall(query).payload.globalLight).toBe(true);
  });

  it('keeps update sparse so untouched scene fields survive', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene', { action: 'update', scene: 'Crypt', darkness: 0.8 });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.scene.update',
      payload: { scene: 'Crypt', darkness: 0.8 },
    });
  });

  it('sends only the scene for delete, activate and info, and nothing for list', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene', { action: 'activate', scene: 'Crypt' });
    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.scene.activate',
      payload: { scene: 'Crypt' },
    });

    query.mockClear();
    await tools.handle('manage-scene', { action: 'list' });
    expect(lastCall(query)).toEqual({ method: 'foundry-mcp-bridge.scene.list', payload: {} });
  });

  it('requires name and background on create, and a scene elsewhere', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('manage-scene', { action: 'create', name: 'Crypt' })).rejects.toThrow(
      /"background"/
    );
    await expect(tools.handle('manage-scene', { action: 'info' })).rejects.toThrow(/"scene"/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a darkness outside 0..1', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-scene', { action: 'update', scene: 'Crypt', darkness: 4 })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('place-tokens', () => {
  it('forwards tokens with count and the import folder default', async () => {
    const { tools, query } = makeTools();

    await tools.handle('place-tokens', {
      scene: 'Crypt',
      tokens: [
        { actor: 'Skeleton', x: 3, y: 4, count: 4, disposition: 'hostile' },
        { actor: 'Compendium.world.bestiary.Actor.abc', x: 10, y: 2, units: 'px' },
      ],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.scene.placeTokens',
      payload: {
        scene: 'Crypt',
        tokens: [
          { actor: 'Skeleton', x: 3, y: 4, count: 4, disposition: 'hostile' },
          { actor: 'Compendium.world.bestiary.Actor.abc', x: 10, y: 2, units: 'px', count: 1 },
        ],
        importCompendiumTo: 'Imported Actors',
      },
    });
  });

  it('rejects an unknown disposition and a missing coordinate', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('place-tokens', { tokens: [{ actor: 'A', x: 1, y: 1, disposition: 'angry' }] })
    ).rejects.toThrow();
    await expect(
      tools.handle('place-tokens', { tokens: [{ actor: 'A', x: 1 }] })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-scene-lights', () => {
  it('expands a preset into an explicit light configuration', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene-lights', {
      scene: 'Crypt',
      action: 'create',
      lights: [{ x: 5, y: 6, preset: 'torch' }],
    });

    const { method, payload } = lastCall(query);
    expect(method).toBe('foundry-mcp-bridge.scene.lights');
    expect(payload.lights[0]).toEqual({
      x: 5,
      y: 6,
      bright: 20,
      dim: 40,
      alpha: 0.5,
      angle: 360,
      animation: 'torch',
      animationSpeed: 5,
      animationIntensity: 5,
      walls: true,
      vision: false,
      color: '#ff9329',
    });
    expect(payload.lights[0].preset).toBeUndefined();
  });

  it('lets explicit fields win over the preset', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene-lights', {
      action: 'create',
      lights: [{ x: 0, y: 0, preset: 'candle', color: '#00ff00', dim: 12 }],
    });

    const light = lastCall(query).payload.lights[0];
    expect(light.color).toBe('#00ff00');
    expect(light.dim).toBe(12);
    expect(light.bright).toBe(5);
    expect(light.animation).toBe('torch');
  });

  it('requires an id on update and coordinates on create', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-scene-lights', { action: 'update', lights: [{ dim: 10 }] })
    ).rejects.toThrow(/"id"/);
    await expect(
      tools.handle('manage-scene-lights', { action: 'create', lights: [{ preset: 'torch' }] })
    ).rejects.toThrow(/"x" and "y"/);
    await expect(tools.handle('manage-scene-lights', { action: 'delete' })).rejects.toThrow(
      /"ids"/
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('sends update without the create defaults', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene-lights', {
      action: 'update',
      lights: [{ id: 'abc', dim: 10 }],
    });

    expect(lastCall(query).payload.lights[0]).toEqual({ id: 'abc', dim: 10 });
  });
});

describe('manage-walls', () => {
  it('forwards walls with blocking and door defaults', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-walls', {
      scene: 'Crypt',
      action: 'create',
      walls: [{ from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, door: 'secret' }],
    });

    const { method, payload } = lastCall(query);
    expect(method).toBe('foundry-mcp-bridge.scene.walls');
    expect(payload.walls[0]).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 10, y: 0 },
      door: 'secret',
      move: true,
      sight: true,
      light: true,
      sound: true,
      oneWay: 'none',
    });
  });

  it('passes a box straight through', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-walls', {
      action: 'box',
      box: { x: 0, y: 0, width: 30, height: 20 },
    });

    expect(lastCall(query).payload.box).toEqual({ x: 0, y: 0, width: 30, height: 20 });
  });

  it('accepts uvtt data and refuses something that is not a Universal VTT export', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-walls', {
      action: 'import-uvtt',
      uvtt: { resolution: { pixels_per_grid: 100 }, line_of_sight: [[{ x: 0, y: 0 }]] },
    });
    expect(lastCall(query).payload.uvtt.line_of_sight).toHaveLength(1);

    query.mockClear();
    await expect(
      tools.handle('manage-walls', { action: 'import-uvtt', uvtt: { something: 1 } })
    ).rejects.toThrow(/Universal VTT/);
    await expect(tools.handle('manage-walls', { action: 'import-uvtt' })).rejects.toThrow(
      /"uvtt" or "uvttFile"/
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-tiles', () => {
  it('forwards a tile create', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-tiles', {
      action: 'create',
      tiles: [{ image: 'worlds/my-world/tiles/roof.webp', x: 2, y: 3, overhead: true }],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.scene.tiles',
      payload: {
        action: 'create',
        tiles: [{ image: 'worlds/my-world/tiles/roof.webp', x: 2, y: 3, overhead: true }],
      },
    });
  });

  it('requires image and coordinates on create, and an id on update', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-tiles', { action: 'create', tiles: [{ x: 1, y: 1 }] })
    ).rejects.toThrow(/"image", "x" and "y"/);
    await expect(
      tools.handle('manage-tiles', { action: 'update', tiles: [{ alpha: 0.5 }] })
    ).rejects.toThrow(/"id"/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-scene-notes', () => {
  it('fills the pin icon defaults', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-scene-notes', {
      action: 'create',
      notes: [{ journal: 'Crypt rooms', page: 'Room 3', x: 4, y: 5 }],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.scene.notes',
      payload: {
        action: 'create',
        notes: [
          {
            journal: 'Crypt rooms',
            page: 'Room 3',
            x: 4,
            y: 5,
            icon: 'icons/svg/book.svg',
            iconSize: 40,
          },
        ],
      },
    });
  });
});

// ── playlists ─────────────────────────────────────────────────────────────────

describe('manage-playlists', () => {
  it('creates a playlist with track defaults and a derived track name', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-playlists', {
      action: 'create',
      name: 'Crypt',
      mode: 'shuffle',
      tracks: [
        { path: 'worlds/my-world/music/dark%20halls.mp3', repeat: true },
        { path: 'music/fight.ogg', name: 'Fight', volume: 0.9 },
      ],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.playlist.create',
      payload: {
        name: 'Crypt',
        mode: 'shuffle',
        fade: 2000,
        tracks: [
          {
            path: 'worlds/my-world/music/dark%20halls.mp3',
            name: 'dark halls',
            volume: 0.6,
            repeat: true,
          },
          { path: 'music/fight.ogg', name: 'Fight', volume: 0.9, repeat: false },
        ],
      },
    });
  });

  it('maps hyphenated actions onto camelCase query methods', async () => {
    const { tools, query } = makeTools();

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['add-tracks', { playlist: 'Crypt', tracks: [{ path: 'a.mp3' }] }, 'addTracks'],
      ['remove-tracks', { playlist: 'Crypt', trackNames: ['a'] }, 'removeTracks'],
      ['play-track', { playlist: 'Crypt', track: 'a' }, 'playTrack'],
      ['stop-track', { playlist: 'Crypt', track: 'a' }, 'stopTrack'],
      ['set-volume', { playlist: 'Crypt', volume: 0.3 }, 'setVolume'],
      ['play', { playlist: 'Crypt' }, 'play'],
    ];

    for (const [action, args, method] of cases) {
      query.mockClear();
      await tools.handle('manage-playlists', { action, ...args });
      expect(lastCall(query).method).toBe(`foundry-mcp-bridge.playlist.${method}`);
    }
  });

  it('does not push a fade default onto actions other than create', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-playlists', { action: 'play', playlist: 'Crypt' });

    expect(lastCall(query).payload).toEqual({ playlist: 'Crypt' });
  });

  it('reports the field each action is missing', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('manage-playlists', { action: 'create' })).rejects.toThrow(/"name"/);
    await expect(tools.handle('manage-playlists', { action: 'play' })).rejects.toThrow(
      /"playlist"/
    );
    await expect(
      tools.handle('manage-playlists', { action: 'set-volume', playlist: 'Crypt' })
    ).rejects.toThrow(/"volume"/);
    expect(query).not.toHaveBeenCalled();
  });
});

// ── journals ──────────────────────────────────────────────────────────────────

describe('manage-journal', () => {
  it('creates an entry with page defaults and ownership', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-journal', {
      action: 'create',
      name: 'Handouts',
      ownership: { default: 'observer', users: { Amalia: 'owner' } },
      pages: [{ name: 'Letter', content: '<p>Burn this.</p>' }],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.journal.create',
      payload: {
        name: 'Handouts',
        ownership: { default: 'observer', users: { Amalia: 'owner' } },
        pages: [
          {
            name: 'Letter',
            type: 'text',
            content: '<p>Burn this.</p>',
            titleLevel: 1,
            showTitle: true,
          },
        ],
      },
    });
  });

  it('maps the page actions onto camelCase query methods', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-journal', {
      action: 'add-pages',
      journal: 'Handouts',
      pages: [{ name: 'Map', type: 'image', src: 'maps/crypt.webp' }],
    });
    expect(lastCall(query).method).toBe('foundry-mcp-bridge.journal.addPages');

    query.mockClear();
    await tools.handle('manage-journal', {
      action: 'update-page',
      journal: 'Handouts',
      page: 'Letter',
      pages: [{ content: '<p>Changed.</p>' }],
    });
    expect(lastCall(query).method).toBe('foundry-mcp-bridge.journal.updatePage');

    query.mockClear();
    await tools.handle('manage-journal', {
      action: 'delete-pages',
      journal: 'Handouts',
      pageIds: ['abc'],
    });
    expect(lastCall(query).method).toBe('foundry-mcp-bridge.journal.deletePages');
  });

  it('requires a source path on non-text pages and a name on new pages', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-journal', {
        action: 'create',
        name: 'Handouts',
        pages: [{ name: 'Map', type: 'image' }],
      })
    ).rejects.toThrow(/"src"/);
    await expect(
      tools.handle('manage-journal', {
        action: 'add-pages',
        journal: 'Handouts',
        pages: [{ content: '<p>x</p>' }],
      })
    ).rejects.toThrow(/"name"/);
    await expect(
      tools.handle('manage-journal', { action: 'update-page', journal: 'Handouts', page: 'Letter' })
    ).rejects.toThrow(/exactly one entry in "pages"/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('show-to-players', () => {
  it('opens a journal entry for everybody by default', async () => {
    const { tools, query } = makeTools();

    await tools.handle('show-to-players', { what: 'journal', journal: 'Handouts' });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.journal.show',
      payload: { what: 'journal', journal: 'Handouts', users: 'all', force: true },
    });
  });

  it('pops an image up for named players', async () => {
    const { tools, query } = makeTools();

    await tools.handle('show-to-players', {
      what: 'image',
      image: 'worlds/my-world/art/ozhog.webp',
      title: 'Ozhog',
      users: ['Amalia', 'Kairon'],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.journal.showImage',
      payload: {
        what: 'image',
        image: 'worlds/my-world/art/ozhog.webp',
        title: 'Ozhog',
        users: ['Amalia', 'Kairon'],
        force: true,
      },
    });
  });

  it('requires the target that matches "what"', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('show-to-players', { what: 'image' })).rejects.toThrow(/"image"/);
    await expect(tools.handle('show-to-players', { what: 'page', journal: 'H' })).rejects.toThrow(
      /"page"/
    );
    expect(query).not.toHaveBeenCalled();
  });
});

// ── ownership ─────────────────────────────────────────────────────────────────

describe('manage-ownership', () => {
  it('infers "set" when permissions are given', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-ownership', {
      documentType: 'JournalEntry',
      identifier: 'Handouts',
      players: 'observer',
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.ownership.set',
      payload: {
        action: 'set',
        documentType: 'JournalEntry',
        identifier: 'Handouts',
        players: 'observer',
      },
    });
  });

  it('infers "get" when no permissions are given', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-ownership', { documentType: 'Scene', identifier: 'Crypt' });

    expect(lastCall(query).method).toBe('foundry-mcp-bridge.ownership.get');
  });

  it('needs a journal for a page, and permissions for an explicit set', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-ownership', {
        documentType: 'JournalEntryPage',
        identifier: 'Letter',
        players: 'owner',
      })
    ).rejects.toThrow(/"journal"/);
    await expect(
      tools.handle('manage-ownership', {
        action: 'set',
        documentType: 'Scene',
        identifier: 'Crypt',
      })
    ).rejects.toThrow(/"default", "users" or "players"/);
    await expect(
      tools.handle('manage-ownership', { documentType: 'Widget', identifier: 'x' })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

// ── combat ────────────────────────────────────────────────────────────────────

describe('manage-combat', () => {
  it('creates a combat from a token selection', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-combat', {
      action: 'create',
      scene: 'Crypt',
      select: 'hostile',
      initiative: { Ozhog: 20 },
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.combat.create',
      payload: {
        scene: 'Crypt',
        select: 'hostile',
        initiative: { Ozhog: 20 },
        rollNpc: true,
      },
    });
  });

  it('maps roll-initiative onto rollInitiative and walks the turn order', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-combat', { action: 'roll-initiative', rollAll: true });
    expect(lastCall(query).method).toBe('foundry-mcp-bridge.combat.rollInitiative');

    for (const action of ['start', 'next', 'previous', 'end', 'status']) {
      query.mockClear();
      await tools.handle('manage-combat', { action });
      expect(lastCall(query).method).toBe(`foundry-mcp-bridge.combat.${action}`);
    }
  });

  it('needs tokens or a selection to add and remove combatants', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('manage-combat', { action: 'add' })).rejects.toThrow(
      /"tokens" or "select"/
    );
    await expect(
      tools.handle('manage-combat', { action: 'add', select: 'everyone' })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});

// ── chat ──────────────────────────────────────────────────────────────────────

describe('send-chat', () => {
  it('speaks in character when a speaker is given', async () => {
    const { tools, query } = makeTools();

    await tools.handle('send-chat', { message: '<p>Come closer.</p>', speaker: 'Ozhog' });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.chat.send',
      payload: { message: '<p>Come closer.</p>', speaker: 'Ozhog', style: 'ic' },
    });
  });

  it('narrates as the GM without a speaker, and keeps an explicit style', async () => {
    const { tools, query } = makeTools();

    await tools.handle('send-chat', { message: 'The door groans open.' });
    expect(lastCall(query).payload.style).toBe('other');

    query.mockClear();
    await tools.handle('send-chat', {
      message: 'rolls for the crowd',
      speaker: 'Ozhog',
      style: 'emote',
      whisperTo: 'gm',
      roll: '2d6+3',
    });
    expect(lastCall(query).payload).toEqual({
      message: 'rolls for the crowd',
      speaker: 'Ozhog',
      style: 'emote',
      whisperTo: 'gm',
      roll: '2d6+3',
    });
  });

  it('names messageFile in the error when nothing was hydrated', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('send-chat', { speaker: 'Ozhog' })).rejects.toThrow(/messageFile/);
    expect(query).not.toHaveBeenCalled();
  });
});

// ── tables and loot ───────────────────────────────────────────────────────────

describe('manage-rolltable', () => {
  it('derives the formula from the number of results', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-rolltable', {
      action: 'create',
      name: 'Crypt encounters',
      results: [
        { text: 'Nothing' },
        { text: 'Rats', weight: 3 },
        { document: 'Compendium.dnd5e.items.Item.abc' },
      ],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.table.create',
      payload: {
        name: 'Crypt encounters',
        formula: '1d3',
        replacement: true,
        rolls: 1,
        toChat: true,
        results: [
          { text: 'Nothing', weight: 1 },
          { text: 'Rats', weight: 3 },
          { document: 'Compendium.dnd5e.items.Item.abc', weight: 1 },
        ],
      },
    });
  });

  it('rolls an existing table', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-rolltable', {
      action: 'roll',
      table: 'Crypt encounters',
      rolls: 3,
      toChat: false,
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.table.roll',
      payload: {
        table: 'Crypt encounters',
        rolls: 3,
        toChat: false,
        replacement: true,
      },
    });
  });

  it('needs text or a document on every result', async () => {
    const { tools, query } = makeTools();

    await expect(
      tools.handle('manage-rolltable', { action: 'create', name: 'T', results: [{ weight: 2 }] })
    ).rejects.toThrow(/"text" or "document"/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('manage-loot-pile', () => {
  it('creates a container with the name and art defaults', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-loot-pile', {
      action: 'create',
      scene: 'Crypt',
      x: 6,
      y: 7,
      items: [{ item: 'Compendium.dnd5e.items.Item.abc', quantity: 3 }],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.piles.create',
      payload: {
        scene: 'Crypt',
        x: 6,
        y: 7,
        name: 'Loot',
        image: 'icons/svg/chest.svg',
        type: 'container',
        items: [{ item: 'Compendium.dnd5e.items.Item.abc', quantity: 3 }],
      },
    });
  });

  it('maps add-items onto addItems and leaves the defaults off other actions', async () => {
    const { tools, query } = makeTools();

    await tools.handle('manage-loot-pile', {
      action: 'add-items',
      pile: 'Chest',
      items: [{ item: 'Rope', pack: 'dnd5e.items' }],
    });

    expect(lastCall(query)).toEqual({
      method: 'foundry-mcp-bridge.piles.addItems',
      payload: { pile: 'Chest', items: [{ item: 'Rope', pack: 'dnd5e.items', quantity: 1 }] },
    });
  });

  it('needs coordinates to create and a pile to open', async () => {
    const { tools, query } = makeTools();

    await expect(tools.handle('manage-loot-pile', { action: 'create', x: 1 })).rejects.toThrow(
      /"x" and "y"/
    );
    await expect(tools.handle('manage-loot-pile', { action: 'open' })).rejects.toThrow(/"pile"/);
    expect(query).not.toHaveBeenCalled();
  });
});
