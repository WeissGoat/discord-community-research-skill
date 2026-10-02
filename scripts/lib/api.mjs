const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_OFFSET = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const EMPTY_PAGE_THRESHOLD = 2;
const TRANSIENT_STATUSES = new Set([202, 429, 500, 502, 503, 504]);
// Stop reasons that end a walk before Discord's reported total was reached
// without hitting one of the plan's own limits.
const EARLY_STOP_REASONS = new Set(['empty-pages', 'no-window', 'lower-bound', 'window-stalled']);

export class DiscordApiError extends Error {
  constructor(message, { status = null, retryable = false, network = false, body = null, attempts = 0, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DiscordApiError';
    this.status = status;
    this.retryable = retryable;
    this.network = network;
    this.body = body;
    this.attempts = attempts;
  }
}

const DISCORD_EPOCH_MS = 1420070400000n;

export function snowflakeFromDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`Invalid date: ${String(value)}`);
  return ((BigInt(date.valueOf()) - DISCORD_EPOCH_MS) << 22n).toString();
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

// Bounds given on the command line may be message ids or dates.
export function snowflakeFromValue(value) {
  if (value == null || value === '') return null;
  return isSnowflake(String(value)) ? String(value) : snowflakeFromDate(value);
}

export function timestampFromSnowflake(id) {
  if (!isSnowflake(String(id ?? ''))) return null;
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

// Plan criteria keys and the Discord search parameters they become.
const LIST_FILTERS = {
  channelIds: 'channel_id',
  authorIds: 'author_id',
  authorType: 'author_type',
  mentions: 'mentions',
  mentionsRoleIds: 'mentions_role_id',
  repliedToUserIds: 'replied_to_user_id',
  repliedToMessageIds: 'replied_to_message_id',
  has: 'has',
  embedType: 'embed_type',
  embedProvider: 'embed_provider',
  linkHostname: 'link_hostname',
  attachmentFilename: 'attachment_filename',
  attachmentExtension: 'attachment_extension',
};
const LIST_ALIASES = {
  channelId: 'channelIds',
  authorId: 'authorIds',
  mentionsRoleId: 'mentionsRoleIds',
  repliedToUserId: 'repliedToUserIds',
  repliedToMessageId: 'repliedToMessageIds',
};
const BOOLEAN_FILTERS = { pinned: 'pinned', mentionEveryone: 'mention_everyone', includeNsfw: 'include_nsfw' };
const SCALAR_KEYS = ['content', 'minId', 'maxId', 'minDate', 'maxDate', 'slop', 'sortBy', 'sortOrder'];
const ALLOWED_VALUES = {
  authorType: ['user', 'bot', 'webhook'],
  has: ['image', 'sound', 'video', 'file', 'sticker', 'embed', 'link', 'poll', 'snapshot'],
  embedType: ['image', 'video', 'gif', 'sound', 'article'],
};
const NEGATABLE_FILTERS = new Set(['authorType', 'has']);
export const SEARCH_CRITERIA_KEYS = [...SCALAR_KEYS, ...Object.keys(BOOLEAN_FILTERS), ...Object.keys(LIST_FILTERS)];

function listValues(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => item != null && item !== '').map(String);
}

function criteriaEntries(criteria) {
  return Object.entries(criteria ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [LIST_ALIASES[key] ?? key, value, key]);
}

function scalarProblem(key, value) {
  if (key === 'slop' && !(Number.isInteger(value) && value >= 0 && value <= 100)) return 'slop must be an integer from 0 to 100';
  if (key === 'sortBy' && !['timestamp', 'relevance'].includes(value)) return 'sortBy must be timestamp or relevance';
  if (key === 'sortOrder' && !['asc', 'desc'].includes(value)) return 'sortOrder must be asc or desc';
  if (key === 'content' && String(value).length > 1024) return 'content is limited to 1024 characters';
  if ((key === 'minDate' || key === 'maxDate') && Number.isNaN(Date.parse(value))) return `${key} is not a date`;
  if ((key === 'minId' || key === 'maxId') && !isSnowflake(String(value))) return `${key} is not a message id`;
  return null;
}

