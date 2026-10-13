import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { readImageMetadata } from '../scripts/lib/image-metadata.mjs';
import { collectMessageRecords, downloadMedia, selectAttachments } from '../scripts/lib/media.mjs';
import { createLinkRefresher } from '../scripts/media.mjs';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-research-media-'));
}

function attachment(id, filename, width = 1024, height = 1024, extra = {}) {
  return { id, filename, contentType: null, size: null, width, height, url: `https://cdn.discordapp.com/attachments/1/${id}/${filename}?ex=ffffffff&is=0&hm=0`, ...extra };
}

function record(messageId, attachments, extra = {}) {
  return { guildId: 'g1', channelId: 'c1', messageId, jumpUrl: `https://discord.com/channels/g1/c1/${messageId}`, author: 'artist', reactionCount: 4, attachments, ...extra };
}

test('attachments are collected from every command output shape and filtered', () => {
  const inputs = [
    { target: record('m1', [attachment('a1', 'one.png')]), before: [record('m0', [])], replyChain: [] },
    { candidates: [record('m2', [attachment('a2', 'two.webp'), attachment('a3', 'small.png', 256, 256)])] },
    { threads: [{ id: 't1', firstMessage: record('m3', [attachment('a4', 'notes.txt', null, null), attachment('a1', 'one.png')]) }] },
  ];
  const records = new Map();
  for (const input of inputs) collectMessageRecords(input, records);
  assert.deepEqual([...records.values()].map((item) => item.messageId).sort(), ['m0', 'm1', 'm2', 'm3']);

  const images = selectAttachments([...records.values()], { minDimension: 512 });
  assert.deepEqual(images.map((item) => item.filename), ['one.png', 'two.webp']);
  assert.deepEqual([images[0].jumpUrl, images[0].reactionCount, images[0].status], ['https://discord.com/channels/g1/c1/m1', 4, 'listed']);
  assert.deepEqual(selectAttachments([...records.values()], { types: ['all'] }).map((item) => item.filename).sort(), ['notes.txt', 'one.png', 'small.png', 'two.webp']);
});

function fetchResponse(status, body = null) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => (body ? Uint8Array.from(body).buffer : new ArrayBuffer(0)) };
}

