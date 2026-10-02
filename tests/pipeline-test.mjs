import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiscordApiError } from '../scripts/lib/api.mjs';
import { createRunDirectory, loadJson, loadToken, sanitizeError } from '../scripts/lib/io.mjs';
import { inventoryGuilds } from '../scripts/inventory-guilds.mjs';
import { createProgressReporter, runSearchPlan } from '../scripts/run-search-plan.mjs';
import { runCommunityResearch } from '../scripts/run-research.mjs';
import { enrichHit, loadHits } from '../scripts/enrich-hits.mjs';
import { buildEvidenceIndex, gradeEvidence } from '../scripts/build-evidence-index.mjs';
import { buildReport } from '../scripts/build-report.mjs';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-community-research-'));
}

function message(id, timestamp = '2026-07-01T00:00:00.000Z', content = 'tool result') {
  return {
    id,
    channel_id: 'channel-1',
    timestamp,
    content,
    type: 0,
    author: { id: `author-${id}`, username: `user-${id}`, global_name: `User ${id}` },
    attachments: [],
    embeds: [],
  };
}

test('inventory records all joined guilds and channel request errors', async () => {
  const root = makeTempRoot();
  const client = {
    async inventoryGuilds() {
      return [
        { id: 'guild-1', name: 'First Guild' },
        { id: 'guild-2', name: 'Second Guild' },
      ];
    },
    async inventoryChannels(guildId) {
      if (guildId === 'guild-2') throw new DiscordApiError('forbidden', { status: 403 });
      return [{ id: 'channel-1', name: 'research', type: 0 }];
    },
  };

  const outputPath = path.join(root, 'guilds.json');
  const inventory = await inventoryGuilds({ client, outputPath, now: '2026-08-02T00:00:00.000Z' });

  assert.equal(inventory.guilds.length, 2);
  assert.equal(inventory.guilds[0].channels[0].name, 'research');
  assert.equal(inventory.guilds[1].channelError.status, 403);
  assert.equal(loadJson(outputPath).guilds.length, 2);
});

test('a rate-limited query remains retryable and is not added to completed', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'retryable-run' });
  const plan = {
    runId: 'retryable-run',
    objective: 'find tool discussions',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    options: { pageSize: 25, maxPages: 2 },
  };
  const client = {
    async searchPage() {
      throw new DiscordApiError('rate limited', { status: 429, retryable: true });
    },
  };

  const state = await runSearchPlan({ client, plan, runDir });
  const task = Object.values(state.tasks)[0];

  assert.equal(task.status, 'retryable');
  assert.deepEqual(state.completed, []);
  assert.equal(loadJson(runDir.state).tasks[task.key].status, 'retryable');
});

test('resuming a run skips success but retries retryable work', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'resume-run' });
  const plan = {
    runId: 'resume-run',
    objective: 'find tool discussions',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    queries: [
      { id: 'q1', content: 'tool', purpose: 'discovery' },
      { id: 'q2', content: 'workflow', purpose: 'validation' },
    ],
    options: { pageSize: 25, maxPages: 2 },
  };
  let calls = 0;
  const failingClient = {
    async searchPage(_guildId, criteria) {
      calls += 1;
      if (criteria.content === 'tool') throw new DiscordApiError('rate limited', { status: 429, retryable: true });
      return { messages: [[message('success-1')]], total_results: 1 };
    },
  };

  const first = await runSearchPlan({ client: failingClient, plan, runDir });
  assert.equal(Object.values(first.tasks).filter((task) => task.status === 'success').length, 1);
  assert.equal(Object.values(first.tasks).filter((task) => task.status === 'retryable').length, 1);

  const resumedClient = {
    async searchPage() {
      calls += 1;
      return { messages: [[message('retry-success')]], total_results: 1 };
    },
  };
  const second = await runSearchPlan({ client: resumedClient, plan, runDir });

  assert.equal(Object.values(second.tasks).every((task) => task.status === 'success'), true);
  assert.equal(second.completed.length, 2);
  assert.equal(calls, 3);
});

