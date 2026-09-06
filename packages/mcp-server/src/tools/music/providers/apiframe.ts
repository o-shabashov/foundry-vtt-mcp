/**
 * apiframe.ai adapter.
 *
 * Docs: https://apiframe.ai/docs/music/suno, https://apiframe.ai/docs/music,
 * https://apiframe.ai/docs/jobs/get, https://apiframe.ai/docs/account/me.
 *
 * POST /v2/music/generate answers 202 with { jobId, status }, the Suno knobs live in
 * a nested "sunoParams" object, and GET /v2/jobs/:id walks QUEUED -> PROCESSING ->
 * COMPLETED with the two finished tracks in result.tracks.
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
  compact,
  requestJson,
  trimBaseUrl,
} from '../common.js';
import { Logger } from '../../../logger.js';

export const APIFRAME_DEFAULT_BASE_URL = 'https://api.apiframe.ai';

/** Job states that mean the generation is over and no track is coming. */
const FAILED_STATUS = /fail|error|cancel/i;

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Keep the entries that actually carry audio; a job in flight lists none. */
function toTracks(entries: unknown): MusicTrack[] {
  if (!Array.isArray(entries)) return [];

  const tracks: MusicTrack[] = [];
  for (const entry of entries) {
    const audioUrl = nonEmpty(entry?.audioUrl) ?? nonEmpty(entry?.audio_url);
    if (!audioUrl) continue;

    tracks.push({
      id: String(entry?.id ?? ''),
      title: String(entry?.title ?? ''),
      durationSec: toNumberOrNull(entry?.duration),
      audioUrl,
      imageUrl: nonEmpty(entry?.imageUrl) ?? nonEmpty(entry?.image_url),
      tags: nonEmpty(entry?.tags),
    });
  }
  return tracks;
}

export class ApiframeProvider implements MusicProvider {
  readonly name = 'apiframe';

  private apiKey: string;
  private baseUrl: string;
  private logger: Logger;

  constructor({ apiKey, baseUrl, logger }: MusicProviderOptions) {
    this.apiKey = apiKey;
    this.baseUrl = trimBaseUrl(baseUrl || APIFRAME_DEFAULT_BASE_URL);
    this.logger = logger.child({ component: 'ApiframeProvider' });
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey };
  }

  async generate(request: MusicRequest): Promise<MusicGenerateResult> {
    const warnings: string[] = [];
    if (request.durationSec !== undefined) {
      warnings.push(
        'apiframe has no track length parameter for Suno, "durationSec" was dropped. Use provider "sunoapi" for an explicit length.'
      );
    }

    const body = {
      model: 'suno',
      prompt: request.prompt,
      sunoParams: compact({
        custom_mode: request.customMode,
        instrumental: request.instrumental,
        model_version: request.model,
        title: request.title,
        style: request.style,
        negative_tags: request.negativeTags,
        vocal_gender: request.vocalGender,
        style_weight: request.styleWeight,
        weirdness_constraint: request.weirdness,
      }),
    };

    const answer = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/v2/music/generate`,
      method: 'POST',
      headers: this.headers(),
      body,
    });

    const taskId =
      nonEmpty(answer?.jobId) ??
      nonEmpty(answer?.id) ??
      nonEmpty(answer?.task_id) ??
      nonEmpty(answer?.taskId);
    if (!taskId) {
      throw new MusicProviderError('apiframe accepted the request without returning a job id');
    }

    this.logger.info('apiframe job submitted', { taskId, model: request.model });

    return { taskId, warnings };
  }

  async status(taskId: string): Promise<MusicTask> {
    const job = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/v2/jobs/${encodeURIComponent(taskId)}`,
      headers: this.headers(),
    });

    const jobStatus = String(job?.status ?? '');
    const tracks = toTracks(job?.result?.tracks ?? job?.tracks);

    let status: MusicTaskStatus = 'pending';
    let error: string | undefined;

    if (FAILED_STATUS.test(jobStatus)) {
      status = 'failed';
      error = nonEmpty(job?.error) ?? `apiframe job ${jobStatus || 'failed'}`;
    } else if (tracks.length > 0) {
      status = 'complete';
    } else if (/complete/i.test(jobStatus)) {
      status = 'failed';
      error = 'apiframe reported the job complete without any playable track';
    }

    return { provider: this.name, taskId, status, tracks, error, raw: job };
  }

  async credits(): Promise<number | null> {
    const me = await requestJson(this.name, this.logger, {
      url: `${this.baseUrl}/v2/me`,
      headers: this.headers(),
    });

    const balance = me?.team?.credits;
    return typeof balance === 'number' ? balance : null;
  }
}
