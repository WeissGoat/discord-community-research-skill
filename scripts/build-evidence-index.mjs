#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { parseCommand, runCommand } from './lib/cli.mjs';
import { ensureOutputFile, readNdjson, loadJson, runFiles, writeJsonAtomic } from './lib/io.mjs';
import { normalizeMessage } from './lib/records.mjs';

export const COMMAND = {
  name: 'build-evidence-index',
  summary: 'Deduplicate, grade, and rank collected messages into evidence.json.',
  usage: '--run-dir <dir> | --messages <file> --output <file> [options]',
  options: {
    'run-dir': { type: 'string', value: '<dir>', description: 'use a run directory\'s messages, contexts, plan, and inventory, and write its evidence.json' },
    messages: { type: 'string', value: '<file>', description: 'messages NDJSON (search or history output)' },
    contexts: { type: 'list', value: '<file,...>', description: 'contexts NDJSON from enrich-hits; replaces the run directory\'s contexts' },
    plan: { type: 'string', value: '<file>', description: 'plan JSON for query purposes and filters' },
    inventory: { type: 'string', value: '<file>', description: 'guilds.json from inventory-guilds' },
    output: { type: 'string', value: '<file>', description: 'evidence JSON to write' },
    'require-all': { type: 'list', value: '<a,b>', description: 'keep only messages whose text contains every term' },
  },
};

// Each family pairs English word-boundary terms with Chinese (simplified and
// traditional) and Japanese terms, which have no word boundaries to anchor on.
const TECHNICAL_TERMS = [
  /\b(install|setup|configure|configuration|parameter|workflow|prompt|node|api|sdk|script|code|export|import|plugin|package|version|limit|limitation|bug|error|fix|compile|deploy|json|yaml|config)\b/i,
  /安装|安裝|部署|配置|设置|設置|設定|参数|參數|工作流|节点|節點|提示词|提示詞|插件|脚本|腳本|代码|代碼|导入|導入|导出|導出|版本|报错|報錯|错误|錯誤|修复|修復|采样器|採樣器|调度器|調度器|显存|顯存|インストール|ワークフロー|ノード|プロンプト|エラー/,
];
const DEMONSTRATION_TERMS = [
  /\b(demo|demonstrat|showcase|screenshot|video|gif|result|output|example|sample|proof|benchmark|working|works for me|in production)\b/i,
  /演示|展示|截图|截圖|视频|視頻|影片|效果|成品|出图|出圖|结果|結果|输出|輸出|示例|例子|样例|樣例|对比|對比|测试|測試|实测|實測|跑通|能用|可以用|作例/,
];
const REPEATED_USE_TERMS = [
  /\b(i use|we use|used it|using it|been using|works for us|multiple times|in production|daily|repeatedly|since)\b/i,
  /一直用|一直在用|长期用|長期用|经常用|經常用|天天用|每天用|日常用|用了很久|用了好久|用了一段时间|用了一段時間|我在用|我们在用|我們在用|常用|多次|反复|反覆|生产环境|生產環境/,
];
const DISCUSSION_TERMS = [
  /\b(how|why|what|when|where|can someone|does anyone|help|question|recommend|discussion|thoughts|anyone tried)\b|\?/i,
  /怎么|怎麼|如何|为什么|為什麼|为啥|為啥|什么|什麼|哪里|哪裡|哪个|哪個|有没有|有沒有|求助|请问|請問|推荐|推薦|讨论|討論|有人|？/,
];
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;
const OFFICIAL_CLAIM_TERMS = /\b(official|officially|apparently|reportedly|rumou?r|heard)\b|官方|听说|聽說|据说|據說|传闻|傳聞/i;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LINK_COMMENTARY_MIN_LENGTH = 12;

function matchesAny(patterns, content) {
  return patterns.some((pattern) => pattern.test(content));
}

// A CJK character carries about a word, so it counts double toward the
// commentary that keeps a message from being link-only.
function commentaryLength(content) {
  let length = 0;
  for (const char of String(content ?? '').replace(URL_PATTERN, '')) {
    if (LETTER_OR_NUMBER.test(char)) length += WIDE_SCRIPT.test(char) ? 2 : 1;
  }
  return length;
}

function isLinkOnly(record) {
  const content = String(record.content ?? '').trim();
  const urls = record.urls ?? extractUrls(content);
  return urls.length > 0 && commentaryLength(content) < LINK_COMMENTARY_MIN_LENGTH;
}
const PROJECT_LINK_PATTERN = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|gitee\.com|codeberg\.org|npmjs\.com|pypi\.org|huggingface\.co|civitai\.com)\//i;

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function extractUrls(content = '') {
  return [...String(content).matchAll(URL_PATTERN)].map((match) => match[0].replace(/[)\]}>.,;:!?]+$/, ''));
}

