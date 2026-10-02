import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordApiError, createDiscordClient, snowflakeFromDate, validateSearchCriteria } from '../scripts/lib/api.mjs';
import { formatUsage, parseOptions, UsageError } from '../scripts/lib/cli.mjs';
import { iterateHistory } from '../scripts/lib/history.mjs';
import { createRunDirectory, readNdjson, SKILL_DIR } from '../scripts/lib/io.mjs';
import { enrichHits } from '../scripts/enrich-hits.mjs';
import { collectHistory } from '../scripts/history.mjs';
import { runSearchPlan } from '../scripts/run-search-plan.mjs';
import { parseMessageRef, showMessages } from '../scripts/show.mjs';
import { listThreads } from '../scripts/threads.mjs';

const SCRIPTS = path.join(SKILL_DIR, 'scripts');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-research-commands-'));
}

function minuteId(minute) {
  return snowflakeFromDate(new Date(Date.UTC(2026, 7, 1) + minute * 60000));
}

function historyMessage(minute, extra = {}) {
  return { id: minuteId(minute), timestamp: new Date(Date.UTC(2026, 7, 1) + minute * 60000).toISOString(), content: `message ${minute}`, author: { id: 'a1', username: 'author' }, attachments: [], embeds: [], ...extra };
}

// Serves channel history the way Discord does: newest first, `before` exclusive.
function historyClient(messagesByChannel, { channels = {}, failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    async inventoryGuilds() {
      return [{ id: 'g1', name: 'AI Guild' }];
    },
    async getChannel(id) {
      if (!channels[id]) throw new DiscordApiError('Unknown Channel', { status: 404 });
      return channels[id];
    },
    async fetchMessages(channelId, { before, limit }) {
      calls.push({ channelId, before: before ?? null });
      const failure = failures[`${channelId}:${calls.filter((call) => call.channelId === channelId).length}`];
      if (failure) throw failure;
      return (messagesByChannel[channelId] ?? [])
        .filter((message) => !before || BigInt(message.id) < BigInt(before))
        .sort((left, right) => (BigInt(right.id) > BigInt(left.id) ? 1 : -1))
        .slice(0, limit);
    },
  };
}

test('command options are strict, typed, and documented', () => {
  const spec = {
    name: 'demo',
    summary: 'Demo command.',
    discord: true,
    options: {
      plan: { type: 'string', value: '<file>', description: 'plan', required: true },
      'max-hits': { type: 'number', value: '<n>', description: 'hits', default: 20 },
      terms: { type: 'list', value: '<a,b>', description: 'terms' },
      'no-enrich': { type: 'boolean', description: 'skip' },
    },
  };
  const { values } = parseOptions(spec, ['--plan', 'p.json', '--max-hits', '5', '--terms', 'a, b', '--terms', 'c', '--no-enrich']);
  assert.deepEqual(values, { plan: 'p.json', 'max-hits': 5, terms: ['a', 'b', 'c'], 'no-enrich': true, 'env-file': undefined, 'token-env': undefined, 'base-url': undefined });
  assert.equal(parseOptions(spec, ['--plan', 'p.json'])['values']['max-hits'], 20);
  assert.throws(() => parseOptions(spec, ['--plan', 'p.json', '--outputRoot', 'x']), (error) => error instanceof UsageError && /--outputRoot/.test(error.message));
  assert.throws(() => parseOptions(spec, []), /--plan is required/);
  assert.throws(() => parseOptions(spec, ['--plan', 'p', '--max-hits', 'many']), /expects a number/);
  assert.equal(parseOptions(spec, ['--help']).help, true);
  const usage = formatUsage(spec);
  assert.match(usage, /--max-hits <n>\s+hits \(default 20\)/);
  assert.match(usage, /--plan <file>\s+plan \(required\)/);
  assert.match(usage, /Exit codes: 0 done, 1 failed, 2 Discord rejected the token, 3 network or proxy failure/);
});

test('every command prints help and rejects a misspelled flag before doing any work', () => {
  for (const script of fs.readdirSync(SCRIPTS).filter((file) => file.endsWith('.mjs'))) {
    const help = spawnSync(process.execPath, [path.join(SCRIPTS, script), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, `${script} --help exited ${help.status}: ${help.stderr}`);
    assert.match(help.stdout, new RegExp(`Usage: node <skill-dir>/scripts/${script}`));
  }
  const typo = spawnSync(process.execPath, [path.join(SCRIPTS, 'history.mjs'), '--chanel', '1', '--output', 'x.ndjson'], { encoding: 'utf8', cwd: makeTempRoot() });
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /--chanel/);
  assert.match(typo.stderr, /Usage:/);
});

