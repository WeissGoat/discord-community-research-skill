#!/usr/bin/env node
import path from 'node:path';

import { parseCommand, runCommand } from './lib/cli.mjs';
import { ensureOutputFile, loadJson, runFiles, writeTextAtomic } from './lib/io.mjs';

export const COMMAND = {
  name: 'build-report',
  summary: 'Render report.md with coverage, failures, truncation, and cited findings.',
  usage: '--run-dir <dir> | --run <file> --inventory <file> --plan <file> --evidence <file> --state <file> --output <file>',
  options: {
    'run-dir': { type: 'string', value: '<dir>', description: 'read every input from a run directory and write its report.md' },
    run: { type: 'string', value: '<file>', description: 'run.json' },
    inventory: { type: 'string', value: '<file>', description: 'guilds.json' },
    plan: { type: 'string', value: '<file>', description: 'search-plan.json' },
    evidence: { type: 'string', value: '<file>', description: 'evidence.json' },
    state: { type: 'string', value: '<file>', description: 'state.json' },
    output: { type: 'string', value: '<file>', description: 'report Markdown to write' },
  },
};

const DONE_STATUSES = new Set(['success', 'truncated', 'partial']);
const UNFINISHED_STATUSES = new Set(['failed', 'retryable', 'pending', 'running']);
const PARTIAL_REASON_LABELS = {
  'deep-historical-index': 'Discord was still indexing server history',
  'result-shortfall': 'fewer messages returned than reported',
};

function values(object) {
  return Object.values(object ?? {});
}

function safe(value, fallback = '-') {
  return value == null || value === '' ? fallback : String(value);
}

