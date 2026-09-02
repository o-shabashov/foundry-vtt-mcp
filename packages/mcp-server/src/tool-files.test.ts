/**
 * Tests for the wrapper-side file hydration (src/tool-files.ts).
 *
 * These run against real temporary files: the whole point of the module is that
 * the stdio wrapper - not the backend - touches the filesystem, so mocking fs
 * would test nothing worth testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hydrateToolArgs,
  dehydrateToolResult,
  toolErrorResult,
  MAX_UPLOAD_BYTES,
} from './tool-files.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-files-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(fileName: string, content: unknown): string {
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(
    filePath,
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8'
  );
  return filePath;
}

function expectOk(outcome: ReturnType<typeof hydrateToolArgs>): Record<string, any> {
  if (!outcome.ok) throw new Error(`expected hydration to succeed, got: ${outcome.error}`);
  return outcome.args;
}

function expectError(outcome: ReturnType<typeof hydrateToolArgs>): string {
  if (outcome.ok) throw new Error('expected hydration to fail, but it succeeded');
  return outcome.error;
}

// ── import-actor ──────────────────────────────────────────────────────────────

describe('hydrateToolArgs: import-actor', () => {
  const destination = { type: 'world', folder: 'Imported Actors' };

  it('reads a single actor object into a one-element actors array', () => {
    const filePath = writeFixture('one.json', { name: 'Goblin Boss', type: 'npc' });

    const args = expectOk(hydrateToolArgs('import-actor', { filePath, destination }));

    expect(args.actors).toEqual([{ name: 'Goblin Boss', type: 'npc' }]);
    expect(args.filePath).toBeUndefined();
    expect(args.destination).toEqual(destination);
  });

  it('reads an array of actors as is', () => {
    const filePath = writeFixture('many.json', [
      { name: 'Hookwolf', type: 'npc' },
      { name: 'Mannequin', type: 'npc' },
    ]);

    const args = expectOk(hydrateToolArgs('import-actor', { filePath, destination }));

    expect(args.actors).toHaveLength(2);
    expect(args.actors[1].name).toBe('Mannequin');
  });

  it('leaves inline actors untouched', () => {
    const actors = [{ name: 'Siberian', type: 'npc' }];

    const args = expectOk(hydrateToolArgs('import-actor', { actors, destination }));

    expect(args.actors).toBe(actors);
  });

  it('rejects both actors and filePath', () => {
    const filePath = writeFixture('one.json', { name: 'Goblin Boss', type: 'npc' });

    const error = expectError(
      hydrateToolArgs('import-actor', {
        actors: [{ name: 'Goblin Boss', type: 'npc' }],
        filePath,
        destination,
      })
    );

    expect(error).toMatch(/exactly one of "actors" or "filePath"/);
  });

  it('rejects neither actors nor filePath', () => {
    const error = expectError(hydrateToolArgs('import-actor', { destination }));

    expect(error).toMatch(/requires either "actors" or "filePath"/);
  });

  it('reports a missing file instead of throwing', () => {
    const missing = path.join(tmpDir, 'nope.json');

    const error = expectError(hydrateToolArgs('import-actor', { filePath: missing, destination }));

    expect(error).toContain('Cannot read "filePath" file');
    expect(error).toContain(missing);
  });

  it('reports malformed JSON', () => {
    const filePath = writeFixture('broken.json', '{ "name": ');

    const error = expectError(hydrateToolArgs('import-actor', { filePath, destination }));

    expect(error).toContain('Cannot parse JSON');
  });

  it('rejects a JSON scalar', () => {
    const filePath = writeFixture('scalar.json', '42');

    const error = expectError(hydrateToolArgs('import-actor', { filePath, destination }));

    expect(error).toMatch(/must hold a JSON object or an array of JSON objects/);
  });

  it('rejects an array with a non-object entry', () => {
    const filePath = writeFixture('mixed.json', [{ name: 'Goblin Boss', type: 'npc' }, 'nope']);

    const error = expectError(hydrateToolArgs('import-actor', { filePath, destination }));

    expect(error).toContain('non-object entry at index 1');
  });
});

// ── manage-actor-items ────────────────────────────────────────────────────────

describe('hydrateToolArgs: manage-actor-items', () => {
  it('loads a file into "items" for action create', () => {
    const filePath = writeFixture('items.json', [{ name: 'Blade', type: 'weapon' }]);

    const args = expectOk(
      hydrateToolArgs('manage-actor-items', { actorIdentifier: 'Goblin Boss', action: 'create', filePath })
    );

    expect(args.items).toEqual([{ name: 'Blade', type: 'weapon' }]);
    expect(args.updates).toBeUndefined();
    expect(args.filePath).toBeUndefined();
  });

  it('loads a file into "updates" for action update-raw', () => {
    const filePath = writeFixture('updates.json', { _id: 'abc', 'system.uses.max': '3' });

    const args = expectOk(
      hydrateToolArgs('manage-actor-items', {
        actorIdentifier: 'Goblin Boss',
        action: 'update-raw',
        filePath,
      })
    );

    expect(args.updates).toEqual([{ _id: 'abc', 'system.uses.max': '3' }]);
    expect(args.filePath).toBeUndefined();
  });

  it('rejects filePath for actions that take no payload', () => {
    const filePath = writeFixture('items.json', [{ name: 'Blade' }]);

    const error = expectError(
      hydrateToolArgs('manage-actor-items', { actorIdentifier: 'Goblin Boss', action: 'list', filePath })
    );

    expect(error).toMatch(/applies to action "create" or "update-raw" only/);
  });

  it('rejects filePath alongside an inline payload', () => {
    const filePath = writeFixture('items.json', [{ name: 'Blade' }]);

    const error = expectError(
      hydrateToolArgs('manage-actor-items', {
        actorIdentifier: 'Goblin Boss',
        action: 'create',
        items: [{ name: 'Other' }],
        filePath,
      })
    );

    expect(error).toMatch(/exactly one of "items" or "filePath"/);
  });
});

// ── update-actor-raw ──────────────────────────────────────────────────────────

describe('hydrateToolArgs: update-actor-raw', () => {
  it('loads a JSON object into "update"', () => {
    const filePath = writeFixture('update.json', { 'system.attributes.hp.max': 120 });

    const args = expectOk(
      hydrateToolArgs('update-actor-raw', { actorIdentifier: 'Goblin Boss', filePath })
    );

    expect(args.update).toEqual({ 'system.attributes.hp.max': 120 });
    expect(args.filePath).toBeUndefined();
  });

  it('rejects an array payload', () => {
    const filePath = writeFixture('update.json', [{ 'system.attributes.hp.max': 120 }]);

    const error = expectError(
      hydrateToolArgs('update-actor-raw', { actorIdentifier: 'Goblin Boss', filePath })
    );

    expect(error).toMatch(/must hold a single JSON object/);
  });

  it('rejects both update and filePath', () => {
    const filePath = writeFixture('update.json', { name: 'Goblin Boss' });

    const error = expectError(
      hydrateToolArgs('update-actor-raw', {
        actorIdentifier: 'Goblin Boss',
        update: { name: 'Other' },
        filePath,
      })
    );

    expect(error).toMatch(/exactly one of "update" or "filePath"/);
  });
});

// ── run-script ────────────────────────────────────────────────────────────────

describe('hydrateToolArgs: run-script', () => {
  it('reads scriptFile into script verbatim', () => {
    const filePath = writeFixture('script.js', 'return game.actors.size;\n');

    const args = expectOk(hydrateToolArgs('run-script', { scriptFile: filePath }));

    expect(args.script).toBe('return game.actors.size;\n');
    expect(args.scriptFile).toBeUndefined();
  });

  it('rejects both script and scriptFile', () => {
    const filePath = writeFixture('script.js', 'return 1;');

    const error = expectError(
      hydrateToolArgs('run-script', { script: 'return 2;', scriptFile: filePath })
    );

    expect(error).toMatch(/exactly one of "script" or "scriptFile"/);
  });

  it('reports a missing script file', () => {
    const missing = path.join(tmpDir, 'gone.js');

    const error = expectError(hydrateToolArgs('run-script', { scriptFile: missing }));

    expect(error).toContain('Cannot read "scriptFile" file');
  });
});

// ── upload-file ───────────────────────────────────────────────────────────────

describe('hydrateToolArgs: upload-file', () => {
  const targetDir = 'worlds/my-world/maps';

  function writeBinary(fileName: string, bytes: Buffer): string {
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, bytes);
    return filePath;
  }

  it('reads the file as base64 and fills fileName and mimeType from the path', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const filePath = writeBinary('crypt.png', bytes);

    const args = expectOk(hydrateToolArgs('upload-file', { targetDir, filePath }));

    expect(args.fileData).toBe(bytes.toString('base64'));
    expect(Buffer.from(args.fileData, 'base64')).toEqual(bytes);
    expect(args.fileName).toBe('crypt.png');
    expect(args.mimeType).toBe('image/png');
    expect(args.filePath).toBeUndefined();
    expect(args.targetDir).toBe(targetDir);
  });

  it('guesses the mime type from the extension for every documented format', () => {
    const expected: Record<string, string> = {
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.png': 'image/png',
      'a.webp': 'image/webp',
      'a.gif': 'image/gif',
      'a.svg': 'image/svg+xml',
      'a.mp3': 'audio/mpeg',
      'a.ogg': 'audio/ogg',
      'a.wav': 'audio/wav',
      'a.webm': 'video/webm',
      'a.mp4': 'video/mp4',
      'a.pdf': 'application/pdf',
      'a.json': 'application/json',
      'a.txt': 'text/plain',
      'a.md': 'text/markdown',
      'a.bin': 'application/octet-stream',
      noextension: 'application/octet-stream',
    };

    for (const [fileName, mimeType] of Object.entries(expected)) {
      const filePath = writeBinary(fileName, Buffer.from('x'));
      const args = expectOk(hydrateToolArgs('upload-file', { targetDir, filePath }));
      expect(args.mimeType, fileName).toBe(mimeType);
    }
  });

  it('keeps an explicit fileName and mimeType', () => {
    const filePath = writeBinary('crypt.png', Buffer.from('x'));

    const args = expectOk(
      hydrateToolArgs('upload-file', {
        targetDir,
        filePath,
        fileName: 'склеп.png',
        mimeType: 'image/apng',
      })
    );

    expect(args.fileName).toBe('склеп.png');
    expect(args.mimeType).toBe('image/apng');
  });

  it('fills the mime type for an inline base64 payload as well', () => {
    const args = expectOk(
      hydrateToolArgs('upload-file', { targetDir, fileData: 'AAAA', fileName: 'battle.mp3' })
    );

    expect(args.mimeType).toBe('audio/mpeg');
    expect(args.fileData).toBe('AAAA');
  });

  it('refuses a file over the 25 MB limit and points at ssh', () => {
    const filePath = path.join(tmpDir, 'huge.webp');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, MAX_UPLOAD_BYTES + 1);

    const error = expectError(hydrateToolArgs('upload-file', { targetDir, filePath }));

    expect(error).toContain('over the 25.0 MB upload limit');
    expect(error).toContain('ssh/scp');
    expect(error).toContain(filePath);
  });

  it('accepts a file exactly on the limit', () => {
    const filePath = path.join(tmpDir, 'exact.webp');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, MAX_UPLOAD_BYTES);

    const args = expectOk(hydrateToolArgs('upload-file', { targetDir, filePath }));

    expect(args.fileName).toBe('exact.webp');
  });

  it('rejects both fileData and filePath, and neither', () => {
    const filePath = writeBinary('crypt.png', Buffer.from('x'));

    expect(
      expectError(hydrateToolArgs('upload-file', { targetDir, filePath, fileData: 'AAAA' }))
    ).toMatch(/exactly one of "fileData" or "filePath"/);
    expect(expectError(hydrateToolArgs('upload-file', { targetDir }))).toMatch(
      /either "filePath" or inline base64 "fileData"/
    );
  });

  it('reports a missing file and a directory instead of throwing', () => {
    const missing = path.join(tmpDir, 'nope.webp');

    expect(expectError(hydrateToolArgs('upload-file', { targetDir, filePath: missing }))).toContain(
      'Cannot read "filePath" file'
    );
    expect(expectError(hydrateToolArgs('upload-file', { targetDir, filePath: tmpDir }))).toContain(
      'is not a regular file'
    );
  });
});

// ── manage-walls ──────────────────────────────────────────────────────────────

describe('hydrateToolArgs: manage-walls', () => {
  const uvtt = {
    resolution: { pixels_per_grid: 100, map_size: { x: 30, y: 20 } },
    line_of_sight: [[{ x: 0, y: 0 }, { x: 5, y: 0 }]],
    portals: [],
  };

  it('reads uvttFile into uvtt', () => {
    const uvttFile = writeFixture('crypt.dd2vtt', uvtt);

    const args = expectOk(hydrateToolArgs('manage-walls', { action: 'import-uvtt', uvttFile }));

    expect(args.uvtt).toEqual(uvtt);
    expect(args.uvttFile).toBeUndefined();
  });

  it('leaves inline uvtt untouched', () => {
    const args = expectOk(hydrateToolArgs('manage-walls', { action: 'import-uvtt', uvtt }));

    expect(args.uvtt).toBe(uvtt);
  });

  it('rejects both uvtt and uvttFile', () => {
    const uvttFile = writeFixture('crypt.dd2vtt', uvtt);

    const error = expectError(
      hydrateToolArgs('manage-walls', { action: 'import-uvtt', uvtt, uvttFile })
    );

    expect(error).toMatch(/exactly one of "uvtt" or "uvttFile"/);
  });

  it('rejects a uvtt file that is not a JSON object', () => {
    const uvttFile = writeFixture('crypt.dd2vtt', [1, 2, 3]);

    expect(
      expectError(hydrateToolArgs('manage-walls', { action: 'import-uvtt', uvttFile }))
    ).toMatch(/must hold a Universal VTT JSON object/);
  });

  it('reports a missing uvtt file', () => {
    const missing = path.join(tmpDir, 'gone.dd2vtt');

    expect(
      expectError(hydrateToolArgs('manage-walls', { action: 'import-uvtt', uvttFile: missing }))
    ).toContain('Cannot read "uvttFile" file');
  });
});

// ── manage-journal ────────────────────────────────────────────────────────────

describe('hydrateToolArgs: manage-journal', () => {
  it('reads an .html page body into content', () => {
    const contentFile = writeFixture('letter.html', '<p>Burn this.</p>');

    const args = expectOk(
      hydrateToolArgs('manage-journal', {
        action: 'create',
        name: 'Handouts',
        pages: [{ name: 'Letter', contentFile }],
      })
    );

    expect(args.pages[0]).toEqual({ name: 'Letter', content: '<p>Burn this.</p>' });
  });

  it('reads a .txt page body as it is and leaves other pages alone', () => {
    const contentFile = writeFixture('notes.txt', 'plain text');
    const imagePage = { name: 'Map', type: 'image', src: 'maps/crypt.webp' };

    const args = expectOk(
      hydrateToolArgs('manage-journal', {
        action: 'create',
        name: 'Handouts',
        pages: [imagePage, { name: 'Notes', contentFile }],
      })
    );

    expect(args.pages[0]).toBe(imagePage);
    expect(args.pages[1]).toEqual({ name: 'Notes', content: 'plain text' });
  });

  it('refuses Markdown and tells the caller to convert it first', () => {
    const contentFile = writeFixture('letter.md', '# Burn this');

    const error = expectError(
      hydrateToolArgs('manage-journal', {
        action: 'create',
        name: 'Handouts',
        pages: [{ name: 'Letter', contentFile }],
      })
    );

    expect(error).toContain('is Markdown');
    expect(error).toContain('convert it first');
  });

  it('refuses an extension that is neither html nor txt', () => {
    const contentFile = writeFixture('letter.docx', 'binary-ish');

    expect(
      expectError(
        hydrateToolArgs('manage-journal', {
          action: 'create',
          name: 'Handouts',
          pages: [{ name: 'Letter', contentFile }],
        })
      )
    ).toMatch(/must be \.html, \.htm, \.txt/);
  });

  it('rejects a page carrying both content and contentFile', () => {
    const contentFile = writeFixture('letter.html', '<p>x</p>');

    expect(
      expectError(
        hydrateToolArgs('manage-journal', {
          action: 'create',
          name: 'Handouts',
          pages: [{ name: 'Letter', content: '<p>y</p>', contentFile }],
        })
      )
    ).toMatch(/page 0 takes exactly one of "content" or "contentFile"/);
  });

  it('tolerates a call with no pages at all', () => {
    const args = expectOk(hydrateToolArgs('manage-journal', { action: 'list' }));

    expect(args).toEqual({ action: 'list' });
  });
});

// ── send-chat ─────────────────────────────────────────────────────────────────

describe('hydrateToolArgs: send-chat', () => {
  it('reads messageFile into message verbatim', () => {
    const messageFile = writeFixture('read-aloud.html', '<p>The door groans open.</p>\n');

    const args = expectOk(hydrateToolArgs('send-chat', { messageFile }));

    expect(args.message).toBe('<p>The door groans open.</p>\n');
    expect(args.messageFile).toBeUndefined();
  });

  it('rejects both message and messageFile, and neither', () => {
    const messageFile = writeFixture('read-aloud.html', '<p>x</p>');

    expect(
      expectError(hydrateToolArgs('send-chat', { message: '<p>y</p>', messageFile }))
    ).toMatch(/exactly one of "message" or "messageFile"/);
    expect(expectError(hydrateToolArgs('send-chat', { speaker: 'Ozhog' }))).toMatch(
      /either "message" or "messageFile"/
    );
  });

  it('reports a missing message file', () => {
    const missing = path.join(tmpDir, 'gone.html');

    expect(expectError(hydrateToolArgs('send-chat', { messageFile: missing }))).toContain(
      'Cannot read "messageFile" file'
    );
  });
});

// ── untouched tools ───────────────────────────────────────────────────────────

describe('hydrateToolArgs: tools without file arguments', () => {
  it('copies the args through unchanged', () => {
    const original = { actorIdentifier: 'Goblin Boss', pack: 'world.my-bestiary' };

    const args = expectOk(hydrateToolArgs('export-actor', original));

    expect(args).toEqual(original);
    expect(args).not.toBe(original);
  });

  it('tolerates undefined args', () => {
    expect(expectOk(hydrateToolArgs('bridge-info', undefined))).toEqual({});
  });
});

// ── dehydrateToolResult ───────────────────────────────────────────────────────

describe('dehydrateToolResult: export-actor', () => {
  const actorSource = { name: 'Goblin Boss', type: 'npc', items: [{ name: 'Blade' }] };

  function backendResult(payload: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  it('writes the actor source and returns a summary without data', () => {
    const outFile = path.join(tmpDir, 'nested', 'ozhog.json');
    const result = backendResult({
      uuid: 'Actor.abc',
      name: 'Goblin Boss',
      type: 'npc',
      itemCount: 1,
      data: actorSource,
    });

    const out = dehydrateToolResult('export-actor', { actorIdentifier: 'Goblin Boss', outFile }, result);
    const summary = JSON.parse(out.content[0].text);

    expect(summary).toEqual({
      uuid: 'Actor.abc',
      name: 'Goblin Boss',
      type: 'npc',
      itemCount: 1,
      bytes: summary.bytes,
      outFile,
    });
    expect(summary.data).toBeUndefined();

    const onDisk = fs.readFileSync(outFile, 'utf8');
    expect(JSON.parse(onDisk)).toEqual(actorSource);
    expect(onDisk).toContain('\n  "name"'); // pretty-printed with 2 spaces
    expect(summary.bytes).toBe(Buffer.byteLength(onDisk, 'utf8'));
  });

  it('passes the response through when no outFile is given', () => {
    const result = backendResult({ uuid: 'Actor.abc', data: actorSource });

    expect(dehydrateToolResult('export-actor', { actorIdentifier: 'Goblin Boss' }, result)).toBe(result);
  });

  it('passes error responses through untouched', () => {
    const outFile = path.join(tmpDir, 'never.json');
    const result = { content: [{ type: 'text', text: 'Error: no such actor' }], isError: true };

    expect(dehydrateToolResult('export-actor', { outFile }, result)).toBe(result);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('passes non-JSON text through untouched', () => {
    const outFile = path.join(tmpDir, 'never.json');
    const result = { content: [{ type: 'text', text: 'plain text' }] };

    expect(dehydrateToolResult('export-actor', { outFile }, result)).toBe(result);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('reports a write failure as a tool error', () => {
    // A path under an existing regular file cannot be created.
    const blocker = writeFixture('blocker', 'not a directory');
    const outFile = path.join(blocker, 'actor.json');
    const result = backendResult({ uuid: 'Actor.abc', data: actorSource });

    const out = dehydrateToolResult('export-actor', { outFile }, result);

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('Cannot write "outFile"');
  });

  it('leaves other tools alone', () => {
    const result = backendResult({ anything: true });

    expect(dehydrateToolResult('manage-actor-items', { outFile: 'x.json' }, result)).toBe(result);
  });
});

describe('toolErrorResult', () => {
  it('builds an MCP error payload', () => {
    expect(toolErrorResult('boom')).toEqual({
      content: [{ type: 'text', text: 'Error: boom' }],
      isError: true,
    });
  });
});
