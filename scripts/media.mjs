#!/usr/bin/env node
import path from 'node:path';

import { createClientFromOptions, parseCommand, runCommand } from './lib/cli.mjs';
import { ensurePrivateDirectory, loadJson, loadJsonOrNdjson, writeJsonAtomic } from './lib/io.mjs';
import { collectMessageRecords, DEFAULT_MEDIA_TYPES, downloadMedia, mergeWithPrevious, selectAttachments } from './lib/media.mjs';

export const COMMAND = {
  name: 'media',
  summary: 'List image and file attachments from collected messages, and optionally download them with a manifest.',
  usage: '--input <file,...> --output <dir> [options]',
  discord: true,
  options: {
    input: { type: 'list', value: '<file,...>', description: 'history or search NDJSON, enrich-hits contexts, evidence.json, or threads.json', required: true },
    output: { type: 'string', value: '<dir>', description: 'directory for media.json and downloaded files', required: true },
    types: { type: 'list', value: '<ext,...>', description: 'file extensions to keep, or all', default: DEFAULT_MEDIA_TYPES },
    'min-dimension': { type: 'number', value: '<px>', description: 'minimum width and height', default: 0 },
    'min-bytes': { type: 'number', value: '<n>', description: 'minimum file size in bytes', default: 0 },
    download: { type: 'boolean', description: 'download the files into <output>/files' },
    concurrency: { type: 'number', value: '<n>', description: 'parallel downloads', default: 3 },
    retries: { type: 'number', value: '<n>', description: 'retries per file after network errors, 429, or 5xx', default: 3 },
    'timeout-ms': { type: 'number', value: '<ms>', description: 'per-download timeout', default: 60000 },
  },
  notes: [
    'Rerunning with the same --output keeps files already downloaded.',
    'Expired attachment links are refreshed by re-reading their message, which needs the Discord token; listing does not.',
  ],
};

// Re-reads a message to get freshly signed attachment links.
export function createLinkRefresher(client) {
  const messages = new Map();
  return async (item) => {
    const key = `${item.channelId}/${item.messageId}`;
    if (!messages.has(key)) {
      messages.set(key, Promise.resolve(client.fetchAround(item.channelId, item.messageId, 1))
        .then((page) => (Array.isArray(page) ? page : []).find((message) => message.id === item.messageId) ?? null));
    }
    const attachments = (await messages.get(key))?.attachments ?? [];
    const match = attachments.find((attachment) => item.attachmentId && attachment.id === item.attachmentId)
      ?? attachments.find((attachment) => attachment.filename === item.filename)
      ?? null;
    return match?.url ?? null;
  };
}

export function summarizeMedia(items) {
  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    attachments: items.length,
    messages: new Set(items.map((item) => `${item.channelId}/${item.messageId}`)).size,
    downloaded: count('downloaded'),
    existing: count('existing'),
    failed: count('failed'),
    listed: count('listed'),
  };
}

if (process.argv[1]?.endsWith('media.mjs')) {
  const { values } = parseCommand(COMMAND);
  await runCommand(async () => {
    const records = new Map();
    for (const file of values.input) collectMessageRecords(loadJsonOrNdjson(file), records);
    const filters = { types: values.types, minDimension: values['min-dimension'], minBytes: values['min-bytes'] };
    const manifestPath = path.join(ensurePrivateDirectory(values.output), 'media.json');
    let items = mergeWithPrevious(selectAttachments([...records.values()], filters), loadJson(manifestPath, null)?.items);

    if (values.download) {
      let client = null;
      try {
        client = createClientFromOptions(values);
      } catch {
        process.stderr.write('[media] no Discord token: expired links cannot be refreshed\n');
      }
      let done = 0;
      items = await downloadMedia({
        items,
        directory: values.output,
        concurrency: values.concurrency,
        retries: values.retries,
        timeoutMs: values['timeout-ms'],
        refresh: client ? createLinkRefresher(client) : null,
        onItem: (item) => {
          done += 1;
          if (item.status === 'failed' || done % 25 === 0 || done === items.length) {
            process.stderr.write(`[media] ${done}/${items.length} ${item.status}${item.error ? ` (${item.error})` : ''} ${item.filename ?? ''}\n`);
          }
        },
      });
    }

    const totals = summarizeMedia(items);
    writeJsonAtomic(manifestPath, { generatedAt: new Date().toISOString(), inputs: values.input, filters, totals, items });
    console.log(JSON.stringify({ manifest: manifestPath, messagesScanned: records.size, ...totals }, null, 2));
    if (totals.failed) process.exitCode = 1;
  });
}
