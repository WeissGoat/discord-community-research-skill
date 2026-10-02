import { snowflakeFromValue, timestampFromSnowflake } from './api.mjs';

const PAGE_SIZE = 100;
// A walk that ends for these reasons saw everything in its requested range.
export const COMPLETE_HISTORY_REASONS = new Set(['start-of-channel', 'after-bound']);

function idValue(id) {
  return /^\d+$/.test(String(id ?? '')) ? BigInt(id) : null;
}

function oldestMessage(messages) {
  return messages.reduce((oldest, message) => {
    const id = idValue(message?.id);
    return id != null && (!oldest || id < idValue(oldest.id)) ? message : oldest;
  }, null);
}

// Walks one channel or thread from newest to oldest with the `before` cursor
// and yields every page as it arrives so callers can persist progress. A
// failed request throws; it never looks like the start of the channel.
export async function* iterateHistory({
  client,
  channelId,
  after = null,
  before = null,
  maxPages = Infinity,
  maxMessages = Infinity,
} = {}) {
  if (!client?.fetchMessages) throw new TypeError('client.fetchMessages is required');
  const lowerBound = idValue(snowflakeFromValue(after));
  let cursor = snowflakeFromValue(before);
  let fetchedCount = 0;

  for (let pageIndex = 0; ; pageIndex += 1) {
    const page = await client.fetchMessages(channelId, { before: cursor ?? undefined, limit: PAGE_SIZE });
    const raw = Array.isArray(page) ? page : [];
    const inRange = lowerBound == null ? raw : raw.filter((message) => (idValue(message?.id) ?? 0n) > lowerBound);
    const messages = inRange.slice(0, Math.max(0, maxMessages - fetchedCount));
    fetchedCount += messages.length;
    const oldest = oldestMessage(raw);

    let stopReason = null;
    if (messages.length < inRange.length) stopReason = 'max-messages';
    else if (lowerBound != null && oldest && idValue(oldest.id) <= lowerBound) stopReason = 'after-bound';
    else if (raw.length < PAGE_SIZE || !oldest) stopReason = 'start-of-channel';
    else if (fetchedCount >= maxMessages) stopReason = 'max-messages';
    else if (pageIndex + 1 >= maxPages) stopReason = 'max-pages';

    yield {
      pageIndex,
      messages,
      rawCount: raw.length,
      fetchedCount,
      oldestTimestamp: oldest?.timestamp ?? timestampFromSnowflake(oldest?.id),
      stopReason,
      complete: COMPLETE_HISTORY_REASONS.has(stopReason),
    };
    if (stopReason) return;
    cursor = oldest.id;
  }
}
