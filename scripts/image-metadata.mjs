#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseCommand, runCommand } from './lib/cli.mjs';
import { readImageMetadata } from './lib/image-metadata.mjs';
import { ensureOutputFile, loadJson, writeNdjsonAtomic } from './lib/io.mjs';

export const COMMAND = {
  name: 'image-metadata',
  summary: 'Read generation parameters embedded in PNG, JPEG, and WebP files (NovelAI, ComfyUI, A1111/Forge) and check NovelAI completeness.',
  usage: '(<file|dir> ... | --manifest <media.json>) --output <file> [options]',
  positionals: true,
  options: {
    manifest: { type: 'string', value: '<file>', description: 'media.json from media.mjs; reads its downloaded files and keeps their Discord links' },
    output: { type: 'string', value: '<file>', description: 'NDJSON with one record per image', required: true },
    'include-raw': { type: 'boolean', description: 'keep every text chunk and EXIF field (workflow JSON can be large)' },
  },
  notes: ['Metadata hidden in pixels (NovelAI stealth info) is not decoded; an image without text metadata is unknown, not proof of another generator.'],
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DISCORD_FIELDS = ['jumpUrl', 'messageId', 'channelId', 'guildName', 'channelName', 'threadName', 'forumTitle', 'author', 'timestamp', 'reactionCount'];

function filesFrom(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`Not found: ${input}`);
    if (!fs.statSync(input).isDirectory()) {
      files.push({ file: input, discord: null });
      continue;
    }
    for (const entry of fs.readdirSync(input, { recursive: true })) {
      const file = path.join(input, entry);
      if (IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) && fs.statSync(file).isFile()) files.push({ file, discord: null });
    }
  }
  return files;
}

function filesFromManifest(manifestPath) {
  const manifest = loadJson(manifestPath, null);
  if (!manifest) throw new Error(`Manifest not found: ${manifestPath}`);
  return (manifest.items ?? [])
    .filter((item) => item.localPath && ['downloaded', 'existing'].includes(item.status))
    .map((item) => ({
      file: path.join(path.dirname(manifestPath), item.localPath),
      discord: Object.fromEntries(DISCORD_FIELDS.map((field) => [field, item[field] ?? null])),
    }));
}

export function describeImage({ file, discord = null }, { includeRaw = false } = {}) {
  const buffer = fs.readFileSync(file);
  const metadata = readImageMetadata(buffer);
  return {
    file,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    metadataKeys: Object.keys(metadata.text),
    exifFields: Object.keys(metadata.exif ?? {}),
    hasXmp: Boolean(metadata.xmp),
    generation: metadata.generation,
    discord,
    ...(includeRaw ? { raw: { text: metadata.text, exif: metadata.exif, xmp: metadata.xmp, comment: metadata.comment } } : {}),
  };
}

export function summarizeImages(records) {
  const byGenerator = {};
  const novelai = { complete: 0, incomplete: 0, byVersion: {} };
  for (const record of records) {
    const generator = record.error ? 'unreadable' : record.generation?.generator ?? 'unknown';
    byGenerator[generator] = (byGenerator[generator] ?? 0) + 1;
    if (generator !== 'novelai') continue;
    novelai[record.generation.complete ? 'complete' : 'incomplete'] += 1;
    const version = record.generation.version ?? 'unknown';
    novelai.byVersion[version] = (novelai.byVersion[version] ?? 0) + 1;
  }
  return { images: records.length, byGenerator, novelai };
}

if (process.argv[1]?.endsWith('image-metadata.mjs')) {
  const { values, positionals } = parseCommand(COMMAND);
  await runCommand(async () => {
    const targets = [...filesFrom(positionals), ...(values.manifest ? filesFromManifest(values.manifest) : [])];
    if (!targets.length) throw new Error('Pass image files, directories, or --manifest with downloaded files');
    const records = targets.map((target) => {
      try {
        return describeImage(target, { includeRaw: values['include-raw'] });
      } catch (error) {
        return { file: target.file, discord: target.discord, error: error?.message ?? String(error) };
      }
    });
    writeNdjsonAtomic(ensureOutputFile(values.output), records);
    console.log(JSON.stringify({ output: values.output, ...summarizeImages(records) }, null, 2));
  });
}
