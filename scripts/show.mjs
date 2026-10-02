#!/usr/bin/env node
import { enrichHit } from './enrich-hits.mjs';
import { createClientFromOptions, parseCommand, runCommand } from './lib/cli.mjs';
import { createChannelResolver } from './lib/channels.mjs';
import { ensureOutputFile, sanitizeError, writeJsonAtomic } from './lib/io.mjs';
import { normalizeMessage } from './lib/records.mjs';

export const COMMAND = {
  name: 'show',
  summary: 'Show messages by Discord jump URL with surrounding messages, reply chain, attachments, and reaction counts.',
  usage: '<jump-url|channelId/messageId> ... [options]',
  positionals: 'required',
  positionalName: 'jump URL',
  discord: true,
  options: {
    context: { type: 'number', value: '<n>', description: 'messages to show before and after each target', default: 3 },
    output: { type: 'string', value: '<file>', description: 'also write the result JSON to this file' },
  },
};

const JUMP_URL = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/i;
const isId = (value) => /^\d+$/.test(value);
const LOCATION_FIELDS = ['guildId', 'guildName', 'channelId', 'channelName', 'threadId', 'threadName', 'parentChannelId', 'parentChannelName', 'forumTitle', 'threadRootId'];

export function parseMessageRef(value) {
  const text = String(value).trim();
  const url = JUMP_URL.exec(text);
  if (url) return { guildId: url[1] === '@me' ? null : url[1], channelId: url[2], messageId: url[3] };
  const parts = text.split('/').filter(Boolean);
  if (parts.length === 3 && parts.every(isId)) return { guildId: parts[0], channelId: parts[1], messageId: parts[2] };
  if (parts.length === 2 && parts.every(isId)) return { guildId: null, channelId: parts[0], messageId: parts[1] };
  throw new Error(`Not a Discord message link or channelId/messageId: ${text}`);
}

export async function showMessages({ client, refs, context = 3 } = {}) {
  const resolver = createChannelResolver(client);
  const results = [];
  for (const ref of refs) {
    try {
      // Names are a convenience; a channel lookup failure must not hide the message.
      const location = await resolver.location(ref.channelId).catch(() => null);
      const placed = normalizeMessage({ id: ref.messageId }, {
        guildId: ref.guildId ?? location?.guildId ?? null,
        guildName: location?.guildName ?? null,
        channelId: ref.channelId,
        channelName: location?.channelName ?? null,
        thread: location?.thread ?? null,
      });
      const hit = Object.fromEntries(LOCATION_FIELDS.map((field) => [field, placed[field]]));
      results.push(await enrichHit({ client, hit: { ...hit, messageId: ref.messageId }, before: context, after: context }));
    } catch (error) {
      if (error?.status === 401) throw error;
      results.push({ ref, error: sanitizeError(error) });
    }
  }
  return results;
}

if (process.argv[1]?.endsWith('show.mjs')) {
  const { values, positionals } = parseCommand(COMMAND);
  await runCommand(async () => {
    const refs = positionals.map(parseMessageRef);
    const client = createClientFromOptions(values);
    const results = await showMessages({ client, refs, context: values.context });
    if (values.output) writeJsonAtomic(ensureOutputFile(values.output), results);
    console.log(JSON.stringify(results, null, 2));
    if (results.some((result) => result.error)) process.exitCode = 1;
  });
}
