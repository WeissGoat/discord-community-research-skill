import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DiscordApiError,
  checkAccess,
  createDiscordClient,
  iterateSearch,
  snowflakeFromDate,
} from '../scripts/lib/api.mjs';
import { normalizeMessage } from '../scripts/lib/records.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return body == null ? '' : JSON.stringify(body);
    },
  };
}

test('retries 429 using retry_after and returns the eventual JSON', async () => {
  const calls = [];
  const waits = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return response(429, { retry_after: 0.01, global: false });
    return response(200, [{ id: 'guild-1', name: 'Guild One' }]);
  };
  const client = createDiscordClient({
    token: 'secret-token-value',
    fetchImpl,
    sleep: async (ms) => waits.push(ms),
    maxRetries: 2,
  });

  const data = await client.inventoryGuilds();

  assert.equal(data[0].id, 'guild-1');
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [10]);
});

test('retries 202 and transient 503 without treating either as success', async () => {
  let attempt = 0;
  const statuses = [];
  const waits = [];
  const client = createDiscordClient({
    token: 'secret-token-value',
    fetchImpl: async () => {
      attempt += 1;
      statuses.push(attempt);
      if (attempt === 1) return response(202, { retry_after: 0.02 });
      if (attempt === 2) return response(503, { message: 'temporary' });
      return response(200, { ok: true });
    },
    sleep: async (ms) => waits.push(ms),
    maxRetries: 3,
  });

  const data = await client.getJson('/health');

  assert.deepEqual(data, { ok: true });
  assert.deepEqual(statuses, [1, 2, 3]);
  assert.equal(waits[0], 20);
  assert.equal(waits[1], 2000);
});

test('throws a status-bearing retryable error after bounded retries', async () => {
  const client = createDiscordClient({
    token: 'secret-token-value',
    fetchImpl: async () => response(429, { retry_after: 0 }),
    sleep: async () => {},
    maxRetries: 1,
  });

  await assert.rejects(
    client.getJson('/limited'),
    (error) => {
      assert.ok(error instanceof DiscordApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    },
  );
});

test('flattens nested search groups, deduplicates overlap, and yields both pages', async () => {
  const pages = [fixture('search-page.json'), fixture('search-page-2.json')];
  const requested = [];
  const client = {
    async searchPage(_guildId, criteria, offset) {
      requested.push({ criteria, offset });
      return pages[requested.length - 1] ?? { messages: [], total_results: 2 };
    },
  };
  const yielded = [];
  const callbackPages = [];

  for await (const page of iterateSearch({
    client,
    guildId: '4001',
    criteria: { content: 'tool', minDate: '2026-07-01T00:00:00.000Z' },
    pageSize: 2,
    maxPages: 2,
    onPage: async (page) => callbackPages.push(page),
  })) {
    yielded.push(page);
  }

  const ids = yielded.flatMap((page) => page.messages.map((message) => message.id));
  assert.deepEqual(ids, ['1001', '1002']);
  assert.deepEqual(requested.map((call) => call.offset), [0, 2]);
  assert.equal(callbackPages.length, 2);
  assert.equal(yielded.at(-1).fetchedCount, 2);
});

test('stops after the first empty page when Discord reports zero results', async () => {
  let calls = 0;
  const client = {
    async searchPage() {
      calls += 1;
      return { messages: [], total_results: 0 };
    },
  };

  const pages = [];
  for await (const page of iterateSearch({
    client,
    guildId: '4001',
    criteria: { content: 'missing project' },
    maxPages: 2,
  })) {
    pages.push(page);
  }

  assert.equal(calls, 1);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].truncated, false);
});

test('normalizes URLs, replies, attachments, reactions, and jump links without credentials', () => {
  const message = normalizeMessage(
    {
      id: '1002',
      type: 19,
      content: 'See https://example.test/tool.',
      channel_id: '2001',
      timestamp: '2026-07-01T00:00:00.000Z',
      author: { id: '3002', username: 'user-b', global_name: 'User B', bot: false },
      attachments: [{ filename: 'demo.png', content_type: 'image/png', size: 12, width: 4, height: 3, url: 'https://cdn.test/demo.png' }],
      reactions: [
        { count: 4, me: true, emoji: { id: null, name: 'heart', animated: false } },
        { count: 2, me: false, emoji: { id: 'custom-1', name: 'spark', animated: true } },
      ],
      embeds: [{ url: 'https://example.test/embed', title: 'Demo' }],
      message_reference: { message_id: '1001', channel_id: '2001', guild_id: '4001' },
    },
    { guildId: '4001', guildName: 'Guild One', channelName: 'tools', query: 'tool' },
  );

  assert.deepEqual(message.urls, ['https://example.test/tool', 'https://example.test/embed']);
  assert.equal(message.replyReference.messageId, '1001');
  assert.equal(message.attachments[0].filename, 'demo.png');
  assert.equal(message.reactionCount, 6);
  assert.equal(message.reactions[1].emoji.id, 'custom-1');
  assert.equal(message.reactions[1].emoji.animated, true);
  assert.equal(message.jumpUrl, 'https://discord.com/channels/4001/2001/1002');
  assert.doesNotMatch(JSON.stringify(message), /secret-token-value/);
});

