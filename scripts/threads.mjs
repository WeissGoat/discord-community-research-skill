#!/usr/bin/env node
import { timestampFromSnowflake } from './lib/api.mjs';
import { createAbortBreaker, createClientFromOptions, exitCodeForAbort, parseCommand, runCommand } from './lib/cli.mjs';
import { createChannelResolver } from './lib/channels.mjs';
import { ensureOutputFile, sanitizeError, writeJsonAtomic } from './lib/io.mjs';
import { FORUM_CHANNEL_TYPES, normalizeMessage } from './lib/records.mjs';

export const COMMAND = {
  name: 'threads',
  summary: 'List the threads and forum posts of channels, archived ones included, with titles, dates, tags, and forum starter messages.',
  usage: '(--channel <id,...> | --guild <id>) --output <file> [options]',
  discord: true,
  options: {
    channel: { type: 'list', value: '<id,...>', description: 'forum, media, or text channel ids' },
    guild: { type: 'string', value: '<id>', description: 'list the active threads of a whole server (archived ones need --channel)' },
    after: { type: 'string', value: '<date>', description: 'skip threads with no activity since this date' },
    name: { type: 'string', value: '<text>', description: 'match forum post titles (forum and media channels only)' },
    'max-threads': { type: 'number', value: '<n>', description: 'threads per channel', default: 1000 },
    output: { type: 'string', value: '<file>', description: 'JSON file with channel summaries and thread records', required: true },
  },
  notes: ['Pass the output to history.mjs --channels-from to read every listed thread.'],
};

const FORUM_PAGE_SIZE = 25;
const ARCHIVE_PAGE_SIZE = 100;
const NO_ACCESS_STATUSES = new Set([403, 404]);

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function lastActivity(thread) {
  const times = [
    timestampFromSnowflake(thread?.last_message_id),
    thread?.thread_metadata?.archive_timestamp,
    thread?.thread_metadata?.create_timestamp,
    timestampFromSnowflake(thread?.id),
  ].map(time).filter((value) => value != null);
  return times.length ? Math.max(...times) : null;
}

function threadRecord(thread, parent, starter) {
  const guildId = thread.guild_id ?? parent.guildId ?? null;
  const tagNames = new Map((parent.availableTags ?? []).map((tag) => [tag.id, tag.name]));
  const location = { id: thread.id, name: thread.name ?? null, parentId: thread.parent_id ?? parent.id, parentName: parent.name ?? null, parentType: parent.type ?? null };
  return {
    id: thread.id,
    name: thread.name ?? null,
    type: thread.type ?? null,
    guildId,
    guildName: parent.guildName ?? null,
    parentId: location.parentId,
    parentName: location.parentName,
    parentType: location.parentType,
    createdAt: thread.thread_metadata?.create_timestamp ?? timestampFromSnowflake(thread.id),
    lastMessageAt: timestampFromSnowflake(thread.last_message_id),
    archived: thread.thread_metadata?.archived === true,
    archiveTimestamp: thread.thread_metadata?.archive_timestamp ?? null,
    locked: thread.thread_metadata?.locked === true,
    messageCount: thread.message_count ?? null,
    ownerId: thread.owner_id ?? null,
    tags: (thread.applied_tags ?? []).map((id) => tagNames.get(id) ?? id),
    jumpUrl: guildId ? `https://discord.com/channels/${guildId}/${thread.id}` : null,
    firstMessage: starter
      ? normalizeMessage(starter, { guildId, guildName: parent.guildName ?? null, channelId: thread.id, thread: location })
      : null,
  };
}