test('downloads keep a hash, skip finished files, and refresh expired links', async () => {
  const directory = makeTempRoot();
  const bytes = Buffer.from('png-bytes');
  const requested = [];
  const responses = {
    'https://cdn.example/fresh.png': [fetchResponse(200, bytes)],
    'https://cdn.example/stale.png': [fetchResponse(404)],
    'https://cdn.example/renewed.png': [fetchResponse(200, bytes), fetchResponse(200, bytes)],
    'https://cdn.example/busy.png': [fetchResponse(503), fetchResponse(200, bytes)],
  };
  const fetchImpl = async (url, options) => {
    requested.push(url);
    assert.equal(options.headers, undefined, 'the Discord token is never sent to the CDN');
    return responses[url].shift();
  };
  const items = [
    { key: 'a1', messageId: 'm1', channelId: 'c1', index: 0, filename: 'fresh.png', url: 'https://cdn.example/fresh.png' },
    { key: 'a2', messageId: 'm2', channelId: 'c1', index: 0, filename: 'stale.png', url: 'https://cdn.example/stale.png' },
    { key: 'a3', messageId: 'm3', channelId: 'c1', index: 0, filename: 'old.png', url: 'https://cdn.discordapp.com/x/old.png?ex=00000001&is=0&hm=0' },
    { key: 'a4', messageId: 'm4', channelId: 'c1', index: 0, filename: 'busy.png', url: 'https://cdn.example/busy.png' },
  ];
  const refreshed = [];
  const refresh = async (item) => {
    refreshed.push(item.key);
    return 'https://cdn.example/renewed.png';
  };
  const results = await downloadMedia({ items, directory, refresh, fetchImpl, concurrency: 1, sleep: async () => {}, now: () => Date.UTC(2026, 9, 1) });

  assert.deepEqual(results.map((item) => item.status), ['downloaded', 'downloaded', 'downloaded', 'downloaded']);
  assert.deepEqual(refreshed, ['a2', 'a3']);
  assert.deepEqual(results.map((item) => item.refreshed), [false, true, true, false]);
  assert.ok(!requested.some((url) => url.includes('old.png')), 'an expired link is refreshed before it is requested');
  assert.equal(results[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.readFileSync(path.join(directory, results[0].localPath), 'utf8'), 'png-bytes');

  const again = await downloadMedia({ items: items.slice(0, 1), directory, fetchImpl: async () => assert.fail('a finished file is not fetched again'), sleep: async () => {} });
  assert.equal(again[0].status, 'existing');

  const withoutToken = await downloadMedia({ items: [{ ...items[2], key: 'a5', messageId: 'm5' }], directory, fetchImpl, sleep: async () => {}, now: () => Date.UTC(2026, 9, 1) });
  assert.deepEqual([withoutToken[0].status, withoutToken[0].error], ['failed', 'link expired; rerun with a Discord token so it can be refreshed']);
});

test('the link refresher re-reads the message once and matches by attachment id', async () => {
  let reads = 0;
  const refresh = createLinkRefresher({
    async fetchAround(channelId, messageId) {
      reads += 1;
      return [{ id: messageId, attachments: [{ id: 'a1', filename: 'one.png', url: 'https://cdn/new-one' }, { id: 'a2', filename: 'two.png', url: 'https://cdn/new-two' }] }];
    },
  });
  assert.equal(await refresh({ channelId: 'c1', messageId: 'm1', attachmentId: 'a2', filename: 'renamed.png' }), 'https://cdn/new-two');
  assert.equal(await refresh({ channelId: 'c1', messageId: 'm1', attachmentId: null, filename: 'one.png' }), 'https://cdn/new-one');
  assert.equal(await refresh({ channelId: 'c1', messageId: 'm1', attachmentId: 'gone', filename: 'gone.png' }), null);
  assert.equal(reads, 1);
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function png(text = {}, { width = 832, height = 1216, chunks = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const textChunks = Object.entries(text).map(([key, value]) => chunk('tEXt', Buffer.from(`${key}\0${value}`, 'utf8')));
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), ...textChunks, ...chunks, chunk('IEND', Buffer.alloc(0))]);
}

const NOVELAI_COMMENT = {
  prompt: '1girl, 机甲, masterpiece',
  steps: 28,
  height: 1216,
  width: 832,
  scale: 5,
  cfg_rescale: 0,
  seed: 1234567,
  sampler: 'k_euler_ancestral',
  noise_schedule: 'karras',
  uc: 'lowres, bad anatomy',
  request_type: 'PromptGenerateRequest',
};

test('NovelAI PNG metadata is complete only when every reproduction field is present', () => {
  const complete = readImageMetadata(png({
    Software: 'NovelAI',
    Source: 'NovelAI Diffusion V4.5 4BDE2A90',
    Comment: JSON.stringify(NOVELAI_COMMENT),
  }));
  assert.deepEqual([complete.format, complete.width, complete.height], ['png', 832, 1216]);
  assert.equal(complete.generation.generator, 'novelai');
  assert.deepEqual([complete.generation.version, complete.generation.params.modelHash, complete.generation.complete], ['V4.5', '4BDE2A90', true]);
  assert.equal(complete.generation.params.prompt, '1girl, 机甲, masterpiece');

  const { seed, ...withoutSeed } = NOVELAI_COMMENT;
  const incomplete = readImageMetadata(png({ Software: 'NovelAI', Source: 'NovelAI Diffusion V5 0A1B2C3D', Comment: JSON.stringify(withoutSeed) })).generation;
  assert.deepEqual([incomplete.version, incomplete.complete, incomplete.missing], ['V5', false, ['seed']]);
  assert.equal(readImageMetadata(png({ Software: 'NovelAI', Source: 'Stable Diffusion XL C1E1DE52', Comment: '{"uc":""}' })).generation.version, 'V3');
});

test('ComfyUI graphs in compressed text chunks yield models, LoRAs, samplers, and prompts', () => {
  const prompt = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'noobaiXL.safetensors' } },
    5: { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 0.8, strength_clip: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality' } },
    3: { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 5.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, positive: ['6', 0], negative: ['7', 0] } },
  };
  const compressed = Buffer.concat([Buffer.from('prompt\0', 'latin1'), Buffer.from([1, 0]), Buffer.from('\0\0'), deflateSync(Buffer.from(JSON.stringify(prompt).replace('"denoise":1', '"denoise":NaN')))]);
  const generation = readImageMetadata(png({}, { chunks: [chunk('iTXt', compressed)] })).generation;

  assert.equal(generation.generator, 'comfyui');
  assert.deepEqual(generation.checkpoints, ['noobaiXL.safetensors']);
  assert.deepEqual(generation.loras, [{ name: 'style.safetensors', strengthModel: 0.8, strengthClip: 1 }]);
  assert.deepEqual(
    [generation.samplers[0].seed, generation.samplers[0].positive, generation.samplers[0].negative],
    [42, 'masterpiece, 1girl', 'worst quality'],
  );
});

