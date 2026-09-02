#!/usr/bin/env node
// Build a whole session in Foundry from a YAML manifest: upload assets, create scenes with lights,
// walls, tiles, notes and tokens, playlists, journals with ownership, optionally a combat.
//
//   node scripts/session-apply.mjs path/to/session.yaml [--dry-run] [--only=uploads,scenes,playlists,journals,combat]
//
// Manifest (paths under `assetsDir` are local; they are uploaded to `remoteDir` and referenced by that path):
//
//   session: Сессия 15
//   assetsDir: /abs/local/dir
//   remoteDir: worlds/my-world/sessions/Сессия 15
//   uploads: [ { file: Карта.jpeg } ]            # optional; default: every image/audio/pdf file in assetsDir
//   scenes:
//     - name: Тихая Заводь
//       background: Карта.jpeg                       # file in assetsDir (or an existing Data path)
//       gridSize: 100, darkness: 0.2, globalLight: false, replace: true, activate: false
//       lights:  [ { x: 10, y: 5, preset: torch } ]
//       walls:   { box: true, uvtt: map.dd2vtt, segments: [ { from: {x: 0, y: 0}, to: {x: 10, y: 0}, door: door } ] }
//       tiles:   [ { image: Overlay.png, x: 0, y: 0, overhead: true } ]
//       tokens:  [ { actor: Compendium.world.my-bestiary.Actor.xxx, x: 20, y: 12 }, { actor: Бес, x: 5, y: 5, count: 6 } ]
//       notes:   [ { journal: Заметки, x: 3, y: 3, label: Колодец } ]
//       playlist: С15 Заводь
//   playlists:
//     - { name: С15 Заводь, mode: shuffle, tracks: [ { file: Бой.mp3, repeat: true, volume: 0.5 } ] }
//   journals:
//     - name: Хэндаут
//       folder: Сессия 15
//       ownership: { players: observer }
//       pages: [ { name: Лист, type: image, src: Хэндаут.jpeg }, { name: Текст, type: text, contentFile: text.html } ]
//   combat: { scene: Тихая Заводь, select: hostile, rollNpc: true }
//
// Requires the MCP bridge to be reachable (same as scripts/mcp-call.mjs).

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createClient } from './lib/mcp-client.mjs';

const args = process.argv.slice(2);
const manifestPath = args.find(a => !a.startsWith('--'));
if (!manifestPath) {
  console.error('usage: session-apply.mjs <manifest.yaml> [--dry-run] [--only=a,b]');
  process.exit(2);
}
const dryRun = args.includes('--dry-run');
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = section => only.length === 0 || only.includes(section);

const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
const assetsDir = manifest.assetsDir ? path.resolve(path.dirname(manifestPath), manifest.assetsDir) : path.dirname(manifestPath);
const remoteDir = manifest.remoteDir;
if (!remoteDir) throw new Error('manifest.remoteDir is required');

const ASSET_EXT = /\.(jpe?g|png|webp|gif|svg|mp3|ogg|wav|webm|mp4|pdf)$/i;
const log = (...a) => console.log(...a);
const uploaded = new Map(); // local file name -> remote path

/** Resolve a manifest file reference: uploaded asset name -> remote path; anything with a slash is used as is. */
function remote(ref) {
  if (!ref) return ref;
  if (uploaded.has(ref)) return uploaded.get(ref);
  if (ref.includes('/')) return ref;
  // Foundry stores uploaded paths percent-encoded per segment; mirror that for files uploaded earlier
  const guess = `${remoteDir}/${ref}`.split('/').map(seg => encodeURIComponent(seg)).join('/');
  log(`  (no upload recorded for "${ref}", using ${guess})`);
  return guess;
}

const client = dryRun ? null : await createClient({ timeoutMs: 300000 });
async function call(name, toolArgs) {
  if (dryRun) {
    log(`  [dry-run] ${name} ${JSON.stringify(toolArgs).slice(0, 300)}`);
    return {};
  }
  const res = await client.call(name, toolArgs);
  return res;
}

