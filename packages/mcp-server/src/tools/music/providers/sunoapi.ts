/**
 * sunoapi.org adapter.
 *
 * Docs: https://docs.sunoapi.org/suno-api/generate-music,
 * https://docs.sunoapi.org/suno-api/get-music-generation-details,
 * https://docs.sunoapi.org/suno-api/get-remaining-credits.
 *
 * Everything is a flat camelCase body over Bearer auth, and every answer is wrapped
 * in { code, msg, data } - the transport status stays 200 even when the service says
 * no, so the body code is what has to be checked. Track fields inside
 * data.response.sunoData are snake_case, unlike the request.
 */

import {
  MusicGenerateResult,
  MusicProvider,
  MusicProviderError,
  MusicProviderOptions,
  MusicRequest,
  MusicTask,
  MusicTaskStatus,
  MusicTrack,
  apiKeyVariable,
  compact,
  requestJson,
  trimBaseUrl,
  truncate,
} from '../common.js';
import { Logger } from '../../../logger.js';

export const SUNOAPI_DEFAULT_BASE_URL = 'https://api.sunoapi.org';

/** Task states of GET /api/v1/generate/record-info, mapped onto our four. */
const TASK_STATUS: Record<string, MusicTaskStatus> = {
  PENDING: 'pending',
  TEXT_SUCCESS: 'pending',
  FIRST_SUCCESS: 'partial',
  SUCCESS: 'complete',
  CREATE_TASK_FAILED: 'failed',
  GENERATE_AUDIO_FAILED: 'failed',
  CALLBACK_EXCEPTION: 'failed',
  SENSITIVE_WORD_ERROR: 'failed',
};

/** Body codes of the service, which are not HTTP status codes. */
function codeMessage(code: number, msg: string): string {
  const detail = msg ? ` - ${truncate(msg, 200)}` : '';
  switch (code) {
    case 400:
      return `sunoapi refused the parameters (code 400)${detail}`;
    case 401:
      return `sunoapi rejected the API key (code 401). Check ${apiKeyVariable('sunoapi')} on the machine running the MCP backend${detail}`;
    case 404:
      return `sunoapi knows no such path or method (code 404)${detail}`;
    case 405:
      return `sunoapi is rate limiting the account (code 405)${detail}`;
    case 413:
      return `sunoapi found the prompt or style too long (code 413)${detail}`;
    case 429:
      return `sunoapi has no credits left (code 429). Top up the account before generating again${detail}`;
    case 430:
      return `sunoapi is rate limiting the request (code 430). Wait a moment and retry${detail}`;
    case 455:
      return `sunoapi is down for maintenance (code 455)${detail}`;
    default:
      return `sunoapi refused the request (code ${code})${detail}`;
  }
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Keep the entries that carry a downloadable mp3; a half finished task lists one. */
function toTracks(entries: unknown): MusicTrack[] {
  if (!Array.isArray(entries)) return [];

  const tracks: MusicTrack[] = [];
  for (const entry of entries) {
    const audioUrl = nonEmpty(entry?.audio_url) ?? nonEmpty(entry?.audioUrl);
    if (!audioUrl) continue;

    tracks.push({
      id: String(entry?.id ?? ''),
      title: String(entry?.title ?? ''),
      durationSec: toNumberOrNull(entry?.duration),
      audioUrl,
      imageUrl: nonEmpty(entry?.image_url) ?? nonEmpty(entry?.imageUrl),
      tags: nonEmpty(entry?.tags),
    });
  }
  return tracks;
}

export class SunoApiProvider implements MusicProvider {
  readonly name = 'sunoapi';

  private apiKey: string;
  private baseUrl: string;
  private callbackUrl: string;
  private logger: Logger;

  constructor({ apiKey, baseUrl, callbackUrl, logger }: MusicProviderOptions) {
    this.apiKey = apiKey;
    this.baseUrl = trimBaseUrl(baseUrl || SUNOAPI_DEFAULT_BASE_URL);
    this.callbackUrl = callbackUrl;
    this.logger = logger.child({ component: 'SunoApiProvider' });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Unwrap { code, msg, data }, turning a non-200 code into a readable error. */
  private unwrap(answer: any): any {
    const code = Number(answer?.code);
    if (code !== 200) {
      throw new MusicProviderError(codeMessage(code, String(answer?.msg ?? '')), code);
    }
    return answer?.data;
  }

  async generate(request: MusicRequest): Promise<MusicGenerateResult> {
    const body = compact({
      customMode: request.customMode,
      instrumental: request.instrumental,
      prompt: request.prompt,
      style: request.style,
      title: request.title,
      model: request.model,
      negativeTags: request.negativeTags,
      vocalGender: request.vocalGender,
      styleWeight: request.styleWeight,
      weirdnessConstraint: request.weirdness,
      duration: request.durationSec,
      callBackUrl: this.callbackUrl,
    });

    const answer = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/api/v1/generate`,
      method: 'POST',
      headers: this.headers(),
      body,
    });

    const data = this.unwrap(answer);
    const taskId = nonEmpty(data?.taskId);
    if (!taskId) {
      throw new MusicProviderError('sunoapi accepted the request without returning a taskId');
    }

    this.logger.info('sunoapi task submitted', { taskId, model: request.model });

    return { taskId };
  }

  async status(taskId: string): Promise<MusicTask> {
    const answer = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      headers: this.headers(),
    });

    const data = this.unwrap(answer);
    const taskStatus = String(data?.status ?? '');
    const tracks = toTracks(data?.response?.sunoData);

    let status = TASK_STATUS[taskStatus];
    if (!status) status = /fail|error|exception/i.test(taskStatus) ? 'failed' : 'pending';

    const error =
      status === 'failed'
        ? (nonEmpty(data?.errorMessage) ?? `sunoapi task ${taskStatus || 'failed'}`)
        : undefined;

    return { provider: this.name, taskId, status, tracks, error, raw: data };
  }

  async credits(): Promise<number | null> {
    const answer = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/api/v1/generate/credit`,
      headers: this.headers(),
    });

    const balance = this.unwrap(answer);
    return typeof balance === 'number' ? balance : null;
  }
}