function asCandidateRecord(record = {}) {
  const normalized = normalizeMessage({
    ...record,
    id: record.id ?? record.messageId,
    guild_id: record.guild_id ?? record.guildId,
    channel_id: record.channel_id ?? record.channelId,
    message_reference: record.message_reference ?? record.replyReference,
    author: record.author && typeof record.author === 'object'
      ? record.author
      : { id: record.authorId, username: record.authorUsername ?? record.author, global_name: record.author },
  }, {
    guildId: record.guildId ?? record.guild_id,
    guildName: record.guildName,
    channelId: record.channelId ?? record.channel_id,
    channelName: record.channelName,
  });
  const content = record.content ?? normalized.content;
  return {
    ...normalized,
    ...record,
    guildId: record.guildId ?? record.guild_id ?? normalized.guildId,
    guildName: record.guildName ?? normalized.guildName,
    channelId: record.channelId ?? record.channel_id ?? normalized.channelId,
    channelName: record.channelName ?? normalized.channelName,
    messageId: record.messageId ?? record.id ?? normalized.messageId,
    timestamp: record.timestamp ?? normalized.timestamp,
    content,
    authorId: record.authorId ?? normalized.authorId,
    author: typeof record.author === 'string' ? record.author : normalized.author,
    authorUsername: record.authorUsername ?? normalized.authorUsername,
    urls: unique([...(normalized.urls ?? []), ...(record.urls ?? []), ...extractUrls(content)]),
    attachments: record.attachments ?? normalized.attachments,
    embeds: record.embeds ?? normalized.embeds,
    matchedQueries: unique([...(normalized.matchedQueries ?? []), ...(record.matchedQueries ?? [])]),
    jumpUrl: record.jumpUrl ?? normalized.jumpUrl,
  };
}

function canonicalKey(record) {
  return `${record.guildId ?? ''}/${record.channelId ?? ''}/${record.messageId ?? ''}`;
}

function mergeRecords(existing, incoming) {
  const merged = { ...existing, ...incoming };
  for (const field of ['guildName', 'channelName', 'timestamp', 'content', 'authorId', 'author', 'authorUsername', 'jumpUrl']) {
    if ((merged[field] == null || merged[field] === '') && existing[field] != null) merged[field] = existing[field];
  }
  merged.matchedQueries = unique([...(existing.matchedQueries ?? []), ...(incoming.matchedQueries ?? [])]);
  merged.urls = unique([...(existing.urls ?? []), ...(incoming.urls ?? [])]);
  merged.attachments = incoming.attachments?.length ? incoming.attachments : existing.attachments ?? [];
  merged.embeds = incoming.embeds?.length ? incoming.embeds : existing.embeds ?? [];
  return merged;
}

function contextFor(record, contexts) {
  const key = canonicalKey(record);
  return contexts.find((context) => canonicalKey(context?.target ?? {}) === key) ?? null;
}

function contextSignals(context) {
  if (!context) return { contextMessages: 0, replyCount: 0, hasThreadRoot: false, hasForumTitle: false };
  const root = context.threadRoot;
  return {
    contextMessages: (context.before?.length ?? 0) + (context.after?.length ?? 0),
    replyCount: context.replyChain?.length ?? 0,
    // A root that was only referenced by id carries no context.
    hasThreadRoot: Boolean(root?.content || root?.attachments?.length),
    hasForumTitle: Boolean(context.forumTitle),
  };
}

// Search results never include reactions; enrichment fetches them from
// channel history, so a counted context target wins over the search record.
function knownReactionCount(record, context) {
  const fromContext = context?.target?.reactionCount;
  if (Number.isFinite(fromContext)) return fromContext;
  return Number.isFinite(record.reactionCount) ? record.reactionCount : null;
}

function channelIndex(inventory = {}) {
  const index = new Map();
  for (const guild of inventory.guilds ?? []) {
    for (const channel of guild.channels ?? []) {
      index.set(String(guild.id) + '/' + String(channel.id), { guildName: guild.name ?? null, channelName: channel.name ?? null });
    }
  }
  return index;
}

function requiredTerms(queryPlan = {}) {
  const terms = queryPlan.filters?.requireAll ?? queryPlan.requireAll ?? [];
  return (Array.isArray(terms) ? terms : String(terms).split(',')).map((term) => String(term).trim()).filter(Boolean);
}

function matchesRequiredTerms(record, terms) {
  const content = String(record.content ?? '').toLocaleLowerCase();
  return terms.every((term) => content.includes(term.toLocaleLowerCase()));
}

function evidenceStatus(record) {
  if ((record.urls ?? []).some((url) => PROJECT_LINK_PATTERN.test(url))) return 'project-linked';
  if (OFFICIAL_CLAIM_TERMS.test(record.content ?? '')) return 'unverified-claim';
  return 'community-only';
}

