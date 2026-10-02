#!/usr/bin/env node
import { ensureOutputFile, readNdjson, loadJson, sanitizeError, writeJsonAtomic, writeNdjsonAtomic } from './lib/io.mjs';
import { normalizeMessage } from './lib/records.mjs';
import { createClientFromOptions, parseCommand, runCommand } from './lib/cli.mjs';

export const COMMAND = {
  name: 'enrich-hits',
  summary: 'Fetch surrounding messages, reply chains, and reaction counts for search hits or evidence candidates.',
  usage: '--input <file> --output <file> [options]',
  discord: true,
  options: {
    input: { type: 'string', value: '<file>', description: 'messages.ndjson, evidence.json, or a JSON array of hits', required: true },
    output: { type: 'string', value: '<file>', description: 'contexts NDJSON to write', required: true },
    errors: { type: 'string', value: '<file>', description: 'also write per-hit errors as JSON' },
    before: { type: 'number', value: '<n>', description: 'messages to keep before each hit', default: 4 },
    after: { type: 'number', value: '<n>', description: 'messages to keep after each hit', default: 4 },
    'max-hits': { type: 'number', value: '<n>', description: 'hits to enrich, in input order', default: 50 },
    window: { type: 'number', value: '<n>', description: 'messages fetched per request; nearby hits reuse a window', default: 50 },
  },
  notes: ['Use --before 0 --after 0 to collect reaction counts only.'],
};

const DEFAULT_WINDOW_SIZE = 50;

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.messages)) return payload.messages.flatMap((group) => Array.isArray(group) ? group : [group]);
  return [];
}

function asDiscordMessage(record = {}) {
  return {
    ...record,
    id: record.id ?? record.messageId,
    guild_id: record.guild_id ?? record.guildId,
    channel_id: record.channel_id ?? record.channelId,
    message_reference: record.message_reference ?? record.replyReference,
    author: record.author && typeof record.author === 'object'
      ? record.author
      : {
          id: record.authorId,
          username: record.authorUsername ?? record.author,
          global_name: record.author,
        },
  };
}

const LOCATION_FIELDS = ['guildId', 'guildName', 'channelId', 'channelName', 'threadId', 'threadName', 'parentChannelId', 'parentChannelName', 'forumTitle', 'threadRootId'];
const MESSAGE_FIELDS = ['messageId', 'timestamp', 'content', 'authorId', 'author', 'authorUsername', 'jumpUrl'];

