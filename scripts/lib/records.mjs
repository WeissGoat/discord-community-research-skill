const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
// Forum and media channels hold posts whose thread name is the post title.
export const FORUM_CHANNEL_TYPES = new Set([15, 16]);

function cleanUrl(value) {
  return String(value || '').replace(/[)\]}>.,;:!?]+$/, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function cleanContent(value, maxLength = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function extractUrls(content, embeds = []) {
  const contentUrls = [...String(content || '').matchAll(URL_PATTERN)].map((match) => cleanUrl(match[0]));
  const embedUrls = embeds.flatMap((embed) => [embed?.url, embed?.thumbnail?.url, embed?.image?.url].map(cleanUrl));
  return unique([...contentUrls, ...embedUrls]);
}

function normalizeReplyReference(reference) {
  if (!reference) return null;
  return {
    messageId: reference.message_id ?? reference.messageId ?? null,
    channelId: reference.channel_id ?? reference.channelId ?? null,
    guildId: reference.guild_id ?? reference.guildId ?? null,
    type: reference.type ?? null,
  };
}

function normalizeEmbeds(embeds) {
  return (Array.isArray(embeds) ? embeds : []).map((embed) => ({
    title: cleanContent(embed?.title, 500) || null,
    description: cleanContent(embed?.description, 1500) || null,
    url: cleanUrl(embed?.url) || null,
    type: embed?.type ?? null,
  }));
}

function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    id: attachment?.id ?? null,
    filename: attachment?.filename ?? null,
    contentType: attachment?.content_type ?? attachment?.contentType ?? null,
    size: attachment?.size ?? null,
    width: attachment?.width ?? null,
    height: attachment?.height ?? null,
    // CDN URLs are retained as metadata only; reports should cite jumpUrl.
    url: attachment?.url ?? null,
  }));
}

function normalizeReactions(reactions) {
  return (Array.isArray(reactions) ? reactions : []).map((reaction) => ({
    count: Number.isFinite(Number(reaction?.count)) ? Number(reaction.count) : 0,
    me: reaction?.me === true,
    emoji: {
      id: reaction?.emoji?.id ?? null,
      name: reaction?.emoji?.name ?? null,
      animated: reaction?.emoji?.animated === true,
    },
  }));
}

function knownCount(value) {
  return Number.isFinite(value) ? value : null;
}

// Search results never carry reactions, so a missing count is unknown rather
// than zero; callers pass reactionsKnown when the payload came from history.
export function normalizeMessage(message, context = {}) {
  const embeds = normalizeEmbeds(message?.embeds);
  const guildId = context.guildId ?? message?.guild_id ?? null;
  const channelId = context.channelId ?? message?.channel_id ?? null;
  const messageId = message?.id ?? null;
  const query = context.query ?? null;
  const urls = extractUrls(message?.content, embeds);
  const author = message?.author ?? {};
  const reactions = normalizeReactions(message?.reactions);
  const reactionsKnown = context.reactionsKnown ?? Array.isArray(message?.reactions);
  const thread = context.thread ?? null;

  return {
    guildId,
    guildName: context.guildName ?? null,
    channelId,
    channelName: context.channelName ?? thread?.name ?? null,
    threadId: thread?.id ?? null,
    threadName: thread?.name ?? null,
    parentChannelId: thread?.parentId ?? null,
    parentChannelName: thread?.parentName ?? null,
    forumTitle: thread && FORUM_CHANNEL_TYPES.has(thread.parentType) ? thread.name ?? null : null,
    threadRootId: thread?.id ?? null,
    messageId,
    timestamp: message?.timestamp ?? null,
    messageType: message?.type ?? 0,
    authorId: author.id ?? null,
    author: author.global_name ?? author.globalName ?? author.username ?? null,
    authorUsername: author.username ?? null,
    isBot: author.bot === true,
    content: cleanContent(message?.content),
    urls,
    attachments: normalizeAttachments(message?.attachments),
    embeds,
    reactions,
    reactionCount: reactionsKnown ? reactions.reduce((total, reaction) => total + reaction.count, 0) : null,
    replyReference: normalizeReplyReference(message?.message_reference ?? message?.messageReference),
    matchedQueries: query ? [query] : [],
    jumpUrl: guildId && channelId && messageId
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : null,
  };
}

export function mergeMessageRecords(existing, incoming) {
  const queries = unique([...(existing?.matchedQueries ?? []), ...(incoming?.matchedQueries ?? [])]);
  return {
    ...existing,
    ...incoming,
    guildName: incoming.guildName ?? existing.guildName ?? null,
    channelName: incoming.channelName ?? existing.channelName ?? null,
    matchedQueries: queries,
    urls: unique([...(existing?.urls ?? []), ...(incoming?.urls ?? [])]),
    reactions: incoming.reactions?.length ? incoming.reactions : existing.reactions ?? [],
    reactionCount: knownCount(incoming?.reactionCount) ?? knownCount(existing?.reactionCount),
  };
}

export function messageKey(message) {
  return `${message?.guildId ?? ''}/${message?.channelId ?? ''}/${message?.messageId ?? ''}`;
}