test('resume rejects a changed query definition with the same task id', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'plan-mismatch-run' });
  const base = {
    runId: 'plan-mismatch-run',
    objective: 'find tools',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    options: { maxPages: 1 },
  };
  const client = {
    async searchPage() {
      return { messages: [[message('hit')]], total_results: 1 };
    },
  };

  await runSearchPlan({
    client,
    plan: { ...base, queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }] },
    runDir,
  });

  await assert.rejects(
    runSearchPlan({
      client,
      plan: { ...base, queries: [{ id: 'q1', content: 'workflow', purpose: 'discovery' }] },
      runDir,
    }),
    /plan mismatch/i,
  );
});

test('resume rejects removing a query from an existing run', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'plan-contraction-run' });
  const base = {
    runId: 'plan-contraction-run',
    objective: 'find tools',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    options: { maxPages: 1 },
  };
  const client = {
    async searchPage(_guildId, criteria) {
      return { messages: [[message(criteria.content)]], total_results: 1 };
    },
  };

  await runSearchPlan({
    client,
    plan: {
      ...base,
      queries: [
        { id: 'q1', content: 'tool', purpose: 'discovery' },
        { id: 'q2', content: 'workflow', purpose: 'discovery' },
      ],
    },
    runDir,
  });

  await assert.rejects(
    runSearchPlan({
      client,
      plan: { ...base, queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }] },
      runDir,
    }),
    /plan mismatch.*removed/i,
  );
});

test('a bounded page limit produces truncated status and coverage metrics', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'truncated-run' });
  const plan = {
    runId: 'truncated-run',
    objective: 'find tool discussions',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    options: { pageSize: 25, maxPages: 1 },
  };
  const client = {
    async searchPage() {
      return { messages: [[message('only-1')]], total_results: 10 };
    },
  };

  const state = await runSearchPlan({ client, plan, runDir });
  const task = Object.values(state.tasks)[0];

  assert.equal(task.status, 'truncated');
  assert.equal(task.truncated, true);
  assert.equal(task.reportedTotal, 10);
  assert.equal(task.fetchedCount, 1);
});

test('search plan respects bounded concurrency and reports live progress', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'concurrent-run' });
  const plan = {
    runId: 'concurrent-run',
    objective: 'find tools',
    guilds: [
      { id: 'guild-1', name: 'First Guild' },
      { id: 'guild-2', name: 'Second Guild' },
      { id: 'guild-3', name: 'Third Guild' },
    ],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    options: { concurrency: 2, maxPages: 1 },
  };
  let active = 0;
  let maxActive = 0;
  const output = [];
  const reporter = createProgressReporter({
    write: (line) => output.push(line),
    now: (() => {
      let value = 0;
      return () => value += 1000;
    })(),
  });
  const client = {
    async searchPage(guildId) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { messages: [[message(`hit-${guildId}`)]], total_results: 1 };
    },
  };

  const state = await runSearchPlan({ client, plan, runDir, onCheckpoint: reporter });

  assert.equal(maxActive, 2);
  assert.equal(Object.values(state.tasks).every((task) => task.status === 'success'), true);
  assert.equal(output.some((line) => line.includes('tool') && line.includes('ETA')), true);
});

test('progress percentages do not move backward when retryable tasks resume', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'progress-resume-run' });
  const plan = {
    runId: 'progress-resume-run',
    objective: 'find tools',
    guilds: [{ id: 'guild-1', name: 'First Guild' }, { id: 'guild-2', name: 'Second Guild' }],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    options: { concurrency: 2, maxPages: 1 },
  };
  await runSearchPlan({
    client: { async searchPage() { throw new DiscordApiError('limited', { status: 429, retryable: true }); } },
    plan,
    runDir,
  });
  const output = [];
  const reporter = createProgressReporter({ write: (line) => output.push(line) });
  await runSearchPlan({
    client: { async searchPage(guildId) { return { messages: [[message('hit-' + guildId)]], total_results: 1 }; } },
    plan,
    runDir,
    onCheckpoint: reporter,
  });

  const percentages = output.map((line) => Number(line.match(/(\d+\.\d+)%/)?.[1])).filter(Number.isFinite);
  assert.equal(percentages.every((value, index) => index === 0 || value >= percentages[index - 1]), true);
});

test('token values never appear in serialized errors or loaded state', () => {
  const token = 'super-secret-token';
  const error = sanitizeError(new Error(`request failed with ${token}`), token);

  assert.doesNotMatch(JSON.stringify(error), /super-secret-token/);
  assert.match(JSON.stringify(error), /REDACTED/);
  assert.throws(() => loadToken({ env: {}, cwd: makeTempRoot() }), /VITE_DISCORD_TOKEN/);
});

