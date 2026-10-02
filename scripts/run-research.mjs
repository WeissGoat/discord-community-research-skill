#!/usr/bin/env node
import path from 'node:path';

import { buildEvidenceIndex } from './build-evidence-index.mjs';
import { writeReport } from './build-report.mjs';
import { enrichHits } from './enrich-hits.mjs';
import { inventoryGuilds } from './inventory-guilds.mjs';
import { acquireRunLock, readNdjson, createRunDirectory, loadJson, writeJsonAtomic, writeNdjsonAtomic } from './lib/io.mjs';
import { createClientFromOptions, ensureAccess, exitCodeForAbort, parseCommand, runCommand } from './lib/cli.mjs';
import { assertPlanContainsExistingTasks, createProgressReporter, runSearchPlan, validatePlanCriteria } from './run-search-plan.mjs';

export const COMMAND = {
  name: 'run-research',
  summary: 'Inventory joined servers, run discovery then validation queries, enrich top hits, and write evidence.json and report.md.',
  usage: '--plan <file> [options]',
  discord: true,
  options: {
    plan: { type: 'string', value: '<file>', description: 'plan JSON with runId, objective, queries, dateRange, and options', required: true },
    'output-root': { type: 'string', value: '<dir>', description: 'parent of run directories (default discord_research/runs)' },
    'run-id': { type: 'string', value: '<id>', description: 'run directory name; overrides the plan runId' },
    'max-hits': { type: 'number', value: '<n>', description: 'candidates to enrich with context and reactions', default: 20 },
    'require-all': { type: 'list', value: '<a,b>', description: 'keep only messages whose text contains every term' },
    'no-enrich': { type: 'boolean', description: 'skip context and reaction enrichment' },
  },
};

function hasInventoryClient(client) {
  return typeof client?.inventoryGuilds === 'function' && typeof client?.inventoryChannels === 'function';
}

function mergeGuilds(plan, inventory) {
  const inventoryById = new Map((inventory.guilds ?? []).map((guild) => [guild.id, guild]));
  const requested = Array.isArray(plan.guilds) && plan.guilds.length
    ? plan.guilds
    : inventory.guilds ?? [];
  return requested.map((guild) => {
    const discovered = inventoryById.get(guild.id) ?? {};
    return {
      ...discovered,
      ...guild,
      channels: guild.channels?.length ? guild.channels : discovered.channels ?? [],
    };
  });
}

function phasePlan(plan, guilds, queries, maxPages) {
  return {
    ...plan,
    guilds,
    queries,
    options: {
      ...(plan.options ?? {}),
      maxPages,
    },
  };
}

function queryContent(query) {
  return query.content ?? query.query ?? '';
}

export function selectRelevantGuildIds(messages, discoveryQueries) {
  const terms = discoveryQueries.map(queryContent).map((term) => term.trim().toLocaleLowerCase()).filter(Boolean);
  const relevant = new Set();
  for (const message of messages) {
    const content = String(message.content ?? '').toLocaleLowerCase();
    const matched = (message.matchedQueries ?? []).map((query) => String(query).toLocaleLowerCase());
    if (terms.some((term) => matched.includes(term) || content.includes(term))) {
      if (message.guildId) relevant.add(message.guildId);
    }
  }
  return [...relevant].sort();
}

export async function resolveInventory({ client, plan, runDir, inventory = null } = {}) {
  if (inventory) {
    if (runDir?.guilds) writeJsonAtomic(runDir.guilds, inventory);
    return inventory;
  }
  if (hasInventoryClient(client)) {
    return inventoryGuilds({ client, outputPath: runDir?.guilds ?? null });
  }
  const fallback = {
    generatedAt: new Date().toISOString(),
    guilds: plan.guilds ?? [],
    totals: { joinedGuilds: (plan.guilds ?? []).length, accessibleChannelInventories: 0, inaccessibleChannelInventories: 0 },
  };
  if (runDir?.guilds) writeJsonAtomic(runDir.guilds, fallback);
  return fallback;
}

