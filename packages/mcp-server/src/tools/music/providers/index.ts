/**
 * Provider factory.
 *
 * The tools never name a service directly: the backend configuration picks one and a
 * single call may override it. A provider without a key is refused here, with the
 * environment variable to set, so the tool definitions stay listed even on a machine
 * that has no key at all.
 */

import { Logger } from '../../../logger.js';
import { MusicConfig, MusicProvider, MusicProviderName, apiKeyVariable } from '../common.js';
import { ApiframeProvider } from './apiframe.js';
import { SunoApiProvider } from './sunoapi.js';

export { ApiframeProvider } from './apiframe.js';
export { SunoApiProvider } from './sunoapi.js';

export function createMusicProvider(
  config: MusicConfig,
  logger: Logger,
  override?: MusicProviderName
): MusicProvider {
  const name = override ?? config.provider;
  const credentials = name === 'sunoapi' ? config.sunoapi : config.apiframe;

  if (!credentials.apiKey) {
    throw new Error(
      `Music provider "${name}" has no API key. Set ${apiKeyVariable(name)} on the machine running the MCP backend and restart it.`
    );
  }

  const options = {
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    callbackUrl: config.callbackUrl,
    logger,
  };

  return name === 'sunoapi' ? new SunoApiProvider(options) : new ApiframeProvider(options);
}