test('context output marks the target and does not count nearby messages as hits', async () => {
  const hit = {
    guildId: 'guild-1',
    guildName: 'First Guild',
    channelId: 'channel-1',
    channelName: 'research',
    messageId: 'target',
    timestamp: '2026-07-01T00:01:00.000Z',
    content: 'target discussion',
    matchedQueries: ['tool'],
  };
  const context = await enrichHit({
    client: {
      async fetchAround() {
        return [
          message('before', '2026-07-01T00:00:00.000Z', 'before context'),
          message('target', '2026-07-01T00:01:00.000Z', 'target discussion'),
          message('after', '2026-07-01T00:02:00.000Z', 'after context'),
        ];
      },
    },
    hit,
    before: 1,
    after: 1,
  });

  assert.equal(context.target.messageId, 'target');
  assert.equal(context.target.isTarget, true);
  assert.deepEqual(context.before.map((item) => item.messageId), ['before']);
  assert.deepEqual(context.after.map((item) => item.messageId), ['after']);
  assert.equal(context.before.some((item) => item.messageId === 'target'), false);
  assert.equal(context.after.some((item) => item.messageId === 'target'), false);
});

test('enrichment input accepts both search NDJSON and preliminary evidence JSON', () => {
  const root = makeTempRoot();
  const ndjsonPath = path.join(root, 'messages.ndjson');
  const evidencePath = path.join(root, 'evidence.json');
  fs.writeFileSync(ndjsonPath, `${JSON.stringify({ messageId: 'ndjson-hit' })}\n`, 'utf8');
  fs.writeFileSync(evidencePath, JSON.stringify({ candidates: [{ messageId: 'json-hit' }] }), 'utf8');

  assert.equal(loadHits(ndjsonPath)[0].messageId, 'ndjson-hit');
  assert.equal(loadHits(evidencePath)[0].messageId, 'json-hit');
});