test('search criteria map to every Discord filter and reject typos before any request', async () => {
  const urls = [];
  const client = createDiscordClient({
    token: 'token',
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ total_results: 0, messages: [] }) };
    },
  });
  await client.searchPage('g1', {
    content: 'lora',
    authorIds: ['1', '2'],
    authorType: '-bot',
    has: ['image', '-link'],
    channelId: '3',
    linkHostname: 'civitai.com',
    attachmentExtension: ['png', 'webp'],
    repliedToMessageId: '4',
    embedType: 'image',
    pinned: false,
    mentionEveryone: true,
  });
  const params = urls[0].searchParams;
  assert.deepEqual(params.getAll('author_id'), ['1', '2']);
  assert.deepEqual(params.getAll('has'), ['image', '-link']);
  assert.deepEqual(params.getAll('attachment_extension'), ['png', 'webp']);
  assert.deepEqual(
    ['author_type', 'channel_id', 'link_hostname', 'replied_to_message_id', 'embed_type', 'pinned', 'mention_everyone', 'include_nsfw'].map((key) => params.get(key)),
    ['-bot', '3', 'civitai.com', '4', 'image', 'false', 'true', 'true'],
  );

  assert.equal(validateSearchCriteria({ sortBy: 'relevance', minDate: '2026-08-01' }).sortBy, 'relevance');
  assert.throws(() => validateSearchCriteria({ author: '1' }), /unknown search criteria "author"/);
  assert.throws(() => validateSearchCriteria({ has: ['images'] }), /has value "images" is not one of/);
  assert.throws(() => validateSearchCriteria({ slop: 101 }), /slop must be an integer from 0 to 100/);
  assert.throws(() => validateSearchCriteria({ pinned: 'yes' }), /pinned must be true or false/);
});

test('plan-level criteria reach every query and invalid criteria fail before searching', async () => {
  const root = makeTempRoot();
  const searched = [];
  const client = {
    async searchPage(guildId, criteria) {
      searched.push(criteria);
      return { total_results: 0, messages: [] };
    },
  };
  const plan = {
    runId: 'criteria-run',
    guilds: [{ id: 'g1' }],
    criteria: { has: ['image'], attachmentExtension: ['png'] },
    queries: [
      { id: 'q1', content: 'novelai' },
      { id: 'q2', content: 'comfyui', criteria: { has: ['file'] } },
    ],
  };
  await runSearchPlan({ client, plan, runDir: createRunDirectory({ outputRoot: root, runId: 'criteria-run' }) });
  assert.deepEqual(searched.map((criteria) => [criteria.has, criteria.attachmentExtension]), [[['image'], ['png']], [['file'], ['png']]]);

  searched.length = 0;
  const bad = { ...plan, runId: 'bad-run', queries: [{ id: 'q1', content: 'x', criteria: { hass: ['image'] } }] };
  await assert.rejects(runSearchPlan({ client, plan: bad, runDir: createRunDirectory({ outputRoot: root, runId: 'bad-run' }) }), /Query q1: Invalid search criteria: unknown search criteria "hass"/);
  assert.equal(searched.length, 0);
});

test('an output root that already names the run is used as the run directory', () => {
  const root = makeTempRoot();
  const direct = createRunDirectory({ outputRoot: path.join(root, 'nai-v5'), runId: 'nai-v5', env: {} });
  assert.equal(direct.directory, path.join(root, 'nai-v5'));
  fs.mkdirSync(path.join(root, 'legacy', 'legacy'), { recursive: true });
  const legacy = createRunDirectory({ outputRoot: path.join(root, 'legacy'), runId: 'legacy', env: {} });
  assert.equal(legacy.directory, path.join(root, 'legacy', 'legacy'));
});

test('history walks newest to oldest and reports why it stopped', async () => {
  const messages = { c1: Array.from({ length: 150 }, (_, minute) => historyMessage(minute)) };
  const walk = async (options) => {
    const pages = [];
    for await (const page of iterateHistory({ client: historyClient(messages), channelId: 'c1', ...options })) pages.push(page);
    return pages;
  };

  const full = await walk({});
  assert.deepEqual(full.map((page) => page.messages.length), [100, 50]);
  assert.equal(full.at(-1).stopReason, 'start-of-channel');
  assert.equal(full.at(-1).complete, true);

  const bounded = await walk({ after: new Date(Date.UTC(2026, 7, 1) + 120 * 60000).toISOString() });
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0].messages.length, 29);
  assert.equal(bounded[0].stopReason, 'after-bound');
  assert.equal(bounded[0].complete, true);

  const limited = await walk({ maxPages: 1 });
  assert.deepEqual([limited[0].stopReason, limited[0].complete], ['max-pages', false]);
  const capped = await walk({ maxMessages: 30 });
  assert.deepEqual([capped[0].messages.length, capped[0].stopReason], [30, 'max-messages']);
});