function tiff({ ifd0 = [], exif = [] }) {
  const entries0 = ifd0.length + (exif.length ? 1 : 0);
  const exifOffset = 8 + 2 + entries0 * 12 + 4;
  let dataOffset = exifOffset + (exif.length ? 2 + exif.length * 12 + 4 : 0);
  const data = [];
  const entry = ({ tag, type, value }) => {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt16BE(tag, 0);
    buffer.writeUInt16BE(type, 2);
    buffer.writeUInt32BE(value.length, 4);
    if (value.length <= 4) value.copy(buffer, 8);
    else {
      buffer.writeUInt32BE(dataOffset, 8);
      data.push(value);
      dataOffset += value.length;
    }
    return buffer;
  };
  const ifd = (entries, extra = []) => {
    const count = Buffer.alloc(2);
    count.writeUInt16BE(entries.length + extra.length);
    return Buffer.concat([count, ...entries.map(entry), ...extra, Buffer.alloc(4)]);
  };
  const pointer = Buffer.alloc(12);
  pointer.writeUInt16BE(0x8769, 0);
  pointer.writeUInt16BE(4, 2);
  pointer.writeUInt32BE(1, 4);
  pointer.writeUInt32BE(exifOffset, 8);
  const first = ifd(ifd0, exif.length ? [pointer] : []);
  const second = exif.length ? ifd(exif) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from('MM\0*\0\0\0\x08', 'latin1'), first, second, ...data]);
}

test('A1111 parameters in a JPEG UserComment are decoded from UTF-16', () => {
  const parameters = 'masterpiece, 1girl\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 99, Size: 832x1216, Model hash: abcd1234, Model: animagine, Lora hashes: "a: 1, b: 2"';
  const userComment = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from(parameters, 'utf16le').swap16()]);
  const exif = tiff({ exif: [{ tag: 0x9286, type: 7, value: userComment }] });
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif]);
  const length = (body) => Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]);
  const sof = Buffer.from([8, 0x04, 0xc0, 0x03, 0x40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length(app1), app1,
    Buffer.from([0xff, 0xc0]), length(sof), sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
  ]);
  const metadata = readImageMetadata(jpeg);

  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', 832, 1216]);
  assert.equal(metadata.generation.generator, 'a1111');
  assert.deepEqual(metadata.generation.params, {
    prompt: 'masterpiece, 1girl',
    negativePrompt: 'lowres',
    steps: 28,
    sampler: 'Euler a',
    scheduleType: null,
    cfgScale: 7,
    seed: 99,
    width: 832,
    height: 1216,
    model: 'animagine',
    modelHash: 'abcd1234',
  });
  assert.equal(metadata.generation.settings['Lora hashes'], 'a: 1, b: 2');
});