test('same message matched by aliases has one record and all matchedQueries', () => {
  const evidence = buildEvidenceIndex({
    messages: [
      { ...message('same', '2026-07-01T00:00:00.000Z', 'tool workflow setup'), guildName: 'First Guild' },
      { ...message('same', '2026-07-01T00:00:00.000Z', 'tool workflow setup'), guildName: 'First Guild' },
    ].map((item, index) => ({
      ...item,
      guildId: 'guild-1',
      channelName: 'research',
      matchedQueries: index === 0 ? ['tool'] : ['workflow'],
      jumpUrl: 'https://discord.com/channels/guild-1/channel-1/same',
    })),
    contexts: [],
    queryPlan: { queries: [{ id: 'q1', content: 'tool' }, { id: 'q2', content: 'workflow' }] },
    now: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(evidence.candidates.length, 1);
  assert.deepEqual(evidence.candidates[0].matchedQueries.sort(), ['tool', 'workflow']);
});

test('evidence filtering requires all body terms and maps channel names from inventory', () => {
  const evidence = buildEvidenceIndex({
    messages: [
      { ...message('both', '2026-07-01T00:00:00.000Z', 'ComfyUI can be controlled through this MCP server https://github.com/example/project'), guildId: 'guild-1', matchedQueries: ['ComfyUI'] },
      { ...message('one', '2026-07-02T00:00:00.000Z', 'ComfyUI workflow only'), guildId: 'guild-1', matchedQueries: ['ComfyUI'] },
    ],
    inventory: {
      guilds: [{ id: 'guild-1', name: 'First Guild', channels: [{ id: 'channel-1', name: 'tool-releases' }] }],
    },
    queryPlan: { filters: { requireAll: ['ComfyUI', 'MCP'] } },
    now: '2026-08-02T00:00:00.000Z',
  });

  assert.deepEqual(evidence.candidates.map((candidate) => candidate.messageId), ['both']);
  assert.equal(evidence.candidates[0].channelName, 'tool-releases');
  assert.equal(evidence.candidates[0].evidenceStatus, 'project-linked');
  assert.equal(evidence.stats.filteredOutMessages, 1);
});

test('official claims without project links are marked unverified', () => {
  const evidence = buildEvidenceIndex({
    messages: [{ ...message('claim', '2026-07-01T00:00:00.000Z', '听说 ComfyUI 最近有官方 MCP 了'), guildId: 'guild-1', matchedQueries: ['ComfyUI MCP'] }],
    queryPlan: {},
    now: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(evidence.candidates[0].evidenceStatus, 'unverified-claim');
});

test('single-command research runs validation queries only on discovery-hit guilds', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'two-stage-run' });
  const calls = [];
  const plan = {
    runId: 'two-stage-run',
    objective: 'find ComfyUI MCP projects',
    dateRange: { minDate: '2026-01-01', maxDate: '2026-08-02' },
    guilds: [
      { id: 'guild-1', name: 'Relevant', channels: [{ id: 'channel-1', name: 'projects' }] },
      { id: 'guild-2', name: 'Unrelated', channels: [{ id: 'channel-1', name: 'general' }] },
    ],
    queries: [
      { id: 'discover', content: 'ComfyUI', purpose: 'discovery' },
      { id: 'validate', content: 'MCP', purpose: 'validation' },
    ],
    filters: { requireAll: ['ComfyUI', 'MCP'] },
    options: { maxPages: 1, discoveryMaxPages: 1, concurrency: 2 },
  };
  const client = {
    async searchPage(guildId, criteria) {
      calls.push(`${guildId}:${criteria.content}`);
      if (guildId === 'guild-1' && criteria.content === 'ComfyUI') {
        return { messages: [[message('discovery', '2026-07-01T00:00:00.000Z', 'ComfyUI discussion')]], total_results: 1 };
      }
      if (guildId === 'guild-1' && criteria.content === 'MCP') {
        return { messages: [[message('validation', '2026-07-02T00:00:00.000Z', 'ComfyUI MCP server https://github.com/example/mcp')]], total_results: 1 };
      }
      return { messages: [], total_results: 0 };
    },
  };

  const result = await runCommunityResearch({ client, plan, runDir, enrich: false });

  assert.deepEqual(calls.sort(), ['guild-1:ComfyUI', 'guild-1:MCP', 'guild-2:ComfyUI']);
  assert.deepEqual(result.relevantGuildIds, ['guild-1']);
  assert.equal(result.evidence.candidates[0].channelName, 'projects');
  assert.equal(fs.existsSync(runDir.report), true);
  assert.match(fs.readFileSync(runDir.report, 'utf8'), /project-linked/);
  assert.match(fs.readFileSync(runDir.report, 'utf8'), /ComfyUI, MCP/);
});

test('discovery-only research uses the bounded discovery page limit', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'discovery-only-run' });
  let calls = 0;
  const result = await runCommunityResearch({
    client: {
      async searchPage() {
        calls += 1;
        return { messages: [[message('hit-' + calls, '2026-07-01T00:00:00.000Z', 'ComfyUI project')]], total_results: 100 };
      },
    },
    plan: {
      runId: 'discovery-only-run',
      objective: 'find ComfyUI projects',
      guilds: [{ id: 'guild-1', name: 'First Guild' }],
      queries: [{ id: 'discover', content: 'ComfyUI', purpose: 'discovery' }],
      options: { discoveryMaxPages: 1, maxPages: 4 },
    },
    runDir,
    enrich: false,
  });

  assert.equal(calls, 1);
  assert.equal(result.phases[0].name, 'discovery');
  assert.equal(Object.values(result.state.tasks)[0].status, 'truncated');
});

test('validation-only research requires an explicit lower-level single pass', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'validation-only-run' });
  await assert.rejects(
    runCommunityResearch({
      client: { async searchPage() { return { messages: [], total_results: 0 }; } },
      plan: {
        runId: 'validation-only-run',
        objective: 'validate tools',
        guilds: [{ id: 'guild-1', name: 'First Guild' }],
        queries: [{ id: 'validate', content: 'workflow', purpose: 'validation' }],
      },
      runDir,
      enrich: false,
    }),
    /validation-only/i,
  );
});

