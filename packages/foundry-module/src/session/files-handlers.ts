import { MODULE_ID } from '../constants.js';
import type { FoundryDataAccess } from '../data-access.js';
import {
  audit,
  checkAccess,
  describeError,
  getFilePicker,
  registerNamespaceQueries,
  unknownAction,
} from './common.js';

/**
 * File handlers: upload assets into the Data directory and browse or create
 * directories there. Foundry exposes no delete endpoint, so none is offered.
 */

/** Actions understood by the browse/mkdir entry point. */
const FILE_ACTIONS = ['list', 'mkdir'] as const;

/** Directory creation reports this when the folder is already there. */
const EXISTS_PATTERN = /already exists|EEXIST/i;

export class FilesHandlers {
  constructor(private dataAccess: FoundryDataAccess) {}

  registerHandlers(): void {
    const prefix = `${MODULE_ID}.files`;

    CONFIG.queries[`${prefix}.upload`] = this.handleUpload.bind(this);
    CONFIG.queries[`${prefix}.browse`] = this.handleBrowse.bind(this);
    CONFIG.queries[`${prefix}.mkdir`] = this.handleMkdir.bind(this);

    // Single entry point for callers that prefer to pass the action in the payload
    registerNamespaceQueries('files', FILE_ACTIONS, this.handleManage.bind(this));
  }

  // --- 1.1 files.upload ------------------------------------------------------

  private async handleUpload(data: {
    targetDir: string;
    fileName: string;
    fileData: string;
    mimeType?: string;
    overwrite?: boolean;
    source?: string;
  }): Promise<any> {
    const denied = checkAccess(true);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const targetDir = FilesHandlers.normalizeDir(data?.targetDir);
    const fileName = data?.fileName;
    if (typeof fileName !== 'string' || fileName.trim().length === 0) {
      throw new Error('fileName is required');
    }
    if (fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('fileName must be a bare file name - put directories in targetDir');
    }
    if (typeof data?.fileData !== 'string' || data.fileData.length === 0) {
      throw new Error('fileData (base64) is required');
    }

    const source = data?.source ?? 'data';
    const overwrite = data?.overwrite !== false;
    const mimeType = data?.mimeType ?? 'application/octet-stream';
    const bytes = FilesHandlers.decodeBase64(data.fileData);

    await this.ensureDirectory(source, targetDir);

    const existed = await this.fileExists(source, targetDir, fileName);
    if (existed && !overwrite) {
      throw new Error(`${targetDir}/${fileName} already exists and overwrite is false`);
    }

    const FileCtor = (globalThis as any).File;
    if (typeof FileCtor !== 'function') {
      throw new Error('The File constructor is unavailable in this client');
    }
    const file = new FileCtor([bytes], fileName, { type: mimeType });

    const picker = getFilePicker();
    let response: any;
    try {
      response = await picker.upload(source, targetDir, file, {}, { notify: false });
    } catch (error) {
      const message = describeError(error);
      audit(this.dataAccess, 'files.upload', { targetDir, fileName }, 'failure', message);
      throw new Error(`Upload of "${fileName}" to "${targetDir}" failed: ${message}`);
    }

    if (!response || response.status === 'error' || response === false) {
      const message = response?.message ?? 'Foundry rejected the upload';
      audit(this.dataAccess, 'files.upload', { targetDir, fileName }, 'failure', message);
      throw new Error(`Upload of "${fileName}" to "${targetDir}" failed: ${message}`);
    }

    const path = response.path ?? `${targetDir}/${fileName}`;

    audit(
      this.dataAccess,
      'files.upload',
      { targetDir, fileName, size: bytes.length, existed },
      'success'
    );

    return { path, size: bytes.length, existed };
  }

  // --- 1.2 files.browse / files.mkdir ---------------------------------------

  private async handleManage(data: {
    action?: string;
    dir?: string;
    source?: string;
    extensions?: string[];
  }): Promise<any> {
    switch (data?.action) {
      case 'list':
        return await this.handleBrowse(data);
      case 'mkdir':
        return await this.handleMkdir(data);
      default:
        throw unknownAction(data?.action, FILE_ACTIONS);
    }
  }