// Discord answers a malformed filter with HTTP 400 on every server, so a plan
// is checked before the first request.
export function validateSearchCriteria(criteria = {}) {
  const problems = [];
  for (const [key, value, originalKey] of criteriaEntries(criteria)) {
    if (LIST_FILTERS[key]) {
      const values = listValues(value);
      const limit = key === 'channelIds' ? 500 : 100;
      if (values.length > limit) problems.push(`${originalKey} accepts at most ${limit} values`);
      for (const item of ALLOWED_VALUES[key] ? values : []) {
        const bare = NEGATABLE_FILTERS.has(key) && item.startsWith('-') ? item.slice(1) : item;
        if (!ALLOWED_VALUES[key].includes(bare)) {
          problems.push(`${originalKey} value "${item}" is not one of ${ALLOWED_VALUES[key].join(', ')}${NEGATABLE_FILTERS.has(key) ? ' (prefix - to exclude)' : ''}`);
        }
      }
    } else if (BOOLEAN_FILTERS[key]) {
      if (typeof value !== 'boolean') problems.push(`${originalKey} must be true or false`);
    } else if (SCALAR_KEYS.includes(key)) {
      const problem = scalarProblem(key, value);
      if (problem) problems.push(problem);
    } else {
      problems.push(`unknown search criteria "${originalKey}"`);
    }
  }
  if (problems.length) {
    throw new Error(`Invalid search criteria: ${problems.join('; ')}. Supported keys: ${SEARCH_CRITERIA_KEYS.join(', ')}`);
  }
  return criteria;
}

function redact(value, token) {
  if (!token || value == null) return value;
  if (typeof value === 'string') return value.split(token).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redact(item, token));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]));
  }
  return value;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

function retryAfterMs(body, headers, attempt, status) {
  const rawBodySeconds = body?.retry_after;
  const bodySeconds = rawBodySeconds == null ? Number.NaN : Number(rawBodySeconds);
  if (Number.isFinite(bodySeconds) && bodySeconds >= 0) return Math.ceil(bodySeconds * 1000);
  const rawHeaderSeconds = headers?.get?.('retry-after') ?? headers?.get?.('x-ratelimit-reset-after');
  const headerSeconds = rawHeaderSeconds == null ? Number.NaN : Number(rawHeaderSeconds);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return Math.ceil(headerSeconds * 1000);
  if (status === 202) return 1000;
  return Math.min(30000, 1000 * (2 ** Math.max(attempt - 1, 0)));
}

function networkFailureMessage(cause, timeoutMs) {
  if (cause?.name === 'TimeoutError') return `Discord request timed out after ${timeoutMs}ms`;
  const code = cause?.cause?.code ?? cause?.code ?? null;
  return code ? `Discord request failed after retries (${code})` : 'Discord request failed after retries';
}

function buildSearchPath(guildId, criteria = {}, offset = 0) {
  const params = new URLSearchParams();
  if (criteria.content) params.set('content', criteria.content);
  for (const [key, value] of criteriaEntries(criteria)) {
    if (LIST_FILTERS[key]) for (const item of listValues(value)) params.append(LIST_FILTERS[key], item);
    else if (BOOLEAN_FILTERS[key] && key !== 'includeNsfw' && typeof value === 'boolean') params.set(BOOLEAN_FILTERS[key], String(value));
  }
  // Many communities keep much of their work in age-restricted channels.
  if (criteria.includeNsfw !== false) params.set('include_nsfw', 'true');
  if (criteria.minId) params.set('min_id', criteria.minId);
  if (criteria.maxId) params.set('max_id', criteria.maxId);
  if (criteria.minDate) params.set('min_id', snowflakeFromDate(criteria.minDate));
  if (criteria.maxDate) params.set('max_id', snowflakeFromDate(criteria.maxDate));
  if (criteria.slop != null) params.set('slop', String(criteria.slop));
  if (criteria.sortBy) params.set('sort_by', criteria.sortBy);
  if (criteria.sortOrder) params.set('sort_order', criteria.sortOrder);
  if (offset > 0) params.set('offset', String(offset));
  return `/guilds/${encodeURIComponent(guildId)}/messages/search?${params.toString()}`;
}

function flattenMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return Array.isArray(messages[0]) ? messages.flat() : messages;
}