test('selected guild scope can be complete after inventorying additional guilds', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'selected-scope-run' });
  await runCommunityResearch({
    client: { async searchPage() { return { messages: [], total_results: 0 }; } },
    plan: {
      runId: 'selected-scope-run',
      objective: 'search selected server',
      guilds: [{ id: 'guild-1', name: 'Selected' }],
      queries: [{ id: 'discover', content: 'tool', purpose: 'discovery' }],
      options: { discoveryMaxPages: 1 },
    },
    inventory: {
      guilds: [
        { id: 'guild-1', name: 'Selected', channels: [], channelError: null },
        { id: 'guild-2', name: 'Not Selected', channels: [], channelError: null },
      ],
    },
    runDir,
    enrich: false,
  });

  assert.match(fs.readFileSync(runDir.report, 'utf8'), /Coverage sufficient for absence claims: yes/);
});

test('enrichment errors are persisted and rendered in the report', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'enrichment-error-run' });
  await runCommunityResearch({
    client: {
      async searchPage() {
        return { messages: [[message('hit', '2026-07-01T00:00:00.000Z', 'tool setup')]], total_results: 1 };
      },
      async fetchAround() {
        throw new Error('context unavailable');
      },
    },
    plan: {
      runId: 'enrichment-error-run',
      objective: 'find tool setup',
      guilds: [{ id: 'guild-1', name: 'First Guild' }],
      queries: [{ id: 'discover', content: 'tool', purpose: 'discovery' }],
      options: { discoveryMaxPages: 1 },
    },
    runDir,
  });

  const run = loadJson(runDir.run);
  assert.equal(run.enrichment.errors.length, 1);
  assert.match(run.enrichment.errors[0].error.message, /context unavailable/);
  assert.match(fs.readFileSync(runDir.report, 'utf8'), /context unavailable/);
});

test('distinct authors and guilds increase signals without changing evidence grade alone', () => {
  const records = [
    { ...message('one', '2026-07-01T00:00:00.000Z', 'tool setup discussion'), guildId: 'guild-1', guildName: 'One', matchedQueries: ['tool'] },
    { ...message('two', '2026-07-02T00:00:00.000Z', 'tool setup discussion'), guildId: 'guild-2', guildName: 'Two', matchedQueries: ['tool'] },
  ].map((item, index) => ({
    ...item,
    channelName: 'research',
    authorId: `author-${index}`,
    author: `Author ${index}`,
    jumpUrl: `https://discord.com/channels/${item.guildId}/channel-1/${item.id}`,
  }));
  const evidence = buildEvidenceIndex({ messages: records, contexts: [], queryPlan: {}, now: '2026-08-02T00:00:00.000Z' });

  assert.equal(evidence.stats.distinctAuthors, 2);
  assert.equal(evidence.stats.distinctGuilds, 2);
  assert.equal(evidence.candidates[0].grade, evidence.candidates[1].grade);
  assert.equal(gradeEvidence({ ...records[0], content: 'tool setup discussion', signals: { distinctAuthors: 10, distinctGuilds: 10 } }), 'E2');
});

