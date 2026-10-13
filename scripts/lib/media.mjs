import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { detectFormat, readImageMetadata } from './image-metadata.mjs';
import { writeTextAtomic } from './io.mjs';

export const DEFAULT_MEDIA_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
// Signed CDN links stop working after their `ex` time; Discord answers 404 or 403.
const EXPIRED_STATUSES = new Set([403, 404, 410]);

export function extensionOf(attachment) {
  const fromName = /\.([a-z0-9]+)$/i.exec(attachment?.filename ?? '')?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const fromType = /^[a-z]+\/([a-z0-9.+-]+)/i.exec(attachment?.contentType ?? '')?.[1]?.toLowerCase();
  return fromType === 'jpeg' ? 'jpg' : fromType ?? null;
}

function withoutQuery(url) {
  return url ? String(url).split('?')[0] : null;
}

// Message records sit at different depths in each command's output: search and
// history NDJSON, enrich-hits contexts, evidence candidates, thread starters.
export function collectMessageRecords(value, found = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectMessageRecords(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (value.messageId && Array.isArray(value.attachments)) {
    const key = `${value.channelId ?? ''}/${value.messageId}`;
    if (!found.has(key) || value.attachments.length > found.get(key).attachments.length) found.set(key, value);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectMessageRecords(child, found);
  }
  return found;
}

export function selectAttachments(records, { types = DEFAULT_MEDIA_TYPES, minDimension = 0, minBytes = 0 } = {}) {
  const wanted = new Set(types.map((type) => type.toLowerCase().replace(/^\./, '')));
  const everyType = wanted.has('all');
  if (wanted.has('jpg') || wanted.has('jpeg')) ['jpg', 'jpeg'].forEach((type) => wanted.add(type));
  const items = [];
  const seen = new Set();
  for (const record of records) {
    record.attachments.forEach((attachment, index) => {
      const extension = extensionOf(attachment);
      if (!everyType && !wanted.has(extension)) return;
      if (minDimension > 0 && !((attachment.width ?? 0) >= minDimension && (attachment.height ?? 0) >= minDimension)) return;
      if (minBytes > 0 && !((attachment.size ?? 0) >= minBytes)) return;
      const key = attachment.id ?? withoutQuery(attachment.url) ?? `${record.messageId}/${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        key,
        attachmentId: attachment.id ?? null,
        index,
        filename: attachment.filename ?? null,
        extension,
        contentType: attachment.contentType ?? null,
        size: attachment.size ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        url: attachment.url ?? null,
        messageId: record.messageId,
        channelId: record.channelId ?? null,
        guildId: record.guildId ?? null,
        guildName: record.guildName ?? null,
        channelName: record.channelName ?? null,
        threadName: record.threadName ?? null,
        parentChannelName: record.parentChannelName ?? null,
        forumTitle: record.forumTitle ?? null,
        author: record.author ?? null,
        timestamp: record.timestamp ?? null,
        reactionCount: record.reactionCount ?? null,
        jumpUrl: record.jumpUrl ?? null,
        status: 'listed',
      });
    });
  }
  return items;
}

export function isExpiredUrl(url, now = Date.now()) {
  try {
    const expires = new URL(url).searchParams.get('ex');
    return Boolean(expires) && Number.parseInt(expires, 16) * 1000 <= now;
  } catch {
    return false;
  }
}

function safeName(item) {
  const base = path.basename(item.filename || `attachment-${item.index}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'attachment';
  return `${item.messageId}_${item.index}_${base}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fetchBuffer(fetchImpl, url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Download timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs);
  try {
    // CDN links are signed; the Discord token is never sent with them.
    // Only a Range header is ever added, for --with-parameters probes.
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, ...(Object.keys(headers).length ? { headers } : {}) });
    if (!response.ok) return { status: response.status };
    const buffer = Buffer.from(await response.arrayBuffer());
    // A 206 that covers the whole file is as good as a full download.
    const total = Number(/\/(\d+)\s*$/.exec(response.headers?.get?.('content-range') ?? '')?.[1]);
    return { status: response.status, buffer, complete: response.status !== 206 || total === buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_PROBE_BYTES = 65536;
const TAIL_PROBE_BYTES = 65536;
const TEXT_CHUNKS = ['tEXt', 'iTXt', 'zTXt'];
// Text chunk keywords that NovelAI (Comment), A1111 (parameters) and ComfyUI (prompt, workflow) write.
const PARAMETER_KEYS = new Set(['Comment', 'parameters', 'prompt', 'workflow']);

function generationSummary(buffer) {
  const generation = readImageMetadata(buffer).generation;
  if (!generation || generation.generator === 'unknown') return null;
  return { generator: generation.generator, version: generation.version ?? null };
}

function keyword(buffer, start) {
  const end = buffer.indexOf(0, start);
  return end > start && end - start < 80 ? buffer.toString('latin1', start, end) : null;
}

// Keywords of the PNG text chunks in the first bytes of a file. The keyword
// leads the chunk, so a chunk cut off by the probe still names itself.
export function pngTextKeys(head) {
  const keys = new Set();
  for (let offset = 8; offset + 8 <= head.length;) {
    const length = head.readUInt32BE(offset);
    const type = head.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT' || type === 'IEND') break;
    if (TEXT_CHUNKS.includes(type)) keys.add(keyword(head, offset + 8));
    offset += 12 + length;
  }
  keys.delete(null);
  return keys;
}

// Text chunks may also follow the image data; find them by their type marker.
export function pngTextKeysInTail(tail) {
  const keys = new Set();
  for (const type of TEXT_CHUNKS) {
    for (let index = tail.indexOf(type, 4, 'latin1'); index !== -1; index = tail.indexOf(type, index + 4, 'latin1')) keys.add(keyword(tail, index + 4));
  }
  keys.delete(null);
  return keys;
}

const namesParameters = (keys) => [...keys].some((key) => PARAMETER_KEYS.has(key));

async function downloadOne(item, { directory, retries, timeoutMs, refresh, fetchImpl, sleep, now, probeBytes }) {
  const localPath = path.join(directory, 'files', safeName(item));
  const result = { ...item, localPath: path.relative(directory, localPath), status: 'failed', httpStatus: null, bytes: null, sha256: null, refreshed: false, error: null };
  const existing = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
  if (existing?.size > 0 && (item.size == null || existing.size === item.size)) {
    return { ...result, status: 'existing', bytes: existing.size, sha256: item.sha256 ?? sha256(fs.readFileSync(localPath)) };
  }

  let url = item.url;
  let refreshError = null;
  const renew = async () => {
    result.refreshed = true;
    try {
      url = refresh ? await refresh(item) : null;
    } catch (error) {
      refreshError = error?.message ?? String(error);
      url = null;
    }
    return Boolean(url);
  };
  const unrenewable = () => (refreshError
    ? `could not refresh the link: ${refreshError}`
    : refresh ? 'attachment is gone from the message' : 'link expired; rerun with a Discord token so it can be refreshed');
  if (!url || isExpiredUrl(url, now())) {
    if (!(await renew())) return { ...result, error: unrenewable() };
  }

  // Returns a response with bytes, or null after recording the error.
  const request = async (headers = {}) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let response;
      try {
        response = await fetchBuffer(fetchImpl, url, timeoutMs, headers);
      } catch (error) {
        result.error = error?.name === 'TimeoutError' ? error.message : error?.cause?.code ?? error?.message ?? String(error);
        if (attempt < retries) await sleep(Math.min(15000, 1000 * 2 ** attempt));
        continue;
      }
      result.httpStatus = response.status;
      if (response.buffer?.length) {
        result.error = null;
        return response;
      }
      if (EXPIRED_STATUSES.has(response.status) && !result.refreshed) {
        if (!(await renew())) {
          result.error = `HTTP ${response.status}; ${unrenewable()}`;
          return null;
        }
        continue;
      }
      result.error = response.buffer ? 'empty response' : `HTTP ${response.status}`;
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= retries) break;
      await sleep(Math.min(15000, 1000 * 2 ** attempt));
    }
    return null;
  };
  const save = (buffer) => {
    writeTextAtomic(localPath, buffer);
    return { ...result, status: 'downloaded', bytes: buffer.length, sha256: sha256(buffer), error: null };
  };

  if (!probeBytes) {
    const response = await request();
    return response ? save(response.buffer) : result;
  }

  // Generation parameters sit in text chunks, usually before the image data;
  // read the head first and fetch the whole file only when one is named.
  const skip = { ...result, localPath: null, status: 'no-parameters', parameters: null };
  const head = await request({ Range: `bytes=0-${probeBytes - 1}` });
  if (!head) return result;
  const png = detectFormat(head.buffer) === 'png';
  let named = png ? namesParameters(pngTextKeys(head.buffer)) : head.complete || Boolean(generationSummary(head.buffer));
  if (!named && png && !head.complete) {
    const tail = await request({ Range: `bytes=-${TAIL_PROBE_BYTES}` });
    if (!tail) return result;
    named = namesParameters(pngTextKeysInTail(tail.buffer));
  }
  if (!named) return skip;
  const file = head.complete ? head : await request();
  if (!file) return result;
  // A chunk name alone is not proof; keep the file only if the parameters parse.
  const parameters = generationSummary(file.buffer);
  return parameters ? { ...save(file.buffer), parameters } : skip;
}

export async function downloadMedia({
  items,
  directory,
  concurrency = 3,
  retries = 3,
  timeoutMs = 60000,
  refresh = null,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onItem = () => {},
  probeBytes = 0,
} = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await downloadOne(items[index], { directory, retries, timeoutMs, refresh, fetchImpl, sleep, now, probeBytes });
      await onItem(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return results;
}

// A rerun keeps what earlier runs already fetched.
export function mergeWithPrevious(items, previousItems = []) {
  const previous = new Map(previousItems.map((item) => [item.key, item]));
  return items.map((item) => {
    const before = previous.get(item.key);
    return before?.sha256 ? { ...item, sha256: before.sha256 } : item;
  });
}