test('a ComfyUI WebP keeps its workflow in EXIF and reports canvas size', () => {
  const workflow = JSON.stringify({ nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['ponyXL.safetensors'] }, { id: 2, type: 'LoraLoader', widgets_values: ['detail.safetensors', 0.6, 0.6] }] });
  const exif = tiff({ ifd0: [{ tag: 0x010f, type: 2, value: Buffer.from(`workflow:${workflow}\0`, 'utf8') }] });
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(1023, 4, 3);
  vp8x.writeUIntLE(1535, 7, 3);
  const riffChunk = (type, body) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    return Buffer.concat([Buffer.from(type, 'latin1'), size, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), riffChunk('VP8X', vp8x), riffChunk('EXIF', exif)]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length);
  const metadata = readImageMetadata(Buffer.concat([Buffer.from('RIFF', 'latin1'), riffSize, body]));

  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['webp', 1024, 1536]);
  assert.deepEqual([metadata.generation.generator, metadata.generation.source], ['comfyui', 'workflow']);
  assert.deepEqual(metadata.generation.checkpoints, ['ponyXL.safetensors']);
  assert.deepEqual(metadata.generation.loras, [{ name: 'detail.safetensors', strengthModel: 0.6, strengthClip: 0.6 }]);
});

test('an image without generation text is unknown rather than evidence of another tool', () => {
  const metadata = readImageMetadata(png({ Title: 'scan' }));
  assert.deepEqual([metadata.generation.generator, Object.keys(metadata.text)], ['unknown', ['Title']]);
  assert.equal(readImageMetadata(Buffer.from('not an image')).format, null);
});

test('--with-parameters reads file headers and downloads only images that embed parameters', async () => {
  const directory = makeTempRoot();
  const novelai = { Software: 'NovelAI', Source: 'NovelAI Diffusion V5 12345678', Comment: JSON.stringify(NOVELAI_COMMENT) };
  const pixels = chunk('IDAT', Buffer.alloc(2000, 7));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(832, 0);
  header.writeUInt32BE(1216, 4);
  const textAfterPixels = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), pixels,
    chunk('tEXt', Buffer.from(`Software\0NovelAI`)), chunk('tEXt', Buffer.from(`Comment\0${JSON.stringify(NOVELAI_COMMENT)}`)), chunk('IEND', Buffer.alloc(0))]);
  const files = {
    'https://cdn.example/head.png': png(novelai, { chunks: [pixels] }),
    'https://cdn.example/tail.png': textAfterPixels,
    'https://cdn.example/plain.png': png({}, { chunks: [pixels] }),
    'https://cdn.example/small.png': png(novelai),
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const range = options.headers?.Range ?? null;
    requests.push(`${url.split('/').pop()} ${range ?? 'full'}`);
    assert.deepEqual(Object.keys(options.headers ?? {}).filter((name) => name !== 'Range'), [], 'only a Range header is sent');
    const body = files[url];
    if (!range) return { ...fetchResponse(200, body), headers: new Headers() };
    const [, start, end, suffix] = /bytes=(?:(\d+)-(\d+)|-(\d+))/.exec(range);
    const from = suffix ? Math.max(0, body.length - Number(suffix)) : Number(start);
    const slice = body.subarray(from, suffix ? body.length : Math.min(body.length, Number(end) + 1));
    return { ...fetchResponse(206, slice), headers: new Headers({ 'content-range': `bytes ${from}-${from + slice.length - 1}/${body.length}` }) };
  };
  const items = Object.keys(files).map((url, index) => ({ key: `p${index}`, messageId: `p${index}`, channelId: 'c1', index: 0, filename: url.split('/').pop(), url }));
  const results = await downloadMedia({ items, directory, fetchImpl, concurrency: 1, sleep: async () => {}, probeBytes: 1024 });

  assert.deepEqual(results.map((item) => item.status), ['downloaded', 'downloaded', 'no-parameters', 'downloaded']);
  assert.deepEqual(results.map((item) => item.parameters?.version ?? item.parameters?.generator ?? null), ['V5', 'novelai', null, 'V5']);
  assert.equal(results[2].localPath, null);
  assert.deepEqual(requests, [
    'head.png bytes=0-1023', 'head.png full',
    'tail.png bytes=0-1023', 'tail.png bytes=-65536', 'tail.png full',
    'plain.png bytes=0-1023', 'plain.png bytes=-65536',
    'small.png bytes=0-1023',
  ]);
  assert.ok(fs.readFileSync(path.join(directory, results[3].localPath)).equals(files['https://cdn.example/small.png']), 'a file smaller than the probe is saved from it');
});