test('link-only and repeated messages are penalized in ordering', () => {
  const evidence = buildEvidenceIndex({
    messages: [
      { ...message('link', '2026-07-01T00:00:00.000Z', 'https://example.test/tool'), guildId: 'guild-1', matchedQueries: ['tool'], authorId: 'author-1', jumpUrl: 'https://discord.com/channels/guild-1/channel-1/link' },
      { ...message('repeat-1', '2026-07-01T00:00:00.000Z', 'same announcement'), guildId: 'guild-1', matchedQueries: ['tool'], authorId: 'author-1', jumpUrl: 'https://discord.com/channels/guild-1/channel-1/repeat-1' },
      { ...message('repeat-2', '2026-07-02T00:00:00.000Z', 'same announcement'), guildId: 'guild-1', matchedQueries: ['tool'], authorId: 'author-2', jumpUrl: 'https://discord.com/channels/guild-1/channel-1/repeat-2' },
      { ...message('substantive', '2026-07-03T00:00:00.000Z', 'We installed the tool and exported a working workflow with parameters.'), guildId: 'guild-1', matchedQueries: ['tool'], authorId: 'author-3', jumpUrl: 'https://discord.com/channels/guild-1/channel-1/substantive' },
    ],
    contexts: [],
    queryPlan: {},
    now: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(evidence.candidates[0].messageId, 'substantive');
  assert.equal(evidence.candidates.find((item) => item.messageId === 'link').penalties.linkOnly > 0, true);
  assert.equal(evidence.candidates.find((item) => item.messageId === 'repeat-1').penalties.repeatedContent > 0, true);
});

test('report includes coverage, failures, truncation, and direct jump URLs', () => {
  const report = buildReport({
    run: { objective: 'find tool discussions', generatedAt: '2026-08-02T00:00:00.000Z', evidenceSource: 'discord' },
    inventory: {
      guilds: [
        { id: 'guild-1', name: 'First Guild', channels: [], channelError: null },
        { id: 'guild-2', name: 'Private Guild', channels: [], channelError: { status: 403, message: 'forbidden' } },
      ],
    },
    plan: { dateRange: { minDate: '2026-01-01', maxDate: '2026-08-02' }, externalValidation: false },
    evidence: {
      candidates: [{ messageId: 'hit-1', guildName: 'First Guild', channelName: 'research', content: 'technical workflow', grade: 'E2', gradeReason: 'technical details', score: 3, jumpUrl: 'https://discord.com/channels/guild-1/channel-1/hit-1', matchedQueries: ['tool'] }],
      stats: { uniqueMessages: 1, distinctAuthors: 1, distinctGuilds: 1, distinctChannels: 1, grades: { E2: 1 } },
      coverage: {},
    },
    state: {
      tasks: {
        'guild-1|q1': { key: 'guild-1|q1', guildId: 'guild-1', query: 'tool', status: 'truncated', pages: 1, fetchedCount: 10, reportedTotal: 20, truncated: true, attempts: 1 },
        'guild-1|q2': { key: 'guild-1|q2', guildId: 'guild-1', query: 'workflow', status: 'failed', pages: 0, fetchedCount: 0, reportedTotal: 0, truncated: false, attempts: 2, lastError: { status: 500, message: 'failed' } },
      },
      errors: [],
    },
  });

  assert.match(report, /truncated/i);
  assert.match(report, /failed/i);
  assert.match(report, /Private Guild/);
  assert.match(report, /https:\/\/discord\.com\/channels\/guild-1\/channel-1\/hit-1/);
});

test('incomplete coverage uses not-observed wording instead of no-results wording', () => {
  const report = buildReport({
    run: { objective: 'find examples', generatedAt: '2026-08-02T00:00:00.000Z' },
    inventory: { guilds: [] },
    plan: {},
    evidence: { candidates: [], stats: {}, coverage: {} },
    state: { tasks: { 'guild-1|q1': { status: 'retryable', query: 'example' } }, errors: [] },
  });

  assert.match(report, /not observed within the completed coverage/i);
  assert.doesNotMatch(report, /no relevant results/i);
});

test('report states Discord-only evidence when external validation is disabled', () => {
  const report = buildReport({
    run: { objective: 'find projects', generatedAt: '2026-08-02T00:00:00.000Z', evidenceSource: 'discord' },
    inventory: { guilds: [] },
    plan: { externalValidation: false },
    evidence: { candidates: [], stats: {}, coverage: {} },
    state: { tasks: {}, errors: [] },
  });

  assert.match(report, /Discord-only/i);
  assert.match(report, /External validation: disabled/i);
});

test('thread hits carry the thread title, parent channel, and forum title from the search response', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'thread-run' });
  const plan = {
    runId: 'thread-run',
    objective: 'find workflow shares',
    guilds: [{ id: 'guild-1', name: 'First Guild', channels: [{ id: 'forum-1', name: 'workflows', type: 15 }] }],
    queries: [{ id: 'q1', content: 'workflow', purpose: 'discovery' }],
    options: { maxPages: 1 },
  };
  const client = {
    async searchPage() {
      return {
        messages: [[{ ...message('post-reply', '2026-07-01T00:00:00.000Z', 'workflow attached'), channel_id: 'thread-1' }]],
        total_results: 1,
        threads: [{ id: 'thread-1', name: 'NAI V5 workflow', parent_id: 'forum-1', type: 11 }],
      };
    },
  };

  await runSearchPlan({ client, plan, runDir });
  const [record] = fs.readFileSync(runDir.messages, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const evidence = buildEvidenceIndex({ messages: [record], queryPlan: plan, now: '2026-08-02T00:00:00.000Z' });
  const report = buildReport({ run: {}, inventory: { guilds: plan.guilds }, plan, evidence, state: loadJson(runDir.state) });

  assert.equal(record.channelName, 'NAI V5 workflow');
  assert.equal(record.parentChannelName, 'workflows');
  assert.equal(record.forumTitle, 'NAI V5 workflow');
  assert.equal(record.threadRootId, 'thread-1');
  assert.equal(record.reactionCount, null);
  assert.match(report, /First Guild \/ workflows \/ NAI V5 workflow/);
});

