/**
 * Shared building blocks for the music tools.
 *
 * Suno has no official API, so tracks come from proxy providers. They all work the
 * same way - create a task, poll it, download the mp3 - so the tools talk to one
 * MusicProvider interface and the adapters under providers/ translate it into the
 * shape of a concrete service.
 *
 * The HTTP helpers live here too: every adapter speaks JSON over the global fetch of
 * Node 18, and every adapter needs the same human readable wording for a rejected
 * key, an empty credit balance or a rate limit.
 */

import { Logger } from '../../logger.js';

export { compact } from '../session/common.js';

/** Proxy services this build knows how to talk to. */
export const MUSIC_PROVIDERS = ['apiframe', 'sunoapi'] as const;
export type MusicProviderName = (typeof MUSIC_PROVIDERS)[number];

/** Suno model versions both providers accept. */
export const MUSIC_MODELS = ['V4', 'V4_5', 'V4_5PLUS', 'V4_5ALL', 'V5', 'V5_5'] as const;
export type MusicModel = (typeof MUSIC_MODELS)[number];

export const VOCAL_GENDERS = ['m', 'f'] as const;
export type VocalGender = (typeof VOCAL_GENDERS)[number];

/** Model that accepts an explicit track length, and only in custom mode. */
export const DURATION_MODEL: MusicModel = 'V5_5';
export const MIN_DURATION_SEC = 10;
export const MAX_DURATION_SEC = 360;

export const DEFAULT_MODEL: MusicModel = 'V5';

/** What one generation asks for, already normalised by the tool layer. */
export interface MusicRequest {
  /** Description of the music, or the lyrics themselves in custom mode. */
  prompt: string;
  /** Genre, mood and instruments, up to 1000 characters. */
  style?: string | undefined;
  title?: string | undefined;
  instrumental: boolean;
  customMode: boolean;
  model: MusicModel;
  negativeTags?: string | undefined;
  vocalGender?: VocalGender | undefined;
  styleWeight?: number | undefined;
  weirdness?: number | undefined;
  durationSec?: number | undefined;
}

/** One finished track, plus the places the tools put a copy of it. */
export interface MusicTrack {
  id: string;
  title: string;
  durationSec: number | null;
  audioUrl: string;
  imageUrl?: string | undefined;
  tags?: string | undefined;
  /** Path inside the Foundry Data directory, filled in after the upload. */
  path?: string | undefined;
  /** Playlist the track was added to, filled in after the playlist step. */
  playlist?: string | undefined;
  /** Local copy written by the stdio wrapper when "outDir" was given. */
  localPath?: string | undefined;
}

export type MusicTaskStatus = 'pending' | 'partial' | 'complete' | 'failed';

export interface MusicTask {
  provider: string;
  taskId: string;
  status: MusicTaskStatus;
  tracks: MusicTrack[];
  error?: string | undefined;
  /** Provider payload, kept for the debug log and never returned to the client. */
  raw?: unknown;
}

export interface MusicGenerateResult {
  taskId: string;
  /** What the adapter had to drop, e.g. a length the provider does not accept. */
  warnings?: string[] | undefined;
}

export interface MusicProvider {
  readonly name: string;
  generate(request: MusicRequest): Promise<MusicGenerateResult>;
  status(taskId: string): Promise<MusicTask>;
  credits?(): Promise<number | null>;
}

// ── configuration ─────────────────────────────────────────────────────────────

export interface MusicProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface MusicConfig {
  provider: MusicProviderName;
  apiframe: MusicProviderCredentials;
  sunoapi: MusicProviderCredentials;
  /** sunoapi.org demands a callback URL; the tools poll instead, so this is a stub. */
  callbackUrl: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

/** Everything an adapter is constructed with. */
export interface MusicProviderOptions {
  apiKey: string;
  baseUrl: string;
  callbackUrl: string;
  logger: Logger;
}

// ── errors ────────────────────────────────────────────────────────────────────

/** Anything the provider itself refused, carrying the transport status when there is one. */
export class MusicProviderError extends Error {
  readonly status?: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MusicProviderError';
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Environment variable holding the key of a provider, used in error messages. */
export function apiKeyVariable(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/** Same wording for the handful of failures every provider can produce. */
export function httpErrorMessage(provider: string, status: number, detail: string): string {
  const suffix = detail ? ` - ${detail}` : '';
  switch (status) {
    case 401:
    case 403:
      return `${provider} rejected the API key (HTTP ${status}). Check ${apiKeyVariable(provider)} on the machine running the MCP backend${suffix}`;
    case 402:
      return `${provider} has no credits left (HTTP 402). Top up the account before generating again${suffix}`;
    case 404:
      return `${provider} knows no such task (HTTP 404)${suffix}`;
    case 429:
      return `${provider} is rate limiting the request (HTTP 429). Wait a moment and retry${suffix}`;
    default:
      if (status >= 500) {
        return `${provider} is having trouble (HTTP ${status}). This is on their side, retry later${suffix}`;
      }
      return `${provider} refused the request (HTTP ${status})${suffix}`;
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export interface JsonRequest {
  url: string;
  method?: 'GET' | 'POST' | undefined;
  headers?: Record<string, string> | undefined;
  body?: unknown;
}

/** Drop the trailing slashes of a base URL so paths can be appended blindly. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Pull the most useful sentence out of an error body. */
function detailOf(parsed: any, text: string): string {
  const candidate = parsed?.msg ?? parsed?.message ?? parsed?.error;
  if (typeof candidate === 'string' && candidate.trim().length > 0) return truncate(candidate, 200);
  return truncate(text.trim(), 200);
}

/**
 * One JSON round trip against a provider. Network failures, non-2xx answers and
 * bodies that are not JSON all come back as MusicProviderError with a message a
 * game master can act on.
 */
export async function requestJson(
  provider: string,
  logger: Logger,
  request: JsonRequest
): Promise<any> {
  const { url, method = 'GET', headers = {}, body } = request;

  const init: RequestInit =
    body === undefined
      ? { method, headers }
      : {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new MusicProviderError(`${provider} is unreachable: ${errorMessage(error)}`);
  }

  const text = await response.text();
  let parsed: any;
  let parsedOk = true;
  try {
    parsed = text.trim().length > 0 ? JSON.parse(text) : {};
  } catch {
    parsedOk = false;
  }

  if (!response.ok) {
    throw new MusicProviderError(
      httpErrorMessage(provider, response.status, detailOf(parsedOk ? parsed : undefined, text)),
      response.status
    );
  }
  if (!parsedOk) {
    throw new MusicProviderError(
      `${provider} answered with something other than JSON: ${truncate(text.trim(), 200)}`
    );
  }

  logger.debug('Music provider answered', { provider, url, body: truncate(text, 2000) });

  return parsed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
