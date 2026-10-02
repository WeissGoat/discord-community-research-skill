#!/usr/bin/env node
import { createClientFromOptions, parseCommand, runCommand } from './lib/cli.mjs';
import { createRunDirectory, ensureOutputFile, sanitizeError, writeJsonAtomic } from './lib/io.mjs';

export const COMMAND = {
  name: 'inventory-guilds',
  summary: 'List joined servers and their channels.',
  discord: true,
  options: {
    output: { type: 'string', value: '<file>', description: 'write the inventory JSON here instead of a run directory' },
    'output-root': { type: 'string', value: '<dir>', description: 'parent of run directories (default discord_research/runs)' },
    'run-id': { type: 'string', value: '<id>', description: 'run directory name (default: a timestamp)' },
  },
};

export async function inventoryGuilds({ client, outputPath = null, now = new Date().toISOString() } = {}) {
  if (!client?.inventoryGuilds || !client?.inventoryChannels) throw new TypeError('client inventory methods are required');
  const rawGuilds = await client.inventoryGuilds();
  const guilds = [];

  for (const guild of Array.isArray(rawGuilds) ? rawGuilds : []) {
    const record = {
      id: guild.id,
      name: guild.name ?? null,
      icon: guild.icon ?? null,
      owner: guild.owner ?? null,
      channels: [],
      channelError: null,
    };
    try {
      const channels = await client.inventoryChannels(guild.id);
      record.channels = (Array.isArray(channels) ? channels : []).map((channel) => ({
        id: channel.id,
        name: channel.name ?? null,
        type: channel.type ?? null,
        parentId: channel.parent_id ?? channel.parentId ?? null,
        position: channel.position ?? null,
        threadMetadata: channel.thread_metadata ?? null,
      }));
    } catch (error) {
      record.channelError = sanitizeError(error);
    }
    guilds.push(record);
  }

  const result = {
    generatedAt: now,
    guilds,
    totals: {
      joinedGuilds: guilds.length,
      accessibleChannelInventories: guilds.filter((guild) => !guild.channelError).length,
      inaccessibleChannelInventories: guilds.filter((guild) => guild.channelError).length,
    },
  };
  if (outputPath) writeJsonAtomic(outputPath, result);
  return result;
}

if (process.argv[1]?.endsWith('inventory-guilds.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const client = createClientFromOptions(values);
    const outputPath = values.output ? ensureOutputFile(values.output) : createRunDirectory({ outputRoot: values['output-root'], runId: values['run-id'] }).guilds;
    const result = await inventoryGuilds({ client, outputPath });
    console.log(JSON.stringify({ output: outputPath, ...result.totals }, null, 2));
  });
}