test('plan-level slop reaches every search request', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'slop-run' });
  const seen = [];
  await runSearchPlan({
    client: { async searchPage(_guildId, criteria) { seen.push(criteria.slop); return { messages: [], total_results: 0 }; } },
    plan: {
      runId: 'slop-run',
      guilds: [{ id: 'guild-1', name: 'First Guild' }],
      queries: [{ id: 'q1', content: 'ComfyUI MCP', purpose: 'discovery' }, { id: 'q2', content: 'NovelAI V5', criteria: { slop: 5 } }],
      options: { slop: 100, maxPages: 1 },
    },
    runDir,
  });

  assert.deepEqual(seen, [100, 5]);
});

test('a guild still building its search index yields a partial task that blocks absence claims', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'deep-index-run' });
  const plan = {
    runId: 'deep-index-run',
    guilds: [{ id: 'guild-1', name: 'First Guild' }],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    options: { maxPages: 1 },
  };
  const state = await runSearchPlan({
    client: { async searchPage() { return { messages: [], total_results: 0, doing_deep_historical_index: true }; } },
    plan,
    runDir,
  });
  const task = Object.values(state.tasks)[0];
  const report = buildReport({ run: {}, inventory: { guilds: plan.guilds }, plan, evidence: { candidates: [], stats: {}, coverage: {} }, state });

  assert.equal(task.status, 'partial');
  assert.deepEqual(task.partialReasons, ['deep-historical-index']);
  assert.deepEqual(state.completed, [task.key]);
  assert.match(report, /Coverage sufficient for absence claims: no/);
  assert.match(report, /still indexing server history/);
  assert.doesNotMatch(report, /No relevant results/i);
});

test('consecutive network failures abort the run and leave remaining tasks pending', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'network-abort-run' });
  let calls = 0;
  const state = await runSearchPlan({
    client: {
      async searchPage() {
        calls += 1;
        throw new DiscordApiError('Discord request failed after retries (UND_ERR_CONNECT_TIMEOUT)', { retryable: true, network: true });
      },
    },
    plan: {
      runId: 'network-abort-run',
      guilds: ['1', '2', '3', '4', '5'].map((id) => ({ id: `guild-${id}`, name: `Guild ${id}` })),
      queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
    },
    runDir,
  });
  const statuses = Object.values(state.tasks).map((task) => task.status).sort();

  assert.equal(calls, 3);
  assert.deepEqual(statuses, ['pending', 'pending', 'retryable', 'retryable', 'retryable']);
  assert.equal(state.aborted.reason, 'network');
  assert.equal(state.aborted.pendingTasks, 2);
  assert.equal(loadJson(runDir.state).aborted.reason, 'network');
});

test('a rejected token aborts after the first task', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'auth-abort-run' });
  const plan = {
    runId: 'auth-abort-run',
    guilds: [{ id: 'guild-1', name: 'One' }, { id: 'guild-2', name: 'Two' }],
    queries: [{ id: 'q1', content: 'tool', purpose: 'discovery' }],
  };
  const state = await runSearchPlan({
    client: { async searchPage() { throw new DiscordApiError('Discord request failed with HTTP 401', { status: 401 }); } },
    plan,
    runDir,
  });
  const report = buildReport({ run: {}, inventory: { guilds: plan.guilds }, plan, evidence: { candidates: [], stats: {}, coverage: {} }, state });

  assert.equal(state.aborted.reason, 'auth');
  assert.equal(Object.values(state.tasks).filter((task) => task.status === 'pending').length, 1);
  assert.match(report, /Run aborted \(auth\)/);
});