function inline(value) {
  return safe(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

function dateRange(plan = {}) {
  const range = plan.dateRange ?? {};
  if (!range.minDate && !range.maxDate) return 'bounded range recorded in the search plan';
  return `${safe(range.minDate, 'start not set')} to ${safe(range.maxDate, 'end not set')}`;
}

function taskStatusCounts(state = {}) {
  const counts = {};
  for (const task of values(state.tasks)) counts[task.status ?? 'unknown'] = (counts[task.status ?? 'unknown'] ?? 0) + 1;
  return counts;
}

// Validation queries only run in servers with discovery hits, so the servers
// they skipped were never searched for those queries.
function skippedValidation(plan = {}) {
  const phase = (plan.phases ?? []).find((item) => item.name === 'validation');
  if (!phase?.queries?.length) return null;
  const searched = new Set(phase.guilds ?? []);
  const skippedGuilds = phase.skippedGuilds
    ?? (plan.guilds ?? []).map((guild) => guild.id).filter((guildId) => !searched.has(guildId));
  if (!skippedGuilds.length) return null;
  return { queries: phase.queries.length, searchedGuilds: searched.size, skippedGuilds: skippedGuilds.length };
}

// yes: every planned query ran to completion everywhere; scoped: everything
// that ran is complete, but some validation work was skipped by design;
// no: something failed, stopped early, or was never searched.
function assessCoverage(state = {}, inventory = {}, plan = {}) {
  const tasks = values(state.tasks);
  const selectedGuildIds = plan.searchAllJoined === false
    ? new Set((plan.guilds ?? []).map((guild) => guild.id))
    : null;
  const inventoryErrors = (inventory.guilds ?? [])
    .filter((guild) => guild.channelError && (!selectedGuildIds || selectedGuildIds.has(guild.id)))
    .length;
  const searchedGuildIds = new Set(tasks.map((task) => task.guildId).filter(Boolean));
  const unsearchedJoinedGuild = plan.searchAllJoined !== false
    && (inventory.guilds ?? []).some((guild) => !guild.channelError && !searchedGuildIds.has(guild.id));
  const executedComplete = tasks.length > 0
    && tasks.every((task) => task.status === 'success')
    && inventoryErrors === 0
    && !unsearchedJoinedGuild
    && !state.aborted;
  if (!executedComplete) return { level: 'no' };
  const skipped = skippedValidation(plan);
  return skipped ? { level: 'scoped', skipped } : { level: 'yes' };
}

function renderCoverageLevel(coverage) {
  if (coverage.level === 'scoped') {
    const { queries, searchedGuilds, skippedGuilds } = coverage.skipped;
    return `- Coverage sufficient for absence claims: scoped - ${queries} validation queries ran in ${searchedGuilds} discovery-hit servers and were skipped in ${skippedGuilds}; absence is not established for them there`;
  }
  return `- Coverage sufficient for absence claims: ${coverage.level}`;
}

function renderAbort(state = {}) {
  if (!state.aborted) return null;
  return `- Run aborted (${inline(state.aborted.reason)}): ${inline(state.aborted.message)}; ${state.aborted.pendingTasks ?? 0} tasks left pending. Fix access, then resume with the same runId.`;
}

function serverStatus(guild, tasks) {
  if (guild.channelError) return 'inaccessible';
  if (!tasks.length) return 'inspected-not-searched';
  if (tasks.every((task) => task.status === 'pending' || task.status === 'running')) return 'not-searched-yet';
  if (tasks.some((task) => UNFINISHED_STATUSES.has(task.status))) return 'searched-incomplete';
  if (tasks.some((task) => task.status === 'truncated')) return 'searched-truncated';
  if (tasks.some((task) => task.status === 'partial')) return 'searched-partial';
  return 'searched';
}

function renderInventory(inventory = {}, state = {}) {
  const tasks = values(state.tasks);
  const rows = (inventory.guilds ?? []).map((guild) => {
    const guildTasks = tasks.filter((task) => task.guildId === guild.id);
    return `| ${inline(guild.name)} | ${serverStatus(guild, guildTasks)} | ${guildTasks.length} | ${guild.channelError ? inline(guild.channelError.message ?? `HTTP ${guild.channelError.status ?? 'error'}`) : `${guild.channels?.length ?? 0} channels`} |`;
  });
  if (!rows.length) return '- No guild inventory was recorded.';
  return ['| Server | Coverage | Tasks | Access |', '| --- | --- | ---: | --- |', ...rows].join('\n');
}

function renderTasks(state = {}) {
  const tasks = values(state.tasks);
  if (!tasks.length) return '- No search tasks were recorded.';
  const rows = tasks.map((task) => `| ${inline(task.query)} | ${inline(task.guildName ?? task.guildId)} | ${inline(task.status)} | ${task.pages ?? 0} | ${task.fetchedCount ?? 0}/${task.reportedTotal ?? 0} | ${task.attempts ?? 0} |`);
  return ['| Query | Server | Status | Pages | Fetched / reported | Attempts |', '| --- | --- | --- | ---: | ---: | ---: |', ...rows].join('\n');
}

const NEAR_PHRASE_NOTE = "- Multi-word queries ran with Discord's default slop of 2, so their words had to appear within two words of each other. Retry them with options.slop 100, or split them into single-term queries and use filters.requireAll.";

// Zero-result queries are the cue to rephrase before claiming absence.
function renderQueryDiagnostics(state = {}, plan = {}) {
  const queriesById = new Map((plan.queries ?? []).map((query) => [query.id, query]));
  const byQuery = new Map();
  for (const task of values(state.tasks)) {
    if (!DONE_STATUSES.has(task.status)) continue;
    const entry = byQuery.get(task.queryId) ?? { query: task.query, servers: 0, total: 0 };
    entry.servers += 1;
    entry.total += Number(task.reportedTotal ?? 0);
    byQuery.set(task.queryId, entry);
  }
  if (!byQuery.size) return '- No query has completed yet.';
  const lines = [];
  let nearPhraseQueries = 0;
  for (const [queryId, entry] of byQuery) {
    if (entry.total > 0) continue;
    const query = queriesById.get(queryId);
    const slop = query?.criteria?.slop ?? plan.options?.slop;
    const nearPhrase = /\s/.test(String(entry.query ?? '').trim()) && slop == null;
    if (nearPhrase) nearPhraseQueries += 1;
    lines.push(`- \`${inline(entry.query)}\`: 0 results in ${entry.servers} server${entry.servers === 1 ? '' : 's'}${nearPhrase ? ' (multi-word, default slop)' : ''}`);
  }
  if (nearPhraseQueries) lines.push(NEAR_PHRASE_NOTE);
  return lines.length ? lines.join('\n') : '- Every completed query returned results somewhere.';
}

function renderFindings(evidence = {}) {
  const candidates = (evidence.candidates ?? []).slice(0, 20);
  if (!candidates.length) return null;
  return candidates.map((candidate, index) => {
    const title = inline(candidate.content || candidate.messageId || 'Untitled message').slice(0, 240);
    const channelPath = candidate.threadName
      ? [candidate.parentChannelName, candidate.threadName]
      : [candidate.channelName];
    const location = [candidate.guildName, ...channelPath].filter(Boolean).map(inline).join(' / ') || 'Discord';
    const queries = candidate.matchedQueries?.length ? `; queries: ${candidate.matchedQueries.map(inline).join(', ')}` : '';
    const citation = candidate.jumpUrl ? `[open message](${candidate.jumpUrl})` : 'jump URL unavailable';
    const evidenceStatus = candidate.evidenceStatus ? `; status: ${inline(candidate.evidenceStatus)}` : '';
    const reactions = Number(candidate.reactionCount ?? 0) > 0 ? `; reactions ${candidate.reactionCount}` : '';
    return `${index + 1}. **${title}** (${location}) - ${candidate.grade ?? 'E0'}: ${inline(candidate.gradeReason)}${evidenceStatus}; score ${safe(candidate.score, '0')}${reactions}${queries}; ${citation}.`;
  }).join('\n');
}

function renderSignals(stats = {}, coverage = {}) {
  return [
    `- Unique messages: ${stats.uniqueMessages ?? 0} (raw: ${stats.rawMessages ?? 0}; duplicates merged: ${stats.duplicateMessages ?? 0})`,
    `- Messages removed by required-term filters: ${stats.filteredOutMessages ?? 0}`,
    `- Required body terms: ${(coverage.requireAll ?? []).map(inline).join(', ') || 'none'}`,
    `- Distinct authors: ${stats.distinctAuthors ?? 0}; servers: ${stats.distinctGuilds ?? 0}; channels: ${stats.distinctChannels ?? 0}`,
    `- Messages with reactions: ${stats.messagesWithReactions ?? 0}; counts known for ${stats.reactionCountsKnown ?? 0} of ${stats.uniqueMessages ?? 0} messages (search results omit reactions; enrichment fetches them); total reaction marks: ${stats.totalReactionCount ?? 0} (interaction signal only, not an aesthetic score)`,
    `- Evidence grades: ${Object.entries(stats.grades ?? {}).map(([grade, count]) => `${grade}=${count}`).join(', ') || 'none'}`,
    `- Evidence statuses: ${Object.entries(stats.evidenceStatuses ?? {}).map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`,
    `- Link-only messages penalized: ${stats.linkOnlyMessages ?? 0}; repeated-content messages penalized: ${stats.repeatedContentMessages ?? 0}`,
  ].join('\n');
}

function renderErrors(state = {}, inventory = {}, run = {}) {
  const taskErrors = values(state.tasks).filter((task) => task.status === 'failed' || task.status === 'retryable');
  const inventoryErrors = (inventory.guilds ?? []).filter((guild) => guild.channelError);
  const lines = [];
  for (const entry of state.errors ?? []) {
    const error = entry.error ?? {};
    const status = error.status == null ? '' : ` HTTP ${error.status}`;
    lines.push(`- Historical task \`${inline(entry.task)}\`: ${inline(error.message ?? `HTTP ${error.status ?? 'error'}`)}${status} (attempts: ${error.attempts ?? 'unknown'})`);
  }
  for (const task of taskErrors) lines.push(`- Task \`${inline(task.key ?? task.query)}\`: ${inline(task.status)}${task.lastError ? ` - ${inline(task.lastError.message ?? `HTTP ${task.lastError.status ?? 'error'}`)}` : ''}`);
  for (const guild of inventoryErrors) lines.push(`- Server \`${inline(guild.name)}\`: channel inventory failed (${inline(guild.channelError.message ?? `HTTP ${guild.channelError.status ?? 'error'}`)})`);
  for (const entry of Array.isArray(run.enrichment?.errors) ? run.enrichment.errors : []) {
    lines.push(`- Context enrichment for message \`${inline(entry.messageId)}\`: ${inline(entry.error?.message ?? 'unknown error')}`);
  }
  return lines.length ? lines.join('\n') : '- None recorded.';
}

function renderPartialTasks(state = {}) {
  const partial = values(state.tasks).filter((task) => task.status === 'partial');
  if (!partial.length) return 'none';
  return partial.map((task) => {
    const reasons = (task.partialReasons ?? []).map((reason) => PARTIAL_REASON_LABELS[reason] ?? reason).join('; ') || 'unknown reason';
    return `${inline(task.key ?? task.query)} (${task.fetchedCount ?? 0}/${task.reportedTotal ?? 0}; ${reasons})`;
  }).join(', ');
}

export function buildReport({ run = {}, inventory = {}, plan = {}, evidence = {}, state = {} } = {}) {
  const counts = taskStatusCounts(state);
  const coverage = assessCoverage(state, inventory, plan);
  const findings = renderFindings(evidence);
  const externalValidation = plan.externalValidation === true || run.externalValidation === true;
  const resultLead = findings
    ? 'The findings below are ranked Discord evidence candidates, not independent validation.'
    : coverage.level === 'yes'
      ? 'No relevant results were observed in the completed Discord coverage.'
      : coverage.level === 'scoped'
        ? 'Relevant results were not observed for the executed queries; skipped validation queries are not covered by this statement.'
        : 'Relevant results were not observed within the completed coverage; the run is incomplete.';

  const lines = [
    `# Discord Community Research Report`,
    '',
    `- Objective: ${inline(run.objective ?? plan.objective)}`,
    `- Date range: ${inline(dateRange(plan))}`,
    `- Generated: ${inline(run.generatedAt ?? evidence.generatedAt)}`,
    `- Evidence boundary: Discord-only by default. External validation: ${externalValidation ? 'enabled' : 'disabled'}.`,
    '',
    '## Coverage',
    '',
    `- Tasks: ${Object.keys(state.tasks ?? {}).length}; ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ') || 'no task status recorded'}`,
    renderCoverageLevel(coverage),
    ...[renderAbort(state)].filter(Boolean),
    '',
    renderInventory(inventory, state),
    '',
    '## Query Execution',
    '',
    renderTasks(state),
    '',
    '### Zero-Result Queries',
    '',
    renderQueryDiagnostics(state, plan),
    '',
    '## Findings',
    '',
    resultLead,
    findings ?? '- No ranked evidence candidates.',
    '',
    '## Community Signals',
    '',
    renderSignals(evidence.stats, evidence.coverage),
    '',
    '## Errors And Limits',
    '',
    `- Truncated tasks: ${values(state.tasks).filter((task) => task.status === 'truncated' || task.truncated).map((task) => `${inline(task.key ?? task.query)} (${task.fetchedCount ?? 0}/${task.reportedTotal ?? 0})`).join(', ') || 'none'}`,
    `- Partial tasks: ${renderPartialTasks(state)}`,
    renderErrors(state, inventory, run),
    '',
    '## Ambiguities And Unresolved Questions',
    '',
    (plan.ambiguities ?? []).length ? plan.ambiguities.map((item) => `- ${inline(typeof item === 'string' ? item : item.description ?? item.term)}`).join('\n') : '- None recorded in the search plan.',
    '',
    '## Validation Status',
    '',
    externalValidation
      ? '- External validation was enabled by the plan and must be interpreted separately from Discord evidence.'
      : '- External validation was disabled. This report makes no claim about repository activity, releases, documentation, or correctness outside Discord.',
    '',
  ];
  return lines.join('\n');
}

export function writeReport({ outputPath, input } = {}) {
  if (!outputPath) throw new TypeError('outputPath is required');
  const report = buildReport(input);
  writeTextAtomic(outputPath, report);
  return report;
}

if (process.argv[1]?.endsWith('build-report.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const files = values['run-dir'] ? runFiles(path.resolve(values['run-dir'])) : {};
    const inputs = {
      run: values.run ?? files.run,
      inventory: values.inventory ?? files.guilds,
      plan: values.plan ?? files.searchPlan,
      evidence: values.evidence ?? files.evidence,
      state: values.state ?? files.state,
    };
    const outputPath = values.output ?? files.report;
    const missing = Object.entries({ ...inputs, output: outputPath }).filter(([, value]) => !value).map(([name]) => `--${name}`);
    if (missing.length) throw new Error(`Pass --run-dir, or ${missing.join(', ')}`);
    const report = buildReport(Object.fromEntries(Object.entries(inputs).map(([name, file]) => [name, loadJson(file, {})])));
    writeTextAtomic(ensureOutputFile(outputPath), report);
    console.log(JSON.stringify({ output: outputPath }, null, 2));
  });
}