try {
  // ---------- uploads ----------
  if (want('uploads')) {
    const list = manifest.uploads?.length
      ? manifest.uploads.map(u => (typeof u === 'string' ? u : u.file))
      : fs.readdirSync(assetsDir).filter(f => ASSET_EXT.test(f));
    log(`uploads: ${list.length} files -> ${remoteDir}`);
    for (const file of list) {
      const local = path.join(assetsDir, file);
      const res = await call('upload-file', { filePath: local, targetDir: remoteDir, overwrite: true });
      const remotePath = res?.path ?? `${remoteDir}/${file}`;
      uploaded.set(file, remotePath);
      log(`  ${file} -> ${remotePath}`);
    }
  }

  // ---------- playlists (before scenes so a scene can link one) ----------
  if (want('playlists')) {
    for (const p of manifest.playlists ?? []) {
      log(`playlist: ${p.name}`);
      const tracks = (p.tracks ?? []).map(t => ({ path: remote(t.file ?? t.path), name: t.name, volume: t.volume, repeat: t.repeat, fade: t.fade }));
      if (p.replace !== false) {
        try { await call('manage-playlists', { action: 'delete', playlist: p.name }); } catch { /* absent is fine */ }
      }
      await call('manage-playlists', { action: 'create', name: p.name, mode: p.mode ?? 'sequential', fade: p.fade, folder: p.folder, description: p.description, tracks });
    }
  }

  // ---------- journals ----------
  if (want('journals')) {
    for (const j of manifest.journals ?? []) {
      log(`journal: ${j.name}`);
      const pages = (j.pages ?? []).map(pg => ({
        name: pg.name, type: pg.type ?? 'text', content: pg.content, contentFile: pg.contentFile ? path.join(assetsDir, pg.contentFile) : undefined,
        src: pg.src ? remote(pg.src) : undefined, caption: pg.caption, titleLevel: pg.titleLevel, showTitle: pg.showTitle,
      }));
      if (j.replace !== false) {
        try { await call('manage-journal', { action: 'delete', journal: j.name }); } catch { /* absent is fine */ }
      }
      await call('manage-journal', { action: 'create', name: j.name, folder: j.folder, ownership: j.ownership, pages });
    }
  }

  // ---------- scenes ----------
  if (want('scenes')) {
    for (const s of manifest.scenes ?? []) {
      log(`scene: ${s.name}`);
      if (s.replace !== false) {
        try { await call('manage-scene', { action: 'delete', scene: s.name }); } catch { /* absent is fine */ }
      }
      const created = await call('manage-scene', {
        action: 'create', name: s.name, background: remote(s.background), folder: s.folder,
        gridSize: s.gridSize, gridType: s.gridType, gridDistance: s.gridDistance, gridUnits: s.gridUnits,
        width: s.width, height: s.height, padding: s.padding, backgroundColor: s.backgroundColor,
        darkness: s.darkness, globalLight: s.globalLight, tokenVision: s.tokenVision, fogExploration: s.fogExploration,
        navigation: s.navigation, navName: s.navName, playlist: s.playlist, initialView: s.initialView, activate: false,
      });
      const scene = created?.id ?? s.name;
      if (s.walls) {
        const w = s.walls;
        if (w.box) await call('manage-walls', { scene, action: 'box', box: w.box === true ? undefined : w.box });
        if (w.uvtt) await call('manage-walls', { scene, action: 'import-uvtt', uvttFile: path.join(assetsDir, w.uvtt) });
        if (w.segments?.length) await call('manage-walls', { scene, action: 'create', walls: w.segments });
      }
      if (s.lights?.length) await call('manage-scene-lights', { scene, action: 'create', lights: s.lights });
      if (s.tiles?.length) await call('manage-tiles', { scene, action: 'create', tiles: s.tiles.map(t => ({ ...t, image: remote(t.image) })) });
      if (s.notes?.length) await call('manage-scene-notes', { scene, action: 'create', notes: s.notes });
      if (s.tokens?.length) await call('place-tokens', { scene, tokens: s.tokens, importCompendiumTo: manifest.importFolder });
      if (s.activate) await call('manage-scene', { action: 'activate', scene });
    }
  }

  // ---------- combat ----------
  if (want('combat') && manifest.combat) {
    const c = manifest.combat;
    log(`combat on ${c.scene}`);
    await call('manage-combat', { action: 'create', scene: c.scene, select: c.select, tokens: c.tokens, rollNpc: c.rollNpc, rollAll: c.rollAll, initiative: c.initiative });
  }

  log('done');
} finally {
  client?.close();
}