// Forum and media posts come from the search endpoint Discord's client uses,
// newest activity first. Pinned posts can sort above that order, so a page
// only ends the walk when every post on it is older than the cutoff.
async function listForumPosts({ client, parent, after, name, maxThreads }) {
  const threads = [];
  const starters = new Map();
  let offset = 0;
  let totalResults = null;
  let stopReason = null;
  while (!stopReason) {
    const page = await client.searchThreads(parent.id, { offset, limit: FORUM_PAGE_SIZE, name });
    const batch = Array.isArray(page?.threads) ? page.threads : [];
    totalResults = page?.total_results ?? totalResults;
    for (const message of page?.first_messages ?? []) starters.set(message.channel_id ?? message.id, message);
    const recent = after == null ? batch : batch.filter((thread) => (lastActivity(thread) ?? 0) >= after);
    const room = Math.max(0, maxThreads - threads.length);
    threads.push(...recent.slice(0, room));
    if (recent.length > room || (threads.length >= maxThreads && page?.has_more)) stopReason = 'max-threads';
    else if (after != null && batch.length && !recent.length) stopReason = 'after-bound';
    else if (!page?.has_more || !batch.length) stopReason = 'end';
    offset += batch.length;
  }
  return { threads, starters, stopReason, totalResults, notes: [] };
}

async function pagedArchive({ client, channelId, scope, after, cursorOf }) {
  const threads = [];
  let before = null;
  while (true) {
    const page = await client.archivedThreads(channelId, { scope, before, limit: ARCHIVE_PAGE_SIZE });
    const batch = Array.isArray(page?.threads) ? page.threads : [];
    threads.push(...batch);
    if (!page?.has_more || !batch.length) return { threads, stopReason: 'end' };
    const oldest = batch.reduce((result, thread) => (!result || (lastActivity(thread) ?? 0) < (lastActivity(result) ?? 0) ? thread : result), null);
    if (after != null && (lastActivity(oldest) ?? 0) < after) return { threads, stopReason: 'after-bound' };
    before = cursorOf(oldest, batch);
  }
}

// Text channels: active threads come from a server-wide endpoint; archived
// public threads and private threads the user joined are paged per channel.
async function listChannelThreads({ client, parent, after, maxThreads, activeThreads }) {
  const found = new Map();
  const notes = [];
  let partial = false;
  try {
    for (const thread of await activeThreads(parent.guildId)) if (thread.parent_id === parent.id) found.set(thread.id, thread);
  } catch (error) {
    if (error?.status === 401) throw error;
    partial = true;
    notes.push(`active threads unavailable: ${error?.message ?? error}`);
  }
  const publicArchive = await pagedArchive({
    client, channelId: parent.id, scope: 'public', after, cursorOf: (oldest) => oldest?.thread_metadata?.archive_timestamp ?? null,
  });
  for (const thread of publicArchive.threads) found.set(thread.id, thread);
  try {
    const joined = await pagedArchive({
      client,
      channelId: parent.id,
      scope: 'joined',
      after,
      cursorOf: (_oldest, batch) => batch.reduce((lowest, thread) => (!lowest || BigInt(thread.id) < BigInt(lowest) ? thread.id : lowest), null),
    });
    for (const thread of joined.threads) found.set(thread.id, thread);
  } catch (error) {
    if (!NO_ACCESS_STATUSES.has(error?.status)) throw error;
    notes.push('private archived threads: no access');
  }
  const recent = [...found.values()]
    .filter((thread) => after == null || (lastActivity(thread) ?? 0) >= after)
    .sort((left, right) => (lastActivity(right) ?? 0) - (lastActivity(left) ?? 0));
  const truncated = recent.length > maxThreads;
  return {
    threads: recent.slice(0, maxThreads),
    starters: new Map(),
    stopReason: truncated ? 'max-threads' : partial ? 'partial' : publicArchive.stopReason,
    totalResults: null,
    notes,
  };
}

