const THREAD_TYPES = new Set([10, 11, 12]);

export function isThreadType(type) {
  return THREAD_TYPES.has(type);
}

// Location fields a thread record (from threads.mjs) already carries.
function knownLocation(id, known) {
  if (!known?.guildId || !known?.name) return null;
  // A text channel's parentId is its category, so only the type marks a thread.
  const thread = isThreadType(known.type) || (known.type == null && known.parentType != null)
    ? { id, name: known.name, parentId: known.parentId ?? null, parentName: known.parentName ?? null, parentType: known.parentType ?? null }
    : null;
  return {
    id,
    type: known.type ?? null,
    name: known.name,
    guildId: known.guildId,
    guildName: known.guildName ?? null,
    channelName: thread ? null : known.name,
    thread,
  };
}

// Caches channel, parent, and server lookups so many ids cost few requests.
export function createChannelResolver(client) {
  const channels = new Map();
  let guildNames = null;

  function channel(id) {
    if (!channels.has(id)) channels.set(id, client.getChannel(id));
    return channels.get(id);
  }

  async function guildName(guildId) {
    if (!guildId || typeof client.inventoryGuilds !== 'function') return null;
    guildNames ??= Promise.resolve(client.inventoryGuilds())
      .then((guilds) => new Map((Array.isArray(guilds) ? guilds : []).map((guild) => [guild.id, guild.name ?? null])))
      .catch(() => new Map());
    return (await guildNames).get(guildId) ?? null;
  }

  // The fields normalizeMessage needs for messages of one channel or thread.
  async function location(id, known = null) {
    const fromKnown = knownLocation(id, known);
    if (fromKnown) return fromKnown;
    const info = await channel(id);
    const guildId = info?.guild_id ?? known?.guildId ?? null;
    let thread = null;
    if (isThreadType(info?.type)) {
      const parent = info.parent_id ? await channel(info.parent_id).catch(() => null) : null;
      thread = {
        id,
        name: info.name ?? null,
        parentId: info.parent_id ?? null,
        parentName: parent?.name ?? null,
        parentType: parent?.type ?? null,
      };
    }
    return {
      id,
      type: info?.type ?? null,
      name: info?.name ?? null,
      guildId,
      guildName: known?.guildName ?? await guildName(guildId),
      channelName: thread ? null : info?.name ?? null,
      thread,
      availableTags: info?.available_tags ?? [],
    };
  }

  return { channel, guildName, location };
}
