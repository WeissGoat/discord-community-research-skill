#!/usr/bin/env node
import fs from 'node:fs';

import { createAbortBreaker, createClientFromOptions, exitCodeForAbort, parseCommand, runCommand } from './lib/cli.mjs';
import { createChannelResolver } from './lib/channels.mjs';
import { iterateHistory } from './lib/history.mjs';
import { appendNdjson, ensureOutputFile, loadJsonOrNdjson, sanitizeError } from './lib/io.mjs';
import { normalizeMessage } from './lib/records.mjs';

export const HARD_MAX_MESSAGES_PER_CHANNEL = 5000;
export const HARD_MAX_MESSAGES_PER_RUN = 50000;

export const COMMAND = {
  name: 'history',
  summary: 'Fetch the message history of channels, threads, or forum posts into NDJSON records that include reaction counts.',
  usage: '(--channel <id,...> | --channels-from <file>) --output <file> [options]',
  discord: true,
  options: {
    channel: { type: 'list', value: '<id,...>', description: 'channel, thread, or forum post ids' },
    'channels-from': { type: 'string', value: '<file>', description: 'threads.mjs output, or any JSON/NDJSON whose records have an id' },
    after: { type: 'string', value: '<date|id>', description: 'stop at this date or message id (exclusive)' },
    before: { type: 'string', value: '<date|id>', description: 'start below this date or message id' },
    'max-pages': { type: 'number', value: '<n>', description: 'pages of 100 messages per channel', default: 50 },
    'max-messages': { type: 'number', value: '<n>', description: 'messages per channel (capped at 5000)', default: HARD_MAX_MESSAGES_PER_CHANNEL },
    'max-total-messages': { type: 'number', value: '<n>', description: 'messages per run across all channels (capped at 50000)', default: HARD_MAX_MESSAGES_PER_RUN },
    output: { type: 'string', value: '<file>', description: 'NDJSON to write; records are appended page by page', required: true },
  },
  notes: [
    'Each channel ends complete (start of channel or the --after bound reached), truncated (a page or message limit), or failed.',
    'Only complete channels support claims that something was not posted there.',
    'The first HTTP 429 stops the run without retrying; wait at least retry_after, preferably until the next day, before resuming.',
  ],
};

function targetsFrom(values) {
  const targets = (values.channel ?? []).map((id) => ({ id, known: null }));
  if (values['channels-from']) {
    const input = loadJsonOrNdjson(values['channels-from']);
    const records = Array.isArray(input) ? input : input?.threads ?? input?.channels ?? [];
    for (const record of records) {
      const id = record?.id ?? record?.threadId ?? record?.channelId;
      if (id) targets.push({ id: String(id), known: record });
    }
  }
  const seen = new Set();
  return targets.filter((target) => !seen.has(target.id) && seen.add(target.id));
}

export async function collectHistory({
  client,
  targets,
  outputPath,
  after = null,
  before = null,
  maxPages = 50,
  maxMessages = HARD_MAX_MESSAGES_PER_CHANNEL,
  maxTotalMessages = HARD_MAX_MESSAGES_PER_RUN,
  onProgress = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  // Callers cannot raise the ceiling by passing a larger number.
  const channelLimit = Math.min(HARD_MAX_MESSAGES_PER_CHANNEL, Math.max(1, Math.floor(Number(maxMessages) || HARD_MAX_MESSAGES_PER_CHANNEL)));
  const runLimit = Math.min(HARD_MAX_MESSAGES_PER_RUN, Math.max(1, Math.floor(Number(maxTotalMessages) || HARD_MAX_MESSAGES_PER_RUN)));
  const resolver = createChannelResolver(client);
  const breaker = createAbortBreaker();
  const channels = [];
  let totalMessages = 0;
  for (const target of targets) {
    if (breaker.aborted || totalMessages >= runLimit) {
      channels.push({
        channelId: target.id,
        status: 'pending',
        reason: breaker.aborted ? breaker.aborted.reason : 'max-total-messages',
      });
      continue;
    }
    const allowance = Math.max(0, Math.min(channelLimit, runLimit - totalMessages));
    const summary = { channelId: target.id, name: target.known?.name ?? null, status: 'running', stopReason: null, pages: 0, messages: 0, oldestTimestamp: null, error: null };
    channels.push(summary);
    try {
      const location = await resolver.location(target.id, target.known);
      summary.name = location.thread?.name ?? location.name;
      summary.guildId = location.guildId;
      for await (const page of iterateHistory({ client, channelId: target.id, after, before, maxPages, maxMessages: allowance })) {
        for (const message of page.messages) {
          appendNdjson(outputPath, normalizeMessage(message, {
            guildId: location.guildId,
            guildName: location.guildName,
            channelId: target.id,
            channelName: location.channelName,
            thread: location.thread,
            // History payloads carry reactions whenever a message has any.
            reactionsKnown: true,
          }));
        }
        summary.pages += 1;
        summary.messages = page.fetchedCount;
        summary.oldestTimestamp = page.oldestTimestamp ?? summary.oldestTimestamp;
        summary.stopReason = page.stopReason;
        if (page.stopReason) summary.status = page.complete ? 'complete' : 'truncated';
      }
      totalMessages += summary.messages;
      if (summary.stopReason === 'max-messages' && allowance < channelLimit) summary.stopReason = 'max-total-messages';
      onProgress(`[history] ${summary.name ?? target.id}: ${summary.status} (${summary.stopReason}); ${summary.messages} messages`);
      breaker.record(null);
    } catch (error) {
      // Pages written before the failure still count toward the run budget.
      totalMessages += summary.messages;
      summary.status = 'failed';
      summary.error = sanitizeError(error);
      onProgress(`[history] ${summary.name ?? target.id}: failed (${summary.error.status ?? summary.error.message})`);
      breaker.record(error);
    }
  }
  const count = (status) => channels.filter((channel) => channel.status === status).length;
  return {
    output: outputPath,
    channels,
    totals: {
      channels: channels.length,
      complete: count('complete'),
      truncated: count('truncated'),
      failed: count('failed'),
      pending: count('pending'),
      messages: totalMessages,
      maxTotalMessages: runLimit,
      atTotalCap: totalMessages >= runLimit,
    },
    aborted: breaker.aborted,
  };
}

if (process.argv[1]?.endsWith('history.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const targets = targetsFrom(values);
    if (!targets.length) throw new Error('Pass --channel or --channels-from with at least one id');
    const client = createClientFromOptions(values);
    fs.writeFileSync(ensureOutputFile(values.output), '', 'utf8');
    const result = await collectHistory({
      client,
      targets,
      outputPath: values.output,
      after: values.after,
      before: values.before,
      maxPages: values['max-pages'],
      maxMessages: values['max-messages'] ?? HARD_MAX_MESSAGES_PER_CHANNEL,
      maxTotalMessages: values['max-total-messages'] ?? HARD_MAX_MESSAGES_PER_RUN,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.aborted ? exitCodeForAbort(result.aborted) : result.totals.failed ? 1 : 0;
  });
}