test('Chinese commentary next to a link is not link-only and Chinese technical terms grade as E2', () => {
  const evidence = buildEvidenceIndex({
    messages: [
      { ...message('zh-link', '2026-07-01T00:00:00.000Z', '这个工作流非常好用，安装后参数直接导入就能跑 https://github.com/example/flow'), guildId: 'guild-1', matchedQueries: ['工作流'] },
      { ...message('zh-tech', '2026-07-01T00:00:00.000Z', '安装这个节点之后报错了，参数怎么设置'), guildId: 'guild-1', matchedQueries: ['节点'] },
      { ...message('zh-bare-link', '2026-07-01T00:00:00.000Z', '好用 https://github.com/example/tool'), guildId: 'guild-1', matchedQueries: ['好用'] },
    ],
    now: '2026-08-02T00:00:00.000Z',
  });
  const byId = Object.fromEntries(evidence.candidates.map((candidate) => [candidate.messageId, candidate]));

  assert.equal(byId['zh-link'].penalties.linkOnly, 0);
  assert.notEqual(byId['zh-link'].grade, 'E0');
  assert.equal(byId['zh-tech'].grade, 'E2');
  assert.equal(byId['zh-bare-link'].penalties.linkOnly, 2);
});

test('reaction counts from enrichment replace unknown search counts in ranking', () => {
  const hit = {
    ...message('popular', '2026-07-01T00:00:00.000Z', 'showcase result'),
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'popular',
    reactionCount: null,
    matchedQueries: ['showcase'],
  };
  const other = { ...hit, id: 'quiet', messageId: 'quiet' };
  const evidence = buildEvidenceIndex({
    messages: [hit, other],
    contexts: [{ target: { guildId: 'guild-1', channelId: 'channel-1', messageId: 'popular', reactionCount: 7 } }],
    now: '2026-08-02T00:00:00.000Z',
  });
  const byId = Object.fromEntries(evidence.candidates.map((candidate) => [candidate.messageId, candidate]));

  assert.equal(byId.popular.reactionCount, 7);
  assert.ok(byId.popular.signals.reactionSignal > 0);
  assert.equal(byId.quiet.reactionCount, null);
  assert.equal(evidence.stats.reactionCountsKnown, 1);
  assert.equal(evidence.candidates[0].messageId, 'popular');
});

test('enrichment keeps image-only context messages empty instead of copying the hit text', async () => {
  const hit = {
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'target',
    timestamp: '2026-07-01T00:01:00.000Z',
    content: 'target discussion',
    author: 'Target Author',
    matchedQueries: ['tool'],
  };
  const imageOnly = {
    ...message('image', '2026-07-01T00:00:00.000Z', ''),
    attachments: [{ filename: 'result.png', content_type: 'image/png', width: 1024, height: 1024 }],
    reactions: [{ count: 3, emoji: { name: 'heart' } }],
  };
  const context = await enrichHit({
    client: { async fetchAround() { return [imageOnly, message('target', '2026-07-01T00:01:00.000Z', 'target discussion')]; } },
    hit,
    before: 1,
    after: 0,
  });

  assert.equal(context.before[0].content, '');
  assert.equal(context.before[0].author, 'User image');
  assert.equal(context.before[0].reactionCount, 3);
  assert.equal(context.target.reactionCount, 0);
});

test('skipped validation work makes absence claims scoped and zero-result queries get a slop hint', async () => {
  const root = makeTempRoot();
  const runDir = createRunDirectory({ outputRoot: root, runId: 'scoped-run' });
  const result = await runCommunityResearch({
    client: { async searchPage() { return { messages: [], total_results: 0 }; } },
    plan: {
      runId: 'scoped-run',
      objective: 'find fast nodes',
      guilds: [{ id: 'guild-1', name: 'One' }, { id: 'guild-2', name: 'Two' }],
      queries: [
        { id: 'discover', content: 'fast loaderV2', purpose: 'discovery' },
        { id: 'install', content: 'install fast', purpose: 'validation' },
      ],
      options: { discoveryMaxPages: 1 },
    },
    runDir,
    enrich: false,
  });
  const report = fs.readFileSync(runDir.report, 'utf8');

  assert.deepEqual(result.phases[1].skippedGuilds, ['guild-1', 'guild-2']);
  assert.match(report, /Coverage sufficient for absence claims: scoped - 1 validation queries ran in 0 discovery-hit servers and were skipped in 2/);
  assert.doesNotMatch(report, /No relevant results were observed in the completed Discord coverage/);
  assert.match(report, /`fast loaderV2`: 0 results in 2 servers \(multi-word, default slop\)/);
  assert.match(report, /Retry them with options\.slop 100/);
});
