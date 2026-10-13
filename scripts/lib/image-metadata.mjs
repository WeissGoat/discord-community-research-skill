import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXIF_TAGS = {
  0x010e: 'imageDescription',
  0x010f: 'make',
  0x0110: 'model',
  0x0131: 'software',
  0x9286: 'userComment',
  0x9c9c: 'xpComment',
};
// Fields NovelAI needs to reproduce an image (see references/media-collection.md).
export const NOVELAI_REQUIRED_FIELDS = ['modelName', 'modelHash', 'prompt', 'negativePrompt', 'steps', 'width', 'height', 'scale', 'cfgRescale', 'seed', 'sampler', 'noiseSchedule'];

// tEXt is Latin-1 by the PNG spec, but generators write UTF-8 into it.
function decodeText(buffer) {
  const utf8 = buffer.toString('utf8');
  return utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
}

function trimNulls(value) {
  return value.replace(/\0+$/, '');
}

function utf16(buffer, littleEndian) {
  const even = buffer.subarray(0, buffer.length - (buffer.length % 2));
  if (littleEndian) return even.toString('utf16le');
  return Buffer.from(even).swap16().toString('utf16le');
}

function asciiShare(text) {
  if (!text.length) return 0;
  return [...text].filter((char) => /[\x20-\x7e\r\n\t]/.test(char)).length / text.length;
}

// EXIF UserComment starts with an 8-byte charset; A1111 writes UTF-16 under
// "UNICODE" in either byte order, so the more readable decoding wins.
function decodeUserComment(raw) {
  const charset = raw.toString('latin1', 0, 8);
  const body = raw.subarray(8);
  if (charset.startsWith('UNICODE')) {
    const bigEndian = trimNulls(utf16(body, false));
    const littleEndian = trimNulls(utf16(body, true));
    return asciiShare(littleEndian) > asciiShare(bigEndian) ? littleEndian : bigEndian;
  }
  if (charset.startsWith('ASCII') || charset === '\0'.repeat(8)) return trimNulls(decodeText(body));
  return trimNulls(decodeText(raw));
}

export function readExif(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (offset) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const fields = {};
  const visited = new Set();
  const readIfd = (ifdOffset) => {
    if (!ifdOffset || visited.has(ifdOffset) || ifdOffset + 2 > tiff.length) return;
    visited.add(ifdOffset);
    const count = u16(ifdOffset);
    for (let index = 0; index < count; index += 1) {
      const entry = ifdOffset + 2 + index * 12;
      if (entry + 12 > tiff.length) break;
      const tag = u16(entry);
      if (tag === 0x8769) {
        readIfd(u32(entry + 8));
        continue;
      }
      const name = EXIF_TAGS[tag];
      // BYTE, ASCII, and UNDEFINED are the only types these tags use.
      if (!name || ![1, 2, 7].includes(u16(entry + 2))) continue;
      const size = u32(entry + 4);
      const start = size <= 4 ? entry + 8 : u32(entry + 8);
      if (start + size > tiff.length) continue;
      const raw = tiff.subarray(start, start + size);
      if (tag === 0x9286) fields[name] = decodeUserComment(raw);
      else if (tag === 0x9c9c) fields[name] = trimNulls(raw.toString('utf16le'));
      else fields[name] = trimNulls(decodeText(raw));
    }
  };
  readIfd(u32(4));
  return fields;
}

function readPngText(type, data) {
  const keyEnd = data.indexOf(0);
  if (keyEnd < 0) return null;
  const key = data.toString('latin1', 0, keyEnd);
  try {
    if (type === 'tEXt') return { key, value: decodeText(data.subarray(keyEnd + 1)) };
    if (type === 'zTXt') return { key, value: inflateSync(data.subarray(keyEnd + 2)).toString('utf8') };
    // iTXt: keyword, compression flag and method, language tag, translated keyword, text.
    const compressed = data[keyEnd + 1] === 1;
    const languageEnd = data.indexOf(0, keyEnd + 3);
    const translatedEnd = data.indexOf(0, languageEnd + 1);
    const payload = data.subarray(translatedEnd + 1);
    return { key, value: (compressed ? inflateSync(payload) : payload).toString('utf8') };
  } catch {
    return { key, value: null };
  }
}