  private async handleBrowse(data: {
    dir?: string;
    source?: string;
    extensions?: string[];
  }): Promise<any> {
    const denied = checkAccess(false);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const source = data?.source ?? 'data';
    const dir = FilesHandlers.normalizeDir(data?.dir, true);
    const options: Record<string, any> = {};
    if (Array.isArray(data?.extensions) && data.extensions.length > 0) {
      options.extensions = data.extensions;
    }

    const picker = getFilePicker();
    let result: any;
    try {
      result = await picker.browse(source, dir, options);
    } catch (error) {
      throw new Error(`Could not browse "${dir}": ${describeError(error)}`);
    }

    const dirs: string[] = Array.isArray(result?.dirs) ? result.dirs : [];
    const files: any[] = Array.isArray(result?.files) ? result.files : [];

    return {
      dir: result?.target ?? dir,
      source,
      dirs,
      files: files.map(entry => {
        const path = typeof entry === 'string' ? entry : (entry?.path ?? String(entry));
        return { path, name: FilesHandlers.basename(path), url: path };
      }),
    };
  }

  private async handleMkdir(data: { dir?: string; source?: string }): Promise<any> {
    const denied = checkAccess(true);
    if (denied) return denied;

    this.dataAccess.validateFoundryState();

    const source = data?.source ?? 'data';
    const dir = FilesHandlers.normalizeDir(data?.dir);
    const created = await this.ensureDirectory(source, dir);

    audit(this.dataAccess, 'files.mkdir', { dir, created }, 'success');

    return { created, path: dir, source };
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Create every missing segment of a path. Foundry has no recursive mkdir, so the
   * segments are walked one by one and "already exists" is swallowed.
   * Returns true when at least one directory was actually created.
   */
  private async ensureDirectory(source: string, targetDir: string): Promise<boolean> {
    if (!targetDir) return false;

    const picker = getFilePicker();
    const segments = targetDir.split('/').filter(segment => segment.length > 0);
    let current = '';
    let created = false;

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      try {
        await picker.createDirectory(source, current, {});
        created = true;
      } catch (error) {
        const message = describeError(error);
        if (!EXISTS_PATTERN.test(message)) {
          throw new Error(`Could not create directory "${current}": ${message}`);
        }
      }
    }

    return created;
  }

  /** Whether a file of that name is already sitting in the target directory. */
  private async fileExists(source: string, dir: string, fileName: string): Promise<boolean> {
    try {
      const picker = getFilePicker();
      const result: any = await picker.browse(source, dir, {});
      const files: any[] = Array.isArray(result?.files) ? result.files : [];
      const wanted = decodeURIComponent(fileName);
      return files.some(entry => {
        const path = typeof entry === 'string' ? entry : (entry?.path ?? '');
        return FilesHandlers.basename(path) === wanted;
      });
    } catch {
      // A directory that cannot be listed simply has nothing to overwrite
      return false;
    }
  }

  /** Strip leading and trailing slashes; an empty path means the Data root. */
  private static normalizeDir(dir: unknown, allowEmpty = false): string {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      if (allowEmpty) return '';
      throw new Error('dir is required');
    }
    const trimmed = dir.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (trimmed.split('/').includes('..')) {
      throw new Error('dir must not contain ".." segments');
    }
    return trimmed;
  }

  /** Last path segment, percent-decoded so Cyrillic names read back properly. */
  private static basename(path: string): string {
    const raw = path.split('/').pop() ?? path;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  /** Decode base64 (with or without a data: prefix) into raw bytes. */
  private static decodeBase64(input: string): Uint8Array {
    const commaIndex = input.startsWith('data:') ? input.indexOf(',') : -1;
    const payload = (commaIndex >= 0 ? input.slice(commaIndex + 1) : input).replace(/\s+/g, '');

    const decoder = (globalThis as any).atob;
    if (typeof decoder !== 'function') {
      throw new Error('base64 decoding is unavailable in this client');
    }

    let binary: string;
    try {
      binary = decoder(payload);
    } catch (error) {
      throw new Error(`fileData is not valid base64: ${describeError(error)}`);
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
