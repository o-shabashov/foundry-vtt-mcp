#!/usr/bin/env node
// Generate a Suno track through the MCP music tools and file it away.
//
//   node scripts/music-gen.mjs "<prompt>" [--title=...] [--style=...] [--vocals] [--model=V5]
//        [--target-dir=...] [--playlist=...] [--out=./dir] [--file-name=...] [--no-wait]
//   node scripts/music-gen.mjs --status=<taskId> [--target-dir=...] [--playlist=...] [--out=./dir]
//   node scripts/music-gen.mjs --credits
//
//   node scripts/music-gen.mjs "dark ambient, low strings, slow" --title="Ozhog" \
//        --target-dir="worlds/pepel/sessions/Session 15" --playlist="S15" --out=./assets
//
// Waiting is done here rather than inside one long tool call: the task is submitted,
// polled every few seconds with progress on stderr, then collected with music-status,
// which is also what uploads the tracks and fills the playlist.
//
// Requires the MCP bridge to be reachable (same as scripts/mcp-call.mjs).

import { createClient } from './lib/mcp-client.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const prompt = argv.find(a => !a.startsWith('--'));
const statusTaskId = option('status');
const wantCredits = flag('credits');

if (!prompt && !statusTaskId && !wantCredits) {
  console.error('usage: music-gen.mjs "<prompt>" [--title=] [--style=] [--vocals] [--model=V5] [--target-dir=] [--playlist=] [--out=] [--file-name=] [--no-wait]');
  console.error('       music-gen.mjs --status=<taskId> [--target-dir=] [--playlist=] [--out=]');
  console.error('       music-gen.mjs --credits');
  process.exit(2);
}

const POLL_MS = Number(option('poll') ?? process.env.MUSIC_POLL_INTERVAL_MS ?? 5000);
const TIMEOUT_MS = Number(process.env.MUSIC_TIMEOUT_MS ?? 300000);

const log = (...a) => console.error(...a);
const number = value => (value === undefined ? undefined : Number(value));

/** Where a finished track goes; the same keys for generate-music and music-status. */
const delivery = {
  targetDir: option('target-dir'),
  fileName: option('file-name'),
  playlist: option('playlist'),
  outDir: option('out'),
  provider: option('provider'),
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const client = await createClient({ timeoutMs: 300000 });

/** Progress lines for whatever the backend managed to store. */
function report(answer) {
  for (const track of answer?.tracks ?? []) {
    if (track.path) log(`uploaded ${track.path}`);
    if (track.localPath) log(`saved ${track.localPath}`);
  }
  for (const warning of answer?.warnings ?? []) log(`warning: ${warning}`);
}

try {
  if (wantCredits) {
    const answer = await client.call('music-credits', delivery.provider ? { provider: delivery.provider } : {});
    console.log(JSON.stringify(answer, null, 2));
  } else {
    let taskId = statusTaskId;
    let submittedOnly = null;

    if (!taskId) {
      const submitted = await client.call('generate-music', {
        prompt,
        title: option('title'),
        style: option('style'),
        instrumental: !flag('vocals'),
        model: option('model'),
        negativeTags: option('negative-tags'),
        vocalGender: option('vocal-gender'),
        styleWeight: number(option('style-weight')),
        weirdness: number(option('weirdness')),
        durationSec: number(option('duration')),
        wait: false,
        ...delivery,
      });
      taskId = submitted.taskId;
      log(`task ${taskId} (${submitted.provider})`);
      for (const warning of submitted.warnings ?? []) log(`warning: ${warning}`);

      if (flag('no-wait')) submittedOnly = submitted;
    }

    if (submittedOnly) {
      console.log(JSON.stringify(submittedOnly, null, 2));
    } else {
      await collect(taskId);
    }
  }
} finally {
  client.close();
}

/** Poll until the tracks are ready, then run music-status once more to file them away. */
async function collect(taskId) {
  // Poll without the delivery options so nothing is uploaded half finished.
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  let status = 'pending';

  while (status !== 'complete') {
    if (Date.now() - started > TIMEOUT_MS) {
      log(`giving up after ${seconds()}s; the task keeps running, collect it with --status=${taskId}`);
      break;
    }
    await sleep(POLL_MS);
    const answer = await client.call('music-status', { taskId, provider: delivery.provider });
    status = answer.status;
    log(`${status} ... ${seconds()}s`);
  }

  const answer = await client.call('music-status', { taskId, ...delivery });
  report(answer);
  console.log(JSON.stringify(answer, null, 2));
}