// A search index that honours max_id and offset the way Discord does, newest first.
function fakeSearchIndex(count) {
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const messages = Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(start + index * 60000).toISOString();
    return { id: (BigInt(snowflakeFromDate(timestamp)) + 1n).toString(), channel_id: '2001', timestamp, content: `message ${index}` };
  }).reverse();
  return {
    async searchPage(_guildId, criteria, offset) {
      const matching = messages.filter((message) => !criteria.maxId || BigInt(message.id) < BigInt(criteria.maxId));
      return { messages: matching.slice(offset, offset + 25).map((message) => [message]), total_results: matching.length };
    },
  };
}

test('date-window continuation keeps paging until the narrowed window is exhausted', async () => {
  const pages = [];
  for await (const page of iterateSearch({ client: fakeSearchIndex(150), guildId: '4001', pageSize: 25, maxOffset: 100 })) {
    pages.push(page);
  }

  const ids = pages.flatMap((page) => page.messages.map((message) => message.id));
  assert.equal(ids.length, 150);
  assert.equal(new Set(ids).size, 150);
  assert.equal(pages.at(-1).stopReason, 'complete');
  assert.equal(pages.at(-1).initialTotal, 150);
  assert.equal(pages.some((page) => page.truncated || page.incomplete), false);
});

test('search pages expose thread metadata and Discord deep-index state', async () => {
  const thread = { id: '5001', name: 'Workflow share', parent_id: '2001', type: 11 };
  const pages = [];
  for await (const page of iterateSearch({
    client: {
      async searchPage() {
        return { messages: [[{ id: '1001', channel_id: '5001' }]], total_results: 1, threads: [thread], doing_deep_historical_index: true };
      },
    },
    guildId: '4001',
  })) {
    pages.push(page);
  }

  assert.deepEqual(pages[0].threads, [thread]);
  assert.equal(pages[0].deepHistoricalIndex, true);
});

test('a walk that ends on empty pages well short of the reported total is incomplete', async () => {
  let calls = 0;
  const pages = [];
  for await (const page of iterateSearch({
    client: {
      async searchPage() {
        calls += 1;
        const messages = calls === 1 ? Array.from({ length: 10 }, (_, index) => [{ id: String(1000 + index) }]) : [];
        return { messages, total_results: 40 };
      },
    },
    guildId: '4001',
  })) {
    pages.push(page);
  }

  assert.equal(pages.at(-1).stopReason, 'empty-pages');
  assert.equal(pages.at(-1).incomplete, true);
  assert.equal(pages.at(-1).truncated, false);
});

test('search forwards slop so multi-word queries can match words far apart', async () => {
  const urls = [];
  const client = createDiscordClient({
    token: 'secret-token-value',
    fetchImpl: async (url) => {
      urls.push(url);
      return response(200, { messages: [], total_results: 0 });
    },
  });

  await client.searchPage('4001', { content: 'ComfyUI MCP', slop: 100 });

  assert.equal(new URL(urls[0]).searchParams.get('slop'), '100');
});

test('a hung request times out as a retryable network error', async () => {
  const client = createDiscordClient({
    token: 'secret-token-value',
    requestTimeoutMs: 20,
    maxRetries: 0,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });

  await assert.rejects(client.getJson('/users/@me'), (error) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.network, true);
    assert.equal(error.retryable, true);
    assert.match(error.message, /timed out after 20ms/);
    return true;
  });
});

test('preflight separates a rejected token from a network failure', async () => {
  const rejected = await checkAccess({
    async whoami() { throw new DiscordApiError('Discord request failed with HTTP 401', { status: 401 }); },
  });
  const offline = await checkAccess({
    async whoami() { throw new DiscordApiError('Discord request failed after retries (ECONNRESET)', { retryable: true, network: true }); },
  });
  const ok = await checkAccess({ async whoami() { return { id: '3001', username: 'user-a' }; } });

  assert.equal(rejected.kind, 'auth');
  assert.equal(offline.kind, 'network');
  assert.match(offline.hint, /proxy/i);
  assert.deepEqual(ok.user, { id: '3001', username: 'user-a' });
});