test('NovelAI V4+ character prompts keep their positions and negative prompts', () => {
  const comment = {
    ...NOVELAI_COMMENT,
    request_type: 'PromptGenerateRequest',
    v4_prompt: {
      caption: { base_caption: '3 panel comic, top panel: 2girls talking', char_captions: [{ char_caption: 'girl, red hair, speech bubble says "Hi!"', centers: [{ x: 0.3, y: 0.1 }] }, { char_caption: 'girl, blue hair', centers: [{ x: 0.7, y: 0.5 }] }] },
      use_coords: true,
      use_order: true,
    },
    v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: [{ char_caption: 'hat', centers: [{ x: 0.3, y: 0.1 }] }, { char_caption: '', centers: [] }] } },
  };
  const { generation } = readImageMetadata(png({ Software: 'NovelAI', Source: 'NovelAI Diffusion V5 12345678', Comment: JSON.stringify(comment) }));
  assert.equal(generation.version, 'V5');
  assert.equal(generation.useCoords, true);
  assert.deepEqual(generation.characters, [
    { prompt: 'girl, red hair, speech bubble says "Hi!"', negativePrompt: 'hat', centers: [{ x: 0.3, y: 0.1 }] },
    { prompt: 'girl, blue hair', negativePrompt: '', centers: [{ x: 0.7, y: 0.5 }] },
  ]);
  const legacy = readImageMetadata(png({ Software: 'NovelAI', Comment: JSON.stringify(NOVELAI_COMMENT) })).generation;
  assert.equal(legacy.characters, undefined);
});

test('--with-parameters follows a parameter chunk cut off by the probe and drops files whose chunk does not parse', async () => {
  const directory = makeTempRoot();
  const comment = JSON.stringify({ ...NOVELAI_COMMENT, padding: 'x'.repeat(3000) });
  const files = {
    'https://cdn.example/cut.png': png({ Software: 'NovelAI', Comment: comment }, { chunks: [chunk('IDAT', Buffer.alloc(500))] }),
    'https://cdn.example/note.png': png({ Comment: 'scanned at the library' }, { chunks: [chunk('IDAT', Buffer.alloc(3000))] }),
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const range = options.headers?.Range ?? null;
    requests.push(`${url.split('/').pop()} ${range ?? 'full'}`);
    const body = files[url];
    if (!range) return { ...fetchResponse(200, body), headers: new Headers() };
    const [, start, end, suffix] = /bytes=(?:(\d+)-(\d+)|-(\d+))/.exec(range);
    const from = suffix ? Math.max(0, body.length - Number(suffix)) : Number(start);
    const slice = body.subarray(from, suffix ? body.length : Math.min(body.length, Number(end) + 1));
    return { ...fetchResponse(206, slice), headers: new Headers({ 'content-range': `bytes ${from}-${from + slice.length - 1}/${body.length}` }) };
  };
  const items = Object.keys(files).map((url, index) => ({ key: `q${index}`, messageId: `q${index}`, channelId: 'c1', index: 0, filename: url.split('/').pop(), url }));
  const results = await downloadMedia({ items, directory, fetchImpl, concurrency: 1, sleep: async () => {}, probeBytes: 256 });

  assert.deepEqual(results.map((item) => item.status), ['downloaded', 'no-parameters']);
  assert.equal(results[0].parameters.generator, 'novelai');
  assert.deepEqual(requests, ['cut.png bytes=0-255', 'cut.png full', 'note.png bytes=0-255', 'note.png full']);
  assert.ok(!fs.existsSync(path.join(directory, 'files', 'q1_0_note.png')), 'a file without parameters is not kept');
});