test('a failed history page fails the channel instead of looking like its start', async () => {
  const root = makeTempRoot();
  const output = path.join(root, 'history.ndjson');
  const client = historyClient(
    {
      t1: [historyMessage(1, { reactions: [{ count: 3, emoji: { name: '🔥' } }], attachments: [{ id: 'att1', filename: 'a.png', width: 832, height: 1216 }] }), historyMessage(2)],
      c2: Array.from({ length: 120 }, (_, minute) => historyMessage(minute)),
    },
    {
      channels: {
        t1: { id: 't1', type: 11, name: 'NAI V5 showcase', parent_id: 'f1', guild_id: 'g1' },
        f1: { id: 'f1', type: 15, name: 'showcase' },
        c2: { id: 'c2', type: 0, name: 'general', guild_id: 'g1' },
      },
      failures: { 'c2:2': new DiscordApiError('Discord request failed with HTTP 503', { status: 503, retryable: true }) },
    },
  );
  const result = await collectHistory({ client, targets: [{ id: 't1' }, { id: 'c2' }], outputPath: output, onProgress: () => {} });

  assert.deepEqual(result.channels.map((channel) => [channel.channelId, channel.status, channel.messages]), [['t1', 'complete', 2], ['c2', 'failed', 100]]);
  assert.equal(result.channels[1].error.status, 503);
  const records = readNdjson(output);
  assert.equal(records.length, 102);
  const post = records.find((record) => record.channelId === 't1' && record.attachments.length);
  assert.deepEqual(
    [post.guildName, post.forumTitle, post.parentChannelName, post.reactionCount, post.attachments[0].id],
    ['AI Guild', 'NAI V5 showcase', 'showcase', 3, 'att1'],
  );
  assert.equal(records.find((record) => record.channelId === 't1' && !record.attachments.length).reactionCount, 0);
});

test('a rejected token stops history and leaves the remaining channels pending', async () => {
  const client = historyClient({}, { failures: { 'c1:1': new DiscordApiError('401: Unauthorized', { status: 401 }) } });
  client.getChannel = async (id) => ({ id, type: 0, name: id, guild_id: 'g1' });
  const result = await collectHistory({ client, targets: [{ id: 'c1' }, { id: 'c2' }], outputPath: path.join(makeTempRoot(), 'out.ndjson'), onProgress: () => {} });
  assert.deepEqual(result.channels.map((channel) => channel.status), ['failed', 'pending']);
  assert.equal(result.aborted.reason, 'auth');
});

function thread(id, minute, extra = {}) {
  return { id: minuteId(id), name: `post ${id}`, type: 11, parent_id: 'f1', guild_id: 'g1', last_message_id: minuteId(minute), thread_metadata: { archived: false, archive_timestamp: new Date(Date.UTC(2026, 7, 1) + minute * 60000).toISOString() }, ...extra };
}

test('forum posts are paged with starter messages and a pinned old post does not end the walk', async () => {
  const pages = [
    { threads: [thread(1, 5, { applied_tags: ['tag-1'] }), thread(2, 300), thread(3, 290)], first_messages: [{ id: minuteId(2), channel_id: minuteId(2), content: 'V5 workflow', attachments: [{ id: 'x', filename: 'x.png' }] }], has_more: true, total_results: 5 },
    { threads: [thread(4, 50), thread(5, 40)], first_messages: [], has_more: true, total_results: 5 },
  ];
  const offsets = [];
  const client = {
    async inventoryGuilds() {
      return [{ id: 'g1', name: 'AI Guild' }];
    },
    async getChannel() {
      return { id: 'f1', type: 15, name: 'workflows', guild_id: 'g1', available_tags: [{ id: 'tag-1', name: 'NovelAI' }] };
    },
    async searchThreads(channelId, { offset }) {
      offsets.push(offset);
      return pages[offsets.length - 1] ?? { threads: [], has_more: false };
    },
  };
  const result = await listThreads({ client, channelIds: ['f1'], after: new Date(Date.UTC(2026, 7, 1) + 100 * 60000).toISOString() });

  assert.deepEqual(offsets, [0, 3]);
  assert.deepEqual(result.threads.map((item) => item.name), ['post 2', 'post 3']);
  assert.deepEqual([result.channels[0].status, result.channels[0].stopReason, result.channels[0].totalResults], ['complete', 'after-bound', 5]);
  const post = result.threads[0];
  assert.deepEqual([post.parentName, post.guildName, post.firstMessage.content, post.firstMessage.forumTitle], ['workflows', 'AI Guild', 'V5 workflow', 'post 2']);

  const all = await listThreads({ client: { ...client, searchThreads: async () => pages[0] }, channelIds: ['f1'], maxThreads: 2 });
  assert.equal(all.channels[0].status, 'truncated');
  assert.deepEqual(all.threads[0].tags, ['NovelAI']);
});