// Context messages share the hit's channel and thread, but never its text or
// author: image-only posts must keep their empty body.
function normalizeContextRecord(record, hit, { fromHistory = true } = {}) {
  const normalized = normalizeMessage(asDiscordMessage(record), {
    guildId: record.guildId ?? hit.guildId,
    guildName: record.guildName ?? hit.guildName,
    channelId: record.channelId ?? hit.channelId,
    channelName: record.channelName ?? hit.channelName,
    // Channel history includes reactions whenever a message has any.
    reactionsKnown: fromHistory,
  });
  const merged = { ...normalized };
  for (const field of LOCATION_FIELDS) {
    if (merged[field] == null || merged[field] === '') merged[field] = record[field] ?? hit[field] ?? null;
  }
  for (const field of MESSAGE_FIELDS) {
    if ((merged[field] == null || merged[field] === '') && record[field] != null) merged[field] = record[field];
  }
  if (!fromHistory) merged.reactionCount = Number.isFinite(record.reactionCount) ? record.reactionCount : null;
  merged.matchedQueries = [];
  return merged;
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.guildId ?? ''}/${record.channelId ?? ''}/${record.messageId ?? ''}`;
    if (!record.messageId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareTimestamp(left, right) {
  const leftTime = Date.parse(left?.timestamp ?? '') || 0;
  const rightTime = Date.parse(right?.timestamp ?? '') || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left?.messageId ?? '').localeCompare(String(right?.messageId ?? ''));
}

function mergeTarget(hit, normalized) {
  const target = { ...hit, ...normalized };
  for (const field of ['guildName', 'channelName', 'timestamp', 'content', 'authorId', 'author', 'authorUsername', 'jumpUrl']) {
    if ((target[field] == null || target[field] === '') && hit[field] != null) target[field] = hit[field];
  }
  target.matchedQueries = [...new Set([...(hit.matchedQueries ?? []), ...(normalized.matchedQueries ?? [])].filter(Boolean))];
  target.isTarget = true;
  return target;
}

function buildReplyChain(target, records) {
  const byId = new Map(records.map((record) => [record.messageId, record]));
  const chain = [];
  const visited = new Set([target.messageId]);
  let nextId = target.replyReference?.messageId ?? null;
  while (nextId && !visited.has(nextId)) {
    visited.add(nextId);
    const record = byId.get(nextId);
    if (!record) break;
    chain.push({ ...record, isContext: true, relation: 'reply' });
    nextId = record.replyReference?.messageId ?? null;
  }
  return chain;
}

export async function enrichHit({ client, hit, before = 4, after = 4, now = new Date().toISOString(), window = null } = {}) {
  if (!window && !client?.fetchAround) throw new TypeError('client.fetchAround is required');
  if (!hit?.channelId || !hit?.messageId) throw new TypeError('hit.channelId and hit.messageId are required');

  const payload = window ?? await client.fetchAround(hit.channelId, hit.messageId, Math.min(100, Math.max(1, before + after + 1)));
  const rawRecords = asArray(payload);
  const normalized = uniqueRecords(rawRecords.map((record) => normalizeContextRecord(record, hit)));
  if (!normalized.some((record) => record.messageId === hit.messageId)) {
    normalized.push(normalizeContextRecord(hit, hit, { fromHistory: false }));
  }
  normalized.sort(compareTimestamp);

  const rawTarget = normalized.find((record) => record.messageId === hit.messageId)
    ?? normalizeContextRecord(hit, hit, { fromHistory: false });
  const target = mergeTarget(hit, rawTarget);
  const targetIndex = normalized.findIndex((record) => record.messageId === hit.messageId);
  const beforeRecords = normalized
    .slice(0, Math.max(targetIndex, 0))
    .slice(-Math.max(0, before))
    .map((record) => ({ ...record, isContext: true, relation: 'before' }));
  const afterRecords = normalized
    .slice(Math.max(targetIndex, 0) + 1, Math.max(targetIndex, 0) + 1 + Math.max(0, after))
    .map((record) => ({ ...record, isContext: true, relation: 'after' }));
  const threadRootId = target.threadRootId ?? null;
  const threadRootRecord = threadRootId
    ? normalized.find((record) => record.messageId === threadRootId) ?? { messageId: threadRootId, isContext: true, relation: 'thread-root' }
    : null;

  return {
    target,
    before: beforeRecords,
    after: afterRecords,
    replyChain: buildReplyChain(target, normalized),
    threadRoot: threadRootRecord,
    forumTitle: hit.forumTitle ?? target.forumTitle ?? null,
    fetchedAt: now,
  };
}

function idValue(message) {
  return /^\d+$/.test(message?.id ?? '') ? BigInt(message.id) : 0n;
}

// A cached window serves a hit only when it holds enough neighbors on both
// sides; each window is a contiguous slice of one channel, oldest first.
function reusableWindow(windows, hit, before, after) {
  for (const window of windows.get(hit.channelId) ?? []) {
    const index = window.findIndex((message) => message.id === hit.messageId);
    if (index >= before && window.length - 1 - index >= after) return window;
  }
  return null;
}

// Hits that sit close together share one ?around= request instead of one each,
// the batching discrub-core's resolveMessageReactions uses for search results.
export async function enrichHits({
  client,
  hits = [],
  before = 4,
  after = 4,
  maxHits = 50,
  windowSize = DEFAULT_WINDOW_SIZE,
  now = new Date().toISOString(),
  onHit,
} = {}) {
  const contexts = [];
  const errors = [];
  const windows = new Map();
  let requests = 0;
  for (const hit of hits.slice(0, Math.max(0, maxHits))) {
    try {
      let window = hit?.channelId && hit?.messageId ? reusableWindow(windows, hit, before, after) : null;
      if (!window && hit?.channelId && hit?.messageId) {
        const limit = Math.min(100, Math.max(windowSize, before + after + 1));
        requests += 1;
        window = asArray(await client.fetchAround(hit.channelId, hit.messageId, limit))
          .sort((left, right) => (idValue(left) < idValue(right) ? -1 : idValue(left) > idValue(right) ? 1 : 0));
        if (window.some((message) => message.id === hit.messageId)) {
          windows.set(hit.channelId, [...(windows.get(hit.channelId) ?? []), window]);
        }
      }
      const context = await enrichHit({ client, hit, before, after, now, window });
      contexts.push(context);
      await onHit?.(context);
    } catch (error) {
      errors.push({ messageId: hit?.messageId ?? null, error: sanitizeError(error) });
    }
  }
  return { contexts, errors, requests };
}

export function loadHits(inputPath) {
  try {
    const json = loadJson(inputPath, null);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.candidates)) return json.candidates;
  } catch {
    // Search output is NDJSON, which is not valid as one JSON document.
  }
  return readNdjson(inputPath);
}

if (process.argv[1]?.endsWith('enrich-hits.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const hits = loadHits(values.input);
    const client = createClientFromOptions(values);
    const result = await enrichHits({
      client,
      hits,
      before: values.before,
      after: values.after,
      maxHits: values['max-hits'],
      windowSize: values.window,
    });
    writeNdjsonAtomic(ensureOutputFile(values.output), result.contexts);
    if (values.errors) writeJsonAtomic(ensureOutputFile(values.errors), { errors: result.errors });
    console.log(JSON.stringify({ enriched: result.contexts.length, errors: result.errors.length, requests: result.requests }, null, 2));
    if (result.errors.length && !result.contexts.length) process.exitCode = 1;
  });
}