export async function runCommunityResearch({
  client,
  plan,
  runDir,
  inventory = null,
  enrich = true,
  maxHits = 20,
  onProgress = null,
  now = new Date().toISOString(),
} = {}) {
  if (!client?.searchPage) throw new TypeError('client.searchPage is required');
  if (!plan?.queries) throw new TypeError('plan.queries is required');
  if (!runDir) throw new TypeError('runDir is required');

  const discoveryQueries = plan.queries.filter((query) => (query.purpose ?? 'discovery') !== 'validation');
  const validationQueries = plan.queries.filter((query) => query.purpose === 'validation');
  if (!discoveryQueries.length && validationQueries.length) {
    throw new Error('Validation-only plans are not supported by run-research; use run-search-plan for an explicit single pass');
  }
  if (!discoveryQueries.length) throw new Error('At least one discovery query is required');

  const resolvedInventory = await resolveInventory({ client, plan, runDir, inventory });
  const guilds = mergeGuilds(plan, resolvedInventory);
  assertPlanContainsExistingTasks(loadJson(runDir.state, null), { ...plan, guilds });
  const progress = onProgress;
  let relevantGuildIds = [];
  const phases = [];

  const discoveryPlan = phasePlan(plan, guilds, discoveryQueries, plan.options?.discoveryMaxPages ?? 1);
  const discoveryState = await runSearchPlan({ client, plan: discoveryPlan, runDir, onCheckpoint: progress, allowPlanSubset: true });
  let aborted = discoveryState.aborted ?? null;
  phases.push({ name: 'discovery', guilds: guilds.map((guild) => guild.id), queries: discoveryQueries.map(queryContent) });
  relevantGuildIds = selectRelevantGuildIds(readNdjson(runDir.messages), discoveryQueries);
  if (validationQueries.length) {
    const relevantGuilds = aborted ? [] : guilds.filter((guild) => relevantGuildIds.includes(guild.id));
    // Skipped pairs are recorded so the report cannot treat them as searched.
    const skippedGuilds = guilds.filter((guild) => !relevantGuilds.includes(guild)).map((guild) => guild.id);
    if (relevantGuilds.length) {
      const validationPlan = phasePlan(plan, relevantGuilds, validationQueries, plan.options?.maxPages ?? Infinity);
      const validationState = await runSearchPlan({ client, plan: validationPlan, runDir, onCheckpoint: progress, allowPlanSubset: true });
      aborted ??= validationState.aborted ?? null;
    }
    phases.push({
      name: 'validation',
      guilds: relevantGuilds.map((guild) => guild.id),
      skippedGuilds,
      queries: validationQueries.map(queryContent),
      ...(relevantGuilds.length ? {} : { skipped: aborted ? 'run aborted' : 'no discovery hits' }),
    });
  }

  const inventoryGuildIds = new Set((resolvedInventory.guilds ?? []).map((guild) => guild.id));
  const selectedGuildIds = new Set(guilds.map((guild) => guild.id));
  const searchedAllJoined = inventoryGuildIds.size === selectedGuildIds.size
    && [...inventoryGuildIds].every((guildId) => selectedGuildIds.has(guildId));
  const finalPlan = {
    ...plan,
    guilds,
    phases,
    searchAllJoined: plan.searchAllJoined ?? searchedAllJoined,
    filters: {
      ...(plan.filters ?? {}),
      requireAll: plan.filters?.requireAll ?? plan.requireAll ?? [],
    },
  };
  writeJsonAtomic(runDir.searchPlan, finalPlan);

  const messages = readNdjson(runDir.messages);
  const preliminaryEvidence = buildEvidenceIndex({
    messages,
    queryPlan: finalPlan,
    inventory: resolvedInventory,
    now,
  });
  let contexts = [];
  let enrichmentErrors = [];
  const enrichmentEnabled = enrich && !aborted && typeof client.fetchAround === 'function';
  if (enrichmentEnabled) {
    const enriched = await enrichHits({
      client,
      hits: preliminaryEvidence.candidates,
      maxHits,
    });
    contexts = enriched.contexts;
    enrichmentErrors = enriched.errors;
  }
  writeNdjsonAtomic(runDir.contexts, contexts);

  const evidence = buildEvidenceIndex({
    messages,
    contexts,
    queryPlan: finalPlan,
    inventory: resolvedInventory,
    now,
  });
  writeJsonAtomic(runDir.evidence, evidence);

  const state = loadJson(runDir.state, { tasks: {}, errors: [] });
  const run = {
    runId: finalPlan.runId ?? null,
    objective: finalPlan.objective ?? null,
    generatedAt: now,
    evidenceSource: finalPlan.evidenceSource ?? 'discord',
    phases,
    relevantGuildIds,
    aborted,
    enrichment: { enabled: enrichmentEnabled, contexts: contexts.length, errors: enrichmentErrors },
  };
  writeJsonAtomic(runDir.run, run);
  writeReport({
    outputPath: runDir.report,
    input: { run, inventory: resolvedInventory, plan: finalPlan, evidence, state },
  });
  return { runDir, inventory: resolvedInventory, plan: finalPlan, state, evidence, contexts, enrichmentErrors, relevantGuildIds, phases, aborted };
}

if (process.argv[1]?.endsWith('run-research.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const plan = loadJson(values.plan);
    if (!plan) throw new Error(`Plan file not found: ${values.plan}`);
    plan.runId = values['run-id'] ?? plan.runId;
    if (values['require-all']?.length) plan.filters = { ...(plan.filters ?? {}), requireAll: values['require-all'] };
    validatePlanCriteria(plan);
    const client = createClientFromOptions(values);
    await ensureAccess(client);
    const runDir = createRunDirectory({ outputRoot: values['output-root'], runId: plan.runId });
    plan.runId ??= path.basename(runDir.directory);
    acquireRunLock(runDir.directory);
    const result = await runCommunityResearch({
      client,
      plan,
      runDir,
      enrich: !values['no-enrich'],
      maxHits: values['max-hits'],
      onProgress: createProgressReporter(),
    });
    console.log(JSON.stringify({
      runDirectory: result.runDir.directory,
      relevantGuilds: result.relevantGuildIds.length,
      candidates: result.evidence.candidates.length,
      contexts: result.contexts.length,
      aborted: result.aborted,
    }, null, 2));
    process.exitCode = exitCodeForAbort(result.aborted);
  });
}