// Grades describe the message itself; thread placement affects ordering only,
// otherwise every reply near a forum post's opening message would read as E3.
export function gradeEvidence(record = {}) {
  const content = String(record.content ?? '').trim();
  const hasAttachment = (record.attachments?.length ?? 0) > 0 || (record.embeds?.length ?? 0) > 0;
  if (!content && !hasAttachment) return 'E0';
  if (isLinkOnly(record) && !record.contextSignals?.contextMessages) return 'E0';
  if (matchesAny(REPEATED_USE_TERMS, content) && (matchesAny(TECHNICAL_TERMS, content) || matchesAny(DEMONSTRATION_TERMS, content))) return 'E4';
  if (matchesAny(DEMONSTRATION_TERMS, content) || hasAttachment) return 'E3';
  if (matchesAny(TECHNICAL_TERMS, content)) return 'E2';
  if (matchesAny(DISCUSSION_TERMS, content) || content.length > 16) return 'E1';
  return 'E0';
}

function gradeReason(grade) {
  return {
    E0: 'name-only or link-only mention',
    E1: 'discussion, question, or general mention',
    E2: 'technical, setup, workflow, or limitation detail',
    E3: 'demonstration, concrete result, or attachment',
    E4: 'repeated-use language plus technical or demonstrated detail',
  }[grade] ?? 'unclassified Discord evidence';
}

function recencySignal(timestamp, now) {
  const time = Date.parse(timestamp ?? '');
  const current = Date.parse(now ?? '');
  if (!Number.isFinite(time) || !Number.isFinite(current)) return 0;
  const ageDays = Math.max(0, (current - time) / 86400000);
  return Math.max(0, 1 - ageDays / 365);
}