test('text channel threads combine active, archived, and joined private threads', async () => {
  const calls = [];
  const client = {
    async inventoryGuilds() {
      return [];
    },
    async getChannel() {
      return { id: 'c1', type: 0, name: 'general', guild_id: 'g1' };
    },
    async activeThreads() {
      return { threads: [thread(1, 400, { parent_id: 'c1' }), thread(2, 400, { parent_id: 'other' })] };
    },
    async archivedThreads(channelId, { scope, before }) {
      calls.push([scope, before ?? null]);
      if (scope === 'joined') throw new DiscordApiError('Missing Access', { status: 403 });
      return before
        ? { threads: [thread(5, 100, { parent_id: 'c1' })], has_more: false }
        : { threads: [thread(3, 300, { parent_id: 'c1' }), thread(4, 200, { parent_id: 'c1' })], has_more: true };
    },
  };
  const result = await listThreads({ client, channelIds: ['c1'] });

  assert.deepEqual(result.threads.map((item) => item.name), ['post 1', 'post 3', 'post 4', 'post 5']);
  assert.deepEqual(calls.map(([scope]) => scope), ['public', 'public', 'joined']);
  assert.equal(calls[1][1], new Date(Date.UTC(2026, 7, 1) + 200 * 60000).toISOString());
  assert.equal(result.channels[0].status, 'complete');
  assert.deepEqual(result.channels[0].notes, ['private archived threads: no access']);
});

test('show accepts jump links and returns the message with its thread and context', async () => {
  assert.deepEqual(parseMessageRef('https://discord.com/channels/1/2/3'), { guildId: '1', channelId: '2', messageId: '3' });
  assert.deepEqual(parseMessageRef('https://ptb.discordapp.com/channels/@me/2/3'), { guildId: null, channelId: '2', messageId: '3' });
  assert.deepEqual(parseMessageRef('2/3'), { guildId: null, channelId: '2', messageId: '3' });
  assert.throws(() => parseMessageRef('https://example.com/x'), /Not a Discord message link/);

  const messages = [historyMessage(1), historyMessage(2), historyMessage(3)];
  const client = {
    async inventoryGuilds() {
      return [{ id: 'g1', name: 'AI Guild' }];
    },
    async getChannel(id) {
      return id === 't1' ? { id, type: 11, name: 'V5 tips', parent_id: 'f1', guild_id: 'g1' } : { id, type: 15, name: 'tips' };
    },
    async fetchAround() {
      return messages;
    },
  };
  const [result] = await showMessages({ client, refs: [{ guildId: null, channelId: 't1', messageId: minuteId(2) }], context: 1 });
  assert.equal(result.target.content, 'message 2');
  assert.deepEqual([result.target.guildName, result.target.forumTitle, result.target.parentChannelName], ['AI Guild', 'V5 tips', 'tips']);
  assert.deepEqual([result.before.length, result.after.length], [1, 1]);
  assert.equal(result.before[0].forumTitle, 'V5 tips');
});

test('nearby hits share one context window', async () => {
  const window = Array.from({ length: 20 }, (_, minute) => ({ ...historyMessage(minute), channel_id: 'c1' }));
  const requests = [];
  const client = {
    async fetchAround(channelId, messageId, limit) {
      requests.push([channelId, limit]);
      return channelId === 'c1' ? window : [{ ...historyMessage(1), channel_id: channelId }];
    },
  };
  const hits = [5, 8, 12].map((minute) => ({ guildId: 'g1', channelId: 'c1', messageId: minuteId(minute), content: `message ${minute}` }))
    .concat([{ guildId: 'g1', channelId: 'c2', messageId: minuteId(1) }]);
  const result = await enrichHits({ client, hits, before: 2, after: 2, windowSize: 50 });

  assert.deepEqual(requests, [['c1', 50], ['c2', 50]]);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.contexts.map((context) => [context.before.length, context.after.length]), [[2, 2], [2, 2], [2, 2], [0, 0]]);
  assert.deepEqual(result.contexts[1].before.map((record) => record.content), ['message 6', 'message 7']);
});