function readPng(buffer) {
  const result = { width: null, height: null, text: {}, exif: null };
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    const data = buffer.subarray(start, end);
    if (type === 'IHDR' && length >= 8) {
      result.width = data.readUInt32BE(0);
      result.height = data.readUInt32BE(4);
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const entry = readPngText(type, data);
      if (entry && !(entry.key in result.text)) result.text[entry.key] = entry.value;
    } else if (type === 'eXIf') {
      result.exif = readExif(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  return result;
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

function readJpeg(buffer) {
  const result = { width: null, height: null, exif: null, xmp: null, comment: null };
  const comments = [];
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Metadata segments precede the compressed scan.
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    const data = buffer.subarray(offset + 4, Math.min(buffer.length, offset + 2 + length));
    if (marker === 0xe1 && data.toString('latin1', 0, 6) === 'Exif\0\0') result.exif = readExif(data.subarray(6));
    else if (marker === 0xe1 && data.toString('latin1', 0, XMP_HEADER.length) === XMP_HEADER) result.xmp = data.toString('utf8', XMP_HEADER.length);
    else if (marker === 0xfe) comments.push(decodeText(data));
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && data.length >= 5) {
      result.height = data.readUInt16BE(1);
      result.width = data.readUInt16BE(3);
    }
    offset += 2 + length;
  }
  result.comment = comments.join('\n') || null;
  return result;
}

function readWebp(buffer) {
  const result = { width: null, height: null, exif: null, xmp: null };
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    if (type === 'VP8X' && data.length >= 10) {
      result.width = 1 + data.readUIntLE(4, 3);
      result.height = 1 + data.readUIntLE(7, 3);
    } else if (type === 'VP8 ' && data.length >= 10 && result.width == null) {
      result.width = data.readUInt16LE(6) & 0x3fff;
      result.height = data.readUInt16LE(8) & 0x3fff;
    } else if (type === 'VP8L' && data.length >= 5 && result.width == null) {
      const bits = data.readUInt32LE(1);
      result.width = (bits & 0x3fff) + 1;
      result.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === 'EXIF') {
      result.exif = readExif(data.toString('latin1', 0, 6) === 'Exif\0\0' ? data.subarray(6) : data);
    } else if (type === 'XMP ') {
      result.xmp = data.toString('utf8');
    }
    offset += 8 + size + (size % 2);
  }
  return result;
}

export function detectFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'gif';
  return null;
}

