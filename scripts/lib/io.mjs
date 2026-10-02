import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCKED_FILE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800, 1200];

// Everything is resolved from the caller's working directory, never from where
// the skill is installed, so the skill directory can be moved or shared.
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_OUTPUT_ROOT = path.join('discord_research', 'runs');
export const TOKEN_VARIABLES = ['DISCORD_TOKEN', 'VITE_DISCORD_TOKEN'];
const RUN_GITIGNORE = '# Created by discord-community-research: this holds private Discord content.\n*\n';

function replaceSecret(value, secret) {
  if (!secret || value == null) return value;
  return String(value).split(secret).join('[REDACTED]');
}

export function redactSecrets(value, secrets = []) {
  const values = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean).map(String);
  if (typeof value === 'string') return values.reduce((result, secret) => replaceSecret(result, secret), value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, values)]));
  }
  return value;
}

export function sanitizeError(error, ...secrets) {
  const safe = redactSecrets({
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    status: error?.status ?? null,
    retryable: error?.retryable ?? false,
    network: error?.network ?? false,
    attempts: error?.attempts ?? null,
    body: error?.body ?? null,
  }, secrets.flat());
  return safe;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Accepts text or a Buffer. Windows refuses to replace a file that antivirus,
// the search indexer, or a reader briefly holds open. Retry the rename, then fall back to an in-place
// write so a transient lock cannot crash a long research run.
export function writeTextAtomic(filePath, text, { retryDelaysMs = RENAME_RETRY_DELAYS_MS } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        return;
      } catch (error) {
        if (!LOCKED_FILE_CODES.has(error?.code)) throw error;
        if (attempt >= retryDelaysMs.length) break;
        sleepSync(retryDelaysMs[attempt]);
      }
    }
    fs.writeFileSync(filePath, text, 'utf8');
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // A scanner may still hold the temp file; a stray .tmp is harmless.
    }
  }
}

export function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendNdjson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readNdjson(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) return fallback;
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function writeNdjsonAtomic(filePath, values = []) {
  const content = values.length ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
  writeTextAtomic(filePath, content);
}

export function loadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Commands chain each other's output, which is either one JSON document or NDJSON.
export function loadJsonOrNdjson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  }
}

// Resolve symlinks, junctions, and Windows short names through the nearest
// existing ancestor, so a skill linked into several platforms' skill folders
// is still recognized from any of its paths.
function physicalPath(target) {
  const missing = [];
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return target;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

function isInside(child, parent) {
  const relative = path.relative(physicalPath(parent), physicalPath(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function refuseSkillDirectory(target) {
  // An installed skill may be read-only or shared by several projects.
  if (isInside(target, SKILL_DIR)) {
    throw new Error(`Refusing to write output inside the skill directory (${target}); run the command from the user's workspace or pass an output path outside it`);
  }
}

// Collected Discord content must not be committed by accident: a directory a
// command creates gets a self-ignoring .gitignore; an existing one is left alone.
export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  refuseSkillDirectory(resolved);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(path.join(resolved, '.gitignore'), RUN_GITIGNORE, 'utf8');
  }
  return resolved;
}

export function ensureOutputFile(filePath) {
  ensurePrivateDirectory(path.dirname(path.resolve(filePath)));
  return filePath;
}

export function resolveOutputRoot(outputRoot, { env = process.env, cwd = process.cwd() } = {}) {
  return path.resolve(cwd, outputRoot || env.DISCORD_RESEARCH_OUTPUT || DEFAULT_OUTPUT_ROOT);
}

export function createRunDirectory({
  outputRoot,
  runId = new Date().toISOString().replace(/[:.]/g, '-'),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const requestedRoot = resolveOutputRoot(outputRoot, { env, cwd });
  // `--output-root <root>/<runId>` names the run directory itself; nesting
  // another <runId> inside it is kept only for runs already created that way.
  const nested = path.join(requestedRoot, runId);
  const directory = path.basename(requestedRoot) === runId && !fs.existsSync(nested) ? requestedRoot : nested;
  const root = path.dirname(directory);
  refuseSkillDirectory(directory);
  fs.mkdirSync(directory, { recursive: true });
  // Runs land in whatever project the agent works in; keep them out of its git history.
  const ignorePath = path.join(directory, '.gitignore');
  if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, RUN_GITIGNORE, 'utf8');
  return { root, ...runFiles(directory) };
}

// The files a run directory holds, for commands that rebuild one phase.
export function runFiles(directory) {
  return {
    directory,
    run: path.join(directory, 'run.json'),
    guilds: path.join(directory, 'guilds.json'),
    searchPlan: path.join(directory, 'search-plan.json'),
    messages: path.join(directory, 'messages.ndjson'),
    contexts: path.join(directory, 'contexts.ndjson'),
    evidence: path.join(directory, 'evidence.json'),
    state: path.join(directory, 'state.json'),
    report: path.join(directory, 'report.md'),
    lock: path.join(directory, 'run.lock'),
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

// Two processes appending to the same run directory interleave messages and
// overwrite each other's state, so a run directory has a single writer.
export function acquireRunLock(directory, {
  pid = process.pid,
  isAlive = processAlive,
  now = () => new Date().toISOString(),
} = {}) {
  const lockPath = path.join(directory, 'run.lock');
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: now() }), { encoding: 'utf8', flag: 'wx' });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener('exit', release);
        try {
          if (readLock(lockPath)?.pid === pid) fs.rmSync(lockPath, { force: true });
        } catch {
          // The next run treats a dead owner's lock as stale.
        }
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readLock(lockPath);
      if (owner?.pid && owner.pid !== pid && isAlive(owner.pid)) {
        throw new Error(`Run directory ${directory} is in use by process ${owner.pid} (started ${owner.startedAt ?? 'unknown'}); wait for it to finish or use a new runId`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Could not acquire the run lock for ${directory}`);
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvFile(filePath, names) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const name of names) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=\\s*(.*?)\\s*$`, 'm');
    const value = parseEnvValue(content.match(pattern)?.[1] ?? '');
    if (value) return { name, value };
  }
  return null;
}

// An explicit env file wins; otherwise the process environment, then the file
// named by DISCORD_RESEARCH_ENV_FILE or .env in the working directory. The
// source is returned so callers can report it without printing the token.
export function resolveToken({
  env = process.env,
  cwd = process.cwd(),
  variable,
  envFile,
} = {}) {
  const names = variable ? [variable] : TOKEN_VARIABLES;
  const fromFile = (filePath) => {
    const found = readEnvFile(filePath, names);
    return found && { token: found.value, source: { kind: 'file', path: filePath, variable: found.name } };
  };

  if (envFile) {
    const filePath = path.resolve(cwd, envFile);
    const result = fromFile(filePath);
    if (result) return result;
    throw new Error(`${names.join(' or ')} was not found in ${filePath}`);
  }

  const name = names.find((candidate) => env[candidate]);
  if (name) return { token: env[name], source: { kind: 'env', variable: name } };

  const filePath = path.resolve(cwd, env.DISCORD_RESEARCH_ENV_FILE || '.env');
  const result = fromFile(filePath);
  if (result) return result;
  throw new Error(`Discord token not found: set ${names.join(' or ')} in the environment or in ${filePath}, or pass --env-file <path>`);
}

export function loadToken(options) {
  return resolveToken(options).token;
}