function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const id = message?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function createDiscordClient({
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = DEFAULT_MAX_RETRIES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  if (!token) throw new Error('Discord token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  async function fetchOnce(path) {
    const controller = new AbortController();
    // A referenced timer, unlike AbortSignal.timeout, keeps the process alive
    // until a hung request is aborted.
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Request timed out after ${requestTimeoutMs}ms`, 'TimeoutError')),
      requestTimeoutMs,
    );
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { authorization: token, 'content-type': 'application/json' },
        signal: controller.signal,
      });
      return { response, body: await readBody(response) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(path, { maxRetries: retryLimit = maxRetries } = {}) {
    let attempt = 0;
    while (true) {
      let response;
      let body = null;
      try {
        ({ response, body } = await fetchOnce(path));
      } catch (cause) {
        if (attempt >= retryLimit) {
          throw new DiscordApiError(networkFailureMessage(cause, requestTimeoutMs), {
            retryable: true,
            network: true,
            attempts: attempt + 1,
            cause,
          });
        }
        attempt += 1;
        await sleep(retryAfterMs(null, null, attempt, null));
        continue;
      }

      if (response.ok && response.status !== 202) return body;

      const retryable = TRANSIENT_STATUSES.has(response.status);
      if (!retryable || attempt >= retryLimit) {
        const safeBody = redact(body, token);
        throw new DiscordApiError(
          `Discord request failed with HTTP ${response.status}`,
          { status: response.status, retryable, body: safeBody, attempts: attempt + 1 },
        );
      }

      attempt += 1;
      await sleep(retryAfterMs(body, response.headers, attempt, response.status));
    }
  }

  const channelPath = (channelId) => `/channels/${encodeURIComponent(channelId)}`;
  const clampLimit = (limit, max) => String(Math.min(Math.max(Math.floor(Number(limit) || max), 1), max));

  // Read-only by design: the client exposes no endpoint that changes Discord state.
  return {
    getJson,
    whoami: (options) => getJson('/users/@me', options),
    inventoryGuilds: () => getJson('/users/@me/guilds'),
    inventoryChannels: (guildId) => getJson(`/guilds/${encodeURIComponent(guildId)}/channels`),
    searchPage: (guildId, criteria, offset = 0) => getJson(buildSearchPath(guildId, criteria, offset)),
    getChannel: (channelId) => getJson(channelPath(channelId)),
    // Discord honors one cursor per request: around, before, or after.
    fetchMessages: (channelId, { around, before, after, limit = 100 } = {}) => {
      const params = new URLSearchParams();
      if (around) params.set('around', around);
      else if (before) params.set('before', before);
      else if (after) params.set('after', after);
      params.set('limit', clampLimit(limit, 100));
      return getJson(`${channelPath(channelId)}/messages?${params.toString()}`);
    },
    fetchAround: (channelId, aroundId, limit = 11) => {
      const params = new URLSearchParams({ around: aroundId, limit: clampLimit(limit, 100) });
      return getJson(`${channelPath(channelId)}/messages?${params.toString()}`);
    },
    activeThreads: (guildId) => getJson(`/guilds/${encodeURIComponent(guildId)}/threads/active`),
    // public and private take an ISO timestamp cursor; joined takes a thread id.
    archivedThreads: (channelId, { scope = 'public', before, limit = 100 } = {}) => {
      const params = new URLSearchParams({ limit: clampLimit(limit, 100) });
      if (before) params.set('before', before);
      const path = scope === 'joined'
        ? `${channelPath(channelId)}/users/@me/threads/archived/private`
        : `${channelPath(channelId)}/threads/archived/${scope === 'private' ? 'private' : 'public'}`;
      return getJson(`${path}?${params.toString()}`);
    },
    // The endpoint Discord's own client uses for forum and media posts. Leaving
    // out `archived` returns active and archived posts together.
    searchThreads: (channelId, { offset = 0, limit = 25, sortBy = 'last_message_time', sortOrder = 'desc', name } = {}) => {
      const params = new URLSearchParams({ sort_by: sortBy, sort_order: sortOrder, limit: clampLimit(limit, 25), offset: String(offset) });
      if (name) {
        params.set('name', name);
        params.set('tag_setting', 'match_some');
      }
      return getJson(`${channelPath(channelId)}/threads/search?${params.toString()}`);
    },
  };
}

export function networkHint(env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxy && env.NODE_USE_ENV_PROXY !== '1') return 'HTTP(S)_PROXY is set, but Node fetch ignores it unless NODE_USE_ENV_PROXY=1.';
  if (proxy) return 'Check that the proxy in HTTPS_PROXY is running and can reach discord.com.';
  return 'If this machine reaches Discord through a local proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1.';
}

// One cheap request that tells an invalid token apart from a network problem
// before a run spends minutes retrying every task.
export async function checkAccess(client, { now = () => Date.now() } = {}) {
  const startedAt = now();
  try {
    const user = await client.whoami({ maxRetries: 1 });
    return { ok: true, latencyMs: now() - startedAt, user: { id: user?.id ?? null, username: user?.username ?? null } };
  } catch (error) {
    const kind = error?.status === 401 ? 'auth' : error?.network ? 'network' : 'http';
    return {
      ok: false,
      kind,
      status: error?.status ?? null,
      message: error?.message ?? String(error),
      latencyMs: now() - startedAt,
      hint: kind === 'network' ? networkHint() : kind === 'auth' ? 'Discord rejected the token; replace DISCORD_TOKEN (or VITE_DISCORD_TOKEN) where doctor.mjs reports it is loaded from.' : null,
    };
  }
}

export async function* iterateSearch({
  client,
  guildId,
  criteria = {},
  pageSize = 25,
  maxPages = Infinity,
  maxMessages = Infinity,
  maxOffset = DEFAULT_MAX_OFFSET,
  onPage,
} = {}) {
  if (!client?.searchPage) throw new TypeError('client.searchPage is required');
  let currentCriteria = { ...criteria };
  let offset = 0;
  let pageIndex = 0;
  let emptyPages = 0;
  let fetchedCount = 0;
  let initialTotal = null;
  let oldestTimestamp = null;
  let oldestId = null;
  let windowIds = new Set();
  let lastWindowUpper = currentCriteria.maxId ?? (currentCriteria.maxDate ? snowflakeFromDate(currentCriteria.maxDate) : null);
  const seen = new Set();
  const lowerBound = currentCriteria.minId ?? (currentCriteria.minDate ? snowflakeFromDate(currentCriteria.minDate) : null);
  // Date windows walk newest to oldest, which is only valid for timestamp-desc results.
  const canShiftWindow = (currentCriteria.sortBy ?? 'timestamp') === 'timestamp'
    && (currentCriteria.sortOrder ?? 'desc') === 'desc';

  while (pageIndex < maxPages) {
    const data = await client.searchPage(guildId, currentCriteria, offset);
    const rawMessages = uniqueMessages(flattenMessages(data?.messages));
    const pageMessages = rawMessages.filter((message) => !seen.has(message.id));
    for (const message of rawMessages) {
      seen.add(message.id);
      windowIds.add(message.id);
    }

    for (const message of pageMessages) {
      if (message.timestamp && (!oldestTimestamp || new Date(message.timestamp) < new Date(oldestTimestamp))) {
        oldestTimestamp = message.timestamp;
      }
      if (isSnowflake(message.id) && (!oldestId || BigInt(message.id) < BigInt(oldestId))) oldestId = message.id;
    }

    const remaining = Math.max(0, maxMessages - fetchedCount);
    const accepted = pageMessages.slice(0, remaining);
    fetchedCount += accepted.length;
    emptyPages = rawMessages.length === 0 ? emptyPages + 1 : 0;

    // total_results describes the current date window, not the whole walk.
    const totalResults = Number(data?.total_results ?? 0);
    initialTotal ??= totalResults;
    let stopReason = null;
    let nextUpper = null;
    if (totalResults > 0 && windowIds.size >= totalResults) stopReason = 'complete';
    else if (totalResults === 0 && rawMessages.length === 0) stopReason = 'complete';
    else if (fetchedCount >= maxMessages || pageIndex + 1 >= maxPages) stopReason = 'limit';
    else if (emptyPages >= EMPTY_PAGE_THRESHOLD) stopReason = 'empty-pages';
    else if (offset + pageSize >= maxOffset) {
      nextUpper = oldestId ?? (oldestTimestamp ? snowflakeFromDate(oldestTimestamp) : null);
      if (!canShiftWindow) stopReason = 'max-offset';
      else if (!nextUpper) stopReason = 'no-window';
      else if (lowerBound && BigInt(nextUpper) <= BigInt(lowerBound)) stopReason = 'lower-bound';
      else if (lastWindowUpper && BigInt(nextUpper) >= BigInt(lastWindowUpper)) stopReason = 'window-stalled';
    }

    const shortfall = totalResults - windowIds.size;
    const page = {
      pageIndex,
      offset,
      messages: accepted,
      totalResults,
      initialTotal,
      rawCount: rawMessages.length,
      fetchedCount,
      oldestTimestamp,
      stopReason,
      truncated: (stopReason === 'limit' || stopReason === 'max-offset') && fetchedCount < initialTotal,
      // Small gaps are normal because Discord's totals drift with edits and deletions.
      incomplete: EARLY_STOP_REASONS.has(stopReason) && shortfall > Math.max(2, totalResults * 0.05),
      deepHistoricalIndex: data?.doing_deep_historical_index === true,
      threads: Array.isArray(data?.threads) ? data.threads : [],
      criteria: { ...currentCriteria },
    };
    await onPage?.(page);
    yield page;

    if (stopReason) return;
    if (offset + pageSize < maxOffset) {
      offset += pageSize;
    } else {
      currentCriteria = { ...currentCriteria, maxId: nextUpper, maxDate: undefined };
      lastWindowUpper = nextUpper;
      windowIds = new Set();
      offset = 0;
    }
    pageIndex += 1;
  }
}