function normalizedContent(content) {
  return String(content ?? '').toLowerCase().replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function linkOnlyPenalty(record) {
  return isLinkOnly(record) ? 2 : 0;
}

function buildCoverage(queryPlan = {}) {
  const queries = Array.isArray(queryPlan.queries) ? queryPlan.queries : [];
  return {
    plannedQueries: queries.length,
    discoveryQueries: queries.filter((query) => query.purpose === 'discovery').length,
    validationQueries: queries.filter((query) => query.purpose === 'validation').length,
  };
}

export function buildEvidenceIndex({ messages = [], contexts = [], queryPlan = {}, inventory = {}, now = new Date().toISOString() } = {}) {
  const deduped = new Map();
  let duplicateMessages = 0;
  for (const raw of messages) {
    const record = asCandidateRecord(raw);
    const key = canonicalKey(record);
    if (!record.messageId || !record.channelId) continue;
    if (deduped.has(key)) {
      duplicateMessages += 1;
      deduped.set(key, mergeRecords(deduped.get(key), record));
    } else {
      deduped.set(key, record);
    }
  }

  const allRecords = [...deduped.values()];
  const inventoryChannels = channelIndex(inventory);
  for (const record of allRecords) {
    const mapped = inventoryChannels.get(String(record.guildId) + '/' + String(record.channelId));
    if (mapped) {
      record.guildName ??= mapped.guildName;
      record.channelName ??= mapped.channelName;
    }
  }
  const terms = requiredTerms(queryPlan);
  const records = terms.length ? allRecords.filter((record) => matchesRequiredTerms(record, terms)) : allRecords;
  const authors = new Set(records.map((record) => record.authorId).filter(Boolean));
  const guilds = new Set(records.map((record) => record.guildId).filter(Boolean));
  const channels = new Set(records.map((record) => canonicalKey({ guildId: record.guildId, channelId: record.channelId })).filter(Boolean));
  const contentCounts = new Map();
  for (const record of records) {
    const contentKey = normalizedContent(record.content);
    if (contentKey) contentCounts.set(contentKey, (contentCounts.get(contentKey) ?? 0) + 1);
  }

  const candidates = records.map((record) => {
    const context = contextFor(record, contexts);
    const contextSignalsValue = contextSignals(context);
    const grade = gradeEvidence({ ...record, contextSignals: contextSignalsValue });
    const technicalDensity = [TECHNICAL_TERMS, DEMONSTRATION_TERMS, REPEATED_USE_TERMS].filter((patterns) => matchesAny(patterns, record.content ?? '')).length;
    const repeatedContent = (contentCounts.get(normalizedContent(record.content)) ?? 0) > 1;
    const reactionCount = knownReactionCount(record, context);
    // Bot output (feeds, AI chat companions) is not community testimony, however
    // technical it reads; messages several queries found are more on-topic.
    const penalties = {
      linkOnly: linkOnlyPenalty(record),
      repeatedContent: repeatedContent ? 0.75 : 0,
      botAuthor: record.isBot ? 3 : 0,
    };
    const queryBreadth = Math.min(2, Math.max(0, record.matchedQueries.length - 1) * 0.75);
    const signals = {
      distinctAuthors: authors.size,
      distinctGuilds: guilds.size,
      distinctChannels: channels.size,
      recency: recencySignal(record.timestamp, now),
      technicalDensity,
      contextMessages: contextSignalsValue.contextMessages,
      replyCount: contextSignalsValue.replyCount,
      reactionCount,
      reactionSignal: reactionCount ? Number(Math.min(2, Math.log2(1 + reactionCount) * 0.5).toFixed(3)) : 0,
      queryBreadth,
    };
    const score = Number((
      technicalDensity * 2
      + signals.recency
      + Math.min(1, signals.contextMessages / 4)
      + Math.min(1, signals.replyCount / 2)
      + signals.reactionSignal
      + queryBreadth
      - penalties.linkOnly
      - penalties.botAuthor
      - penalties.repeatedContent
    ).toFixed(3));
    return {
      ...record,
      matchedQueries: [...record.matchedQueries].sort(),
      reactionCount,
      grade,
      gradeReason: gradeReason(grade),
      evidenceStatus: evidenceStatus(record),
      score,
      signals,
      penalties,
      repeatedContent,
      contextSummary: context ? {
        before: context.before?.length ?? 0,
        after: context.after?.length ?? 0,
        replyChain: context.replyChain?.length ?? 0,
        forumTitle: context.forumTitle ?? record.forumTitle ?? null,
        threadRoot: context.threadRoot?.messageId ?? null,
      } : null,
    };
  }).sort((left, right) => right.score - left.score || String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? '')) || canonicalKey(left).localeCompare(canonicalKey(right)));

  const grades = Object.fromEntries(['E0', 'E1', 'E2', 'E3', 'E4'].map((grade) => [grade, candidates.filter((candidate) => candidate.grade === grade).length]));
  const queryMatches = {};
  for (const candidate of candidates) {
    for (const query of candidate.matchedQueries) queryMatches[query] = (queryMatches[query] ?? 0) + 1;
  }

  return {
    generatedAt: now,
    candidates,
    stats: {
      rawMessages: messages.length,
      uniqueMessages: candidates.length,
      duplicateMessages,
      filteredOutMessages: allRecords.length - records.length,
      distinctAuthors: authors.size,
      distinctGuilds: guilds.size,
      distinctChannels: channels.size,
      messagesWithReactions: candidates.filter((candidate) => candidate.reactionCount > 0).length,
      reactionCountsKnown: candidates.filter((candidate) => Number.isFinite(candidate.reactionCount)).length,
      totalReactionCount: candidates.reduce((total, candidate) => total + (Number.isFinite(candidate.reactionCount) ? candidate.reactionCount : 0), 0),
      matchedQueryCount: Object.keys(queryMatches).length,
      queryMatches,
      grades,
      linkOnlyMessages: candidates.filter((candidate) => candidate.penalties.linkOnly > 0).length,
      repeatedContentMessages: candidates.filter((candidate) => candidate.repeatedContent).length,
      evidenceStatuses: Object.fromEntries(
        ['project-linked', 'unverified-claim', 'community-only']
          .map((status) => [status, candidates.filter((candidate) => candidate.evidenceStatus === status).length]),
      ),
    },
    coverage: { ...buildCoverage(queryPlan), requireAll: terms },
  };
}

if (process.argv[1]?.endsWith('build-evidence-index.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const files = values['run-dir'] ? runFiles(path.resolve(values['run-dir'])) : {};
    const messagesPath = values.messages ?? files.messages;
    const outputPath = values.output ?? files.evidence;
    if (!messagesPath || !outputPath) throw new Error('Pass --run-dir, or --messages and --output');
    const contextPaths = values.contexts ?? (files.contexts && fs.existsSync(files.contexts) ? [files.contexts] : []);
    const queryPlan = loadJson(values.plan ?? files.searchPlan ?? '', {}) ?? {};
    if (values['require-all']?.length) queryPlan.filters = { ...(queryPlan.filters ?? {}), requireAll: values['require-all'] };
    const evidence = buildEvidenceIndex({
      messages: readNdjson(messagesPath),
      contexts: contextPaths.flatMap((contextPath) => readNdjson(contextPath)),
      queryPlan,
      inventory: loadJson(values.inventory ?? files.guilds ?? '', {}) ?? {},
    });
    writeJsonAtomic(ensureOutputFile(outputPath), evidence);
    console.log(JSON.stringify({ output: outputPath, candidates: evidence.candidates.length, uniqueMessages: evidence.stats.uniqueMessages }, null, 2));
  });
}