export async function listThreads({ client, channelIds = [], guildId = null, after = null, name = null, maxThreads = 1000, onProgress = () => {} } = {}) {
  const resolver = createChannelResolver(client);
  const breaker = createAbortBreaker();
  const cutoff = after == null ? null : time(after);
  if (after != null && cutoff == null) throw new Error(`--after is not a date: ${after}`);
  const activeByGuild = new Map();
  const activeThreads = (id) => {
    if (!activeByGuild.has(id)) activeByGuild.set(id, client.activeThreads(id).then((data) => data?.threads ?? []));
    return activeByGuild.get(id);
  };
  const channels = [];
  const threads = [];

  if (guildId) {
    const summary = { channelId: null, guildId, scope: 'guild-active', status: 'running', threads: 0, error: null };
    channels.push(summary);
    try {
      const parents = new Map(((await client.inventoryChannels(guildId)) ?? []).map((channel) => [channel.id, channel]));
      const guildName = await resolver.guildName(guildId);
      for (const thread of await activeThreads(guildId)) {
        if (cutoff != null && (lastActivity(thread) ?? 0) < cutoff) continue;
        const parentChannel = parents.get(thread.parent_id) ?? {};
        threads.push(threadRecord(thread, { id: thread.parent_id, name: parentChannel.name ?? null, type: parentChannel.type ?? null, guildId, guildName, availableTags: parentChannel.available_tags }, null));
        summary.threads += 1;
      }
      summary.status = 'complete';
      breaker.record(null);
    } catch (error) {
      summary.status = 'failed';
      summary.error = sanitizeError(error);
      breaker.record(error);
    }
  }

  for (const channelId of channelIds) {
    if (breaker.aborted) {
      channels.push({ channelId, status: 'pending' });
      continue;
    }
    const summary = { channelId, name: null, type: null, status: 'running', stopReason: null, threads: 0, totalResults: null, notes: [], error: null };
    channels.push(summary);
    try {
      const parent = await resolver.location(channelId);
      Object.assign(summary, { name: parent.name, type: parent.type, guildId: parent.guildId });
      const listed = FORUM_CHANNEL_TYPES.has(parent.type)
        ? await listForumPosts({ client, parent, after: cutoff, name, maxThreads })
        : await listChannelThreads({ client, parent, after: cutoff, maxThreads, activeThreads });
      for (const thread of listed.threads) threads.push(threadRecord(thread, parent, listed.starters.get(thread.id)));
      Object.assign(summary, {
        status: listed.stopReason === 'max-threads' ? 'truncated' : listed.stopReason === 'partial' ? 'partial' : 'complete',
        stopReason: listed.stopReason,
        threads: listed.threads.length,
        totalResults: listed.totalResults,
        notes: listed.notes,
      });
      onProgress(`[threads] ${summary.name ?? channelId}: ${summary.threads} threads (${summary.status})`);
      breaker.record(null);
    } catch (error) {
      summary.status = 'failed';
      summary.error = sanitizeError(error);
      onProgress(`[threads] ${summary.name ?? channelId}: failed (${summary.error.status ?? summary.error.message})`);
      breaker.record(error);
    }
  }

  const count = (status) => channels.filter((channel) => channel.status === status).length;
  return {
    generatedAt: new Date().toISOString(),
    channels,
    threads,
    totals: {
      channels: channels.length,
      threads: threads.length,
      complete: count('complete'),
      truncated: count('truncated'),
      partial: count('partial'),
      failed: count('failed'),
      pending: count('pending'),
    },
    aborted: breaker.aborted,
  };
}

if (process.argv[1]?.endsWith('threads.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    if (!values.channel?.length && !values.guild) throw new Error('Pass --channel or --guild');
    const client = createClientFromOptions(values);
    const result = await listThreads({
      client,
      channelIds: values.channel ?? [],
      guildId: values.guild,
      after: values.after,
      name: values.name,
      maxThreads: values['max-threads'],
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    writeJsonAtomic(ensureOutputFile(values.output), result);
    const { threads, ...summary } = result;
    console.log(JSON.stringify({ output: values.output, ...summary }, null, 2));
    process.exitCode = result.aborted ? exitCodeForAbort(result.aborted) : result.totals.failed ? 1 : 0;
  });
}