// ComfyUI writes NaN and Infinity, which JSON.parse rejects.
function parseJson(value) {
  if (typeof value !== 'string' || !/^\s*[{[]/.test(value)) return null;
  try {
    return JSON.parse(value.replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null'));
  } catch {
    return null;
  }
}

// ComfyUI's WebP and JPEG savers prefix EXIF strings with "prompt:" or "workflow:".
function prefixedExif(exif, key) {
  for (const value of Object.values(exif ?? {})) {
    if (typeof value === 'string' && value.startsWith(`${key}:`)) return value.slice(key.length + 1);
  }
  return null;
}

function novelAiVersion(model) {
  const version = /\bV(\d+(?:\.\d+)?)\b/i.exec(model ?? '');
  if (version) return `V${version[1]}`;
  // NovelAI's anime V3 model reports itself as Stable Diffusion XL.
  return /stable diffusion xl/i.test(model ?? '') ? 'V3' : null;
}

function novelAi({ text, comment, software }) {
  const source = (text.Source ?? '').trim();
  const sourceMatch = /^(.*?)\s+([0-9a-f]{8})$/i.exec(source);
  const modelName = sourceMatch?.[1] ?? (source || null);
  const params = {
    modelName,
    modelHash: sourceMatch?.[2]?.toUpperCase() ?? null,
    prompt: comment.prompt ?? comment.v4_prompt?.caption?.base_caption ?? text.Description ?? null,
    negativePrompt: comment.uc ?? comment.v4_negative_prompt?.caption?.base_caption ?? null,
    steps: comment.steps ?? null,
    width: comment.width ?? null,
    height: comment.height ?? null,
    scale: comment.scale ?? null,
    cfgRescale: comment.cfg_rescale ?? null,
    seed: comment.seed ?? null,
    sampler: comment.sampler ?? null,
    noiseSchedule: comment.noise_schedule ?? null,
  };
  // An empty negative prompt is a real setting; a missing one is unknown.
  const missing = NOVELAI_REQUIRED_FIELDS.filter((field) => params[field] == null || (field !== 'negativePrompt' && params[field] === ''));
  // V4 and later: per-character prompts, with positions when AI's Choice is off.
  const negatives = comment.v4_negative_prompt?.caption?.char_captions ?? [];
  const characters = (comment.v4_prompt?.caption?.char_captions ?? []).map((character, index) => ({
    prompt: character.char_caption ?? null,
    negativePrompt: negatives[index]?.char_caption ?? null,
    centers: (character.centers ?? []).map(({ x, y }) => ({ x, y })),
  }));
  const layout = comment.v4_prompt ? { characters, useCoords: comment.v4_prompt.use_coords ?? null, useOrder: comment.v4_prompt.use_order ?? null } : null;
  return {
    generator: 'novelai',
    version: novelAiVersion(modelName),
    software,
    params,
    ...layout,
    requestType: comment.request_type ?? null,
    // V5 UI toggles, kept raw: their value meanings are not documented.
    toggles: Object.fromEntries(['quality_boost', 'tag_hint_qt', 'tag_hint_uc_preset'].filter((key) => key in comment).map((key) => [key, comment[key]])),
    complete: missing.length === 0,
    missing,
  };
}

function comfyUi(prompt, workflow) {
  const nodes = prompt && typeof prompt === 'object' && !Array.isArray(prompt)
    ? Object.entries(prompt).filter(([, node]) => node?.class_type).map(([id, node]) => ({ id, type: node.class_type, inputs: node.inputs ?? {} }))
    : (Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((node) => ({ id: String(node.id), type: node.type ?? '', inputs: {}, widgets: node.widgets_values ?? [] }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const value = (node, key, widgetIndex) => node.inputs[key] ?? (Array.isArray(node.widgets) ? node.widgets[widgetIndex] : undefined);
  const textOf = (link) => {
    const text = Array.isArray(link) ? byId.get(String(link[0]))?.inputs?.text : null;
    return typeof text === 'string' ? text : null;
  };
  const typeCounts = new Map();
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  return {
    generator: 'comfyui',
    source: prompt ? 'prompt' : 'workflow',
    nodeCount: nodes.length,
    nodeTypes: Object.fromEntries([...typeCounts].sort((left, right) => right[1] - left[1]).slice(0, 25)),
    checkpoints: [...new Set(nodes
      .filter((node) => /checkpointloader|unetloader|unet ?loader|diffusionmodelloader/i.test(node.type))
      .map((node) => value(node, 'ckpt_name', 0) ?? value(node, 'unet_name', 0))
      .filter((name) => typeof name === 'string'))],
    loras: nodes
      .filter((node) => /lora/i.test(node.type))
      .map((node) => ({ name: value(node, 'lora_name', 0), strengthModel: value(node, 'strength_model', 1) ?? null, strengthClip: value(node, 'strength_clip', 2) ?? null }))
      .filter((lora) => typeof lora.name === 'string'),
    samplers: nodes
      .filter((node) => /ksampler/i.test(node.type) && Object.keys(node.inputs).length)
      .map((node) => ({
        type: node.type,
        seed: node.inputs.seed ?? node.inputs.noise_seed ?? null,
        steps: node.inputs.steps ?? null,
        cfg: node.inputs.cfg ?? null,
        sampler: node.inputs.sampler_name ?? null,
        scheduler: node.inputs.scheduler ?? null,
        denoise: node.inputs.denoise ?? null,
        positive: textOf(node.inputs.positive),
        negative: textOf(node.inputs.negative),
      })),
  };
}

const A1111_SETTINGS = /\s*([\w ./()-]+?):\s*("(?:\\.|[^"\\])*"|[^,]*)(?:,|$)/g;

function a1111(parameters) {
  const lines = parameters.split(/\r?\n/);
  let settingsLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*Steps:\s*\d+/.test(lines[index])) {
      settingsLine = index;
      break;
    }
  }
  const head = settingsLine >= 0 ? lines.slice(0, settingsLine) : lines;
  const negativeLine = head.findIndex((line) => line.startsWith('Negative prompt:'));
  const settings = {};
  if (settingsLine >= 0) {
    for (const [, key, raw] of lines.slice(settingsLine).join(', ').matchAll(A1111_SETTINGS)) {
      if (key.trim()) settings[key.trim()] = raw.trim().replace(/^"|"$/g, '');
    }
  }
  const number = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
  const size = /^(\d+)x(\d+)$/.exec(settings.Size ?? '');
  return {
    generator: 'a1111',
    params: {
      prompt: (negativeLine >= 0 ? head.slice(0, negativeLine) : head).join('\n').trim(),
      negativePrompt: negativeLine >= 0 ? [head[negativeLine].slice('Negative prompt:'.length), ...head.slice(negativeLine + 1)].join('\n').trim() : null,
      steps: number(settings.Steps),
      sampler: settings.Sampler ?? null,
      scheduleType: settings['Schedule type'] ?? null,
      cfgScale: number(settings['CFG scale']),
      seed: number(settings.Seed),
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      model: settings.Model ?? null,
      modelHash: settings['Model hash'] ?? null,
    },
    settings,
  };
}

export function classifyGeneration({ text = {}, exif = null } = {}) {
  const comment = parseJson(text.Comment ?? exif?.userComment ?? null);
  const software = text.Software ?? exif?.software ?? null;
  if (/novelai/i.test(software ?? '') || (comment && ('uc' in comment || 'noise_schedule' in comment || 'request_type' in comment))) {
    return novelAi({ text, comment: comment ?? {}, software });
  }
  const prompt = parseJson(text.prompt ?? prefixedExif(exif, 'prompt'));
  const workflow = parseJson(text.workflow ?? prefixedExif(exif, 'workflow'));
  if (prompt || workflow) return comfyUi(prompt, workflow);
  const parameters = text.parameters ?? (/\bSteps:\s*\d+/.test(exif?.userComment ?? '') ? exif.userComment : null);
  if (parameters) return a1111(parameters);
  return { generator: 'unknown' };
}

// Reads embedded text metadata only. Data hidden in pixels (NovelAI's
// alpha-channel stealth info) is not decoded, so its absence is not evidence.
export function readImageMetadata(buffer) {
  const format = detectFormat(buffer);
  const parsed = format === 'png' ? readPng(buffer)
    : format === 'jpeg' ? readJpeg(buffer)
      : format === 'webp' ? readWebp(buffer)
        : {};
  const metadata = {
    format,
    width: parsed.width ?? null,
    height: parsed.height ?? null,
    text: parsed.text ?? {},
    exif: parsed.exif ?? null,
    xmp: parsed.xmp ?? null,
    comment: parsed.comment ?? null,
  };
  return { ...metadata, generation: classifyGeneration(metadata) };
}
