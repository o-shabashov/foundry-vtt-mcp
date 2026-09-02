import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  checkAccess,
  constValue,
  getOrCreateFolder,
  registerNamespaceQueries,
  resolveInCollection,
  unknownAction,
} from './common.js';

/**
 * Playlist handlers: build the session soundtrack, then start and stop it.
 * Playback runs on the documents (`playAll`, `playSound`), so it works in the
 * canvas-less bridge client and is heard by every connected player.
 */

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

/** Default per-track volume when the caller does not say. */
const DEFAULT_TRACK_VOLUME = 0.6;

/** Default crossfade, in milliseconds. */
const DEFAULT_FADE_MS = 2000;

export class PlaylistHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    registerNamespaceQueries('playlist', PLAYLIST_ACTIONS, this.handlePlaylist.bind(this));
  }

  private async handlePlaylist(data: any): Promise<any> {
    const action = data?.action;
    const denied = checkAccess(action !== 'list');
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    switch (action) {
      case 'list':
        return this.listPlaylists(data);
      case 'create':
        return await this.createPlaylist(data);
      case 'update':
        return await this.updatePlaylist(data);
      case 'delete':
        return await this.deletePlaylist(data);
      case 'add-tracks':
        return await this.addTracks(data);
      case 'remove-tracks':
        return await this.removeTracks(data);
      case 'play':
        return await this.play(data);
      case 'stop':
        return await this.stop(data);
      case 'play-track':
        return await this.playTrack(data);
      case 'stop-track':
        return await this.stopTrack(data);
      case 'set-volume':
        return await this.setVolume(data);
      default:
        throw unknownAction(action, PLAYLIST_ACTIONS);
    }
  }

  // --- read ------------------------------------------------------------------

  private listPlaylists(data: any): any[] {
    const collection = (game as any).playlists;
    const playlists: any[] =
      typeof data?.playlist === 'string' && data.playlist.trim().length > 0
        ? [resolveInCollection(collection, data.playlist, 'Playlist')]
        : Array.from(collection ?? []);

    return playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description ?? null,
      mode: PlaylistHandlers.modeWord(playlist.mode),
      playing: playlist.playing === true,
      fade: playlist.fade ?? null,
      folder: playlist.folder?.name ?? null,
      uuid: playlist.uuid,
      tracks: Array.from(playlist.sounds ?? []).map((sound: any) => ({
        id: sound.id,
        name: sound.name,
        path: sound.path,
        volume: sound.volume,
        repeat: sound.repeat === true,
        playing: sound.playing === true,
      })),
    }));
  }

  // --- write -----------------------------------------------------------------

  private async createPlaylist(data: any): Promise<any> {
    const name = data?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('name is required to create a playlist');
    }

    const playlistData: Record<string, any> = {
      name: name.trim(),
      mode: PlaylistHandlers.modeValue(data?.mode),
      fade: typeof data?.fade === 'number' ? data.fade : DEFAULT_FADE_MS,
    };

    if (typeof data?.description === 'string') playlistData.description = data.description;

    const folderId = await getOrCreateFolder(data?.folder, 'Playlist');
    if (folderId) playlistData.folder = folderId;

    if (Array.isArray(data?.tracks) && data.tracks.length > 0) {
      playlistData.sounds = data.tracks.map((track: any, index: number) =>
        PlaylistHandlers.buildTrack(track, `tracks[${index}]`)
      );
    }

    const cls = (globalThis as any).Playlist?.implementation ?? (globalThis as any).Playlist;
    const playlist = await cls.create(playlistData);
    if (!playlist) throw new Error(`Foundry returned no document when creating playlist "${name}"`);

    audit(
      this.dataAccess,
      'playlist.create',
      { id: playlist.id, name: playlist.name, tracks: playlist.sounds?.size ?? 0 },
      'success'
    );

    return {
      id: playlist.id,
      name: playlist.name,
      uuid: playlist.uuid,
      mode: PlaylistHandlers.modeWord(playlist.mode),
      tracks: Array.from(playlist.sounds ?? []).map((sound: any) => ({
        id: sound.id,
        name: sound.name,
        path: sound.path,
      })),
    };
  }

  private async updatePlaylist(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const update: Record<string, any> = {};

    if (typeof data?.name === 'string') update.name = data.name;
    if (typeof data?.description === 'string') update.description = data.description;
    if (data?.mode !== undefined) update.mode = PlaylistHandlers.modeValue(data.mode);
    if (typeof data?.fade === 'number') update.fade = data.fade;
    if (typeof data?.folder === 'string') {
      update.folder = await getOrCreateFolder(data.folder, 'Playlist');
    }

    if (Object.keys(update).length === 0) {
      throw new Error('update needs at least one field to change');
    }

    await playlist.update(update);

    audit(
      this.dataAccess,
      'playlist.update',
      { id: playlist.id, keys: Object.keys(update) },
      'success'
    );

    return { id: playlist.id, name: playlist.name, updated: Object.keys(update) };
  }

  private async deletePlaylist(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const ref = { id: playlist.id, name: playlist.name };
    await playlist.delete();

    audit(this.dataAccess, 'playlist.delete', ref, 'success');

    return { deleted: true, ...ref };
  }

  private async addTracks(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const tracks = data?.tracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error('tracks array is required and must contain at least one entry');
    }

    const payload = tracks.map((track: any, index: number) =>
      PlaylistHandlers.buildTrack(track, `tracks[${index}]`)
    );
    const created = (await playlist.createEmbeddedDocuments('PlaylistSound', payload)) as any[];

    audit(
      this.dataAccess,
      'playlist.add-tracks',
      { id: playlist.id, count: created?.length ?? 0 },
      'success'
    );

    return {
      id: playlist.id,
      added: (created ?? []).map(sound => ({ id: sound.id, name: sound.name, path: sound.path })),
    };
  }

  private async removeTracks(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const names = data?.trackNames;
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error('trackNames array is required and must contain at least one entry');
    }

    const ids: string[] = [];
    const notFound: string[] = [];
    for (const name of names) {
      const sound = PlaylistHandlers.findTrack(playlist, name, false);
      if (sound) ids.push(sound.id);
      else notFound.push(String(name));
    }

    const deleted =
      ids.length > 0
        ? ((await playlist.deleteEmbeddedDocuments('PlaylistSound', ids)) as any[])
        : [];

    audit(
      this.dataAccess,
      'playlist.remove-tracks',
      { id: playlist.id, count: deleted?.length ?? 0 },
      'success'
    );

    return { id: playlist.id, removed: deleted?.length ?? 0, notFound };
  }

  private async play(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    await playlist.playAll();

    audit(this.dataAccess, 'playlist.play', { id: playlist.id, name: playlist.name }, 'success');

    return { id: playlist.id, name: playlist.name, playing: true };
  }

  private async stop(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    await playlist.stopAll();

    audit(this.dataAccess, 'playlist.stop', { id: playlist.id, name: playlist.name }, 'success');

    return { id: playlist.id, name: playlist.name, playing: false };
  }

  private async playTrack(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const sound = PlaylistHandlers.findTrack(playlist, data?.track, true);
    await playlist.playSound(sound);

    audit(
      this.dataAccess,
      'playlist.play-track',
      { id: playlist.id, track: sound.name },
      'success'
    );

    return { id: playlist.id, track: { id: sound.id, name: sound.name }, playing: true };
  }

  private async stopTrack(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const sound = PlaylistHandlers.findTrack(playlist, data?.track, true);
    await playlist.stopSound(sound);

    audit(
      this.dataAccess,
      'playlist.stop-track',
      { id: playlist.id, track: sound.name },
      'success'
    );

    return { id: playlist.id, track: { id: sound.id, name: sound.name }, playing: false };
  }

  private async setVolume(data: any): Promise<any> {
    const playlist = this.resolvePlaylist(data);
    const volume = data?.volume;
    if (typeof volume !== 'number' || volume < 0 || volume > 1) {
      throw new Error('volume is required and must be a number between 0 and 1');
    }

    const targets =
      typeof data?.track === 'string' && data.track.length > 0
        ? [PlaylistHandlers.findTrack(playlist, data.track, true)]
        : Array.from(playlist.sounds ?? []);

    const updates = targets.map((sound: any) => ({ _id: sound.id, volume }));
    if (updates.length === 0) {
      throw new Error(`Playlist "${playlist.name}" has no tracks to set the volume on`);
    }

    await playlist.updateEmbeddedDocuments('PlaylistSound', updates);

    audit(
      this.dataAccess,
      'playlist.set-volume',
      { id: playlist.id, volume, count: updates.length },
      'success'
    );

    return { id: playlist.id, volume, tracks: updates.length };
  }

  // --- helpers ---------------------------------------------------------------

  private resolvePlaylist(data: any): any {
    return resolveInCollection((game as any).playlists, data?.playlist, 'Playlist');
  }

  /** Find one track by id, exact name or case-insensitive partial name. */
  private static findTrack(playlist: any, identifier: unknown, required: boolean): any {
    if (typeof identifier !== 'string' || identifier.trim().length === 0) {
      if (required) throw new Error('track (name or id) is required');
      return null;
    }

    const sounds: any[] = Array.from(playlist.sounds ?? []);
    const byId = sounds.find(sound => sound.id === identifier);
    if (byId) return byId;

    const exact = sounds.filter(sound => sound.name === identifier);
    if (exact.length === 1) return exact[0];

    const needle = identifier.toLowerCase();
    const partial = sounds.filter(
      sound => typeof sound.name === 'string' && sound.name.toLowerCase().includes(needle)
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const candidates = partial.map(sound => `${sound.name} (${sound.id})`).join(', ');
      throw new Error(`Ambiguous track "${identifier}" - candidates: ${candidates}`);
    }

    if (required) {
      throw new Error(`Track "${identifier}" not found in playlist "${playlist.name}"`);
    }
    return null;
  }

  private static buildTrack(track: any, what: string): Record<string, any> {
    const path = track?.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error(`${what}: "path" to the audio file is required`);
    }

    return {
      name:
        typeof track?.name === 'string' && track.name.length > 0
          ? track.name
          : PlaylistHandlers.trackNameFromPath(path),
      path,
      volume: typeof track?.volume === 'number' ? track.volume : DEFAULT_TRACK_VOLUME,
      repeat: track?.repeat === true,
      fade: typeof track?.fade === 'number' ? track.fade : null,
      description: typeof track?.description === 'string' ? track.description : '',
    };
  }

  /** File basename without its extension, percent-decoded for readability. */
  private static trackNameFromPath(path: string): string {
    const raw = path.split('/').pop() ?? path;
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
    return name.replace(/\.[^.]+$/, '');
  }

  private static modeValue(word: unknown): number {
    const key = String(word ?? 'sequential').toLowerCase();
    switch (key) {
      case 'sequential':
        return constValue('PLAYLIST_MODES.SEQUENTIAL', 0);
      case 'shuffle':
        return constValue('PLAYLIST_MODES.SHUFFLE', 1);
      case 'simultaneous':
        return constValue('PLAYLIST_MODES.SIMULTANEOUS', 2);
      case 'soundboard':
      case 'disabled':
        return constValue('PLAYLIST_MODES.DISABLED', -1);
      default:
        throw new Error(
          `Unknown playlist mode "${String(word)}". Valid: sequential, shuffle, simultaneous, soundboard`
        );
    }
  }

  private static modeWord(value: unknown): string {
    switch (value) {
      case constValue('PLAYLIST_MODES.SHUFFLE', 1):
        return 'shuffle';
      case constValue('PLAYLIST_MODES.SIMULTANEOUS', 2):
        return 'simultaneous';
      case constValue('PLAYLIST_MODES.DISABLED', -1):
        return 'soundboard';
      default:
        return 'sequential';
    }
  }
}
