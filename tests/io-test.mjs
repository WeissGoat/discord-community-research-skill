import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireRunLock, createRunDirectory, ensureOutputFile, ensurePrivateDirectory, resolveToken, SKILL_DIR, writeTextAtomic } from '../scripts/lib/io.mjs';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-research-io-'));
}

function lockedError() {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

test('atomic writes retry a rename that Windows briefly refuses', (t) => {
  const root = makeTempRoot();
  const target = path.join(root, 'state.json');
  const rename = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    calls += 1;
    if (calls <= 2) throw lockedError();
    return rename(...args);
  });

  writeTextAtomic(target, '{"ok":true}\n', { retryDelaysMs: [0, 0, 0] });

  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('atomic writes fall back to an in-place write when the target stays locked', (t) => {
  const root = makeTempRoot();
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, 'old', 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw lockedError();
  });

  writeTextAtomic(target, 'new', { retryDelaysMs: [0, 0] });

  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('a run directory refuses a second live writer but replaces a stale lock', () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, 'run.lock'), JSON.stringify({ pid: 424242, startedAt: '2026-09-01T00:00:00.000Z' }), 'utf8');

  assert.throws(() => acquireRunLock(root, { isAlive: () => true }), /in use by process 424242/);

  const release = acquireRunLock(root, { isAlive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'run.lock'), 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(path.join(root, 'run.lock')), false);
});

test('run output defaults to the working directory and is kept out of git', () => {
  const workspace = makeTempRoot();
  const runDir = createRunDirectory({ runId: 'portable-run', env: {}, cwd: workspace });

  assert.equal(runDir.directory, path.join(workspace, 'discord_research', 'runs', 'portable-run'));
  const ignorePath = path.join(runDir.directory, '.gitignore');
  assert.match(fs.readFileSync(ignorePath, 'utf8'), /^\*$/m);

  fs.writeFileSync(ignorePath, 'kept\n', 'utf8');
  createRunDirectory({ runId: 'portable-run', env: {}, cwd: workspace });
  assert.equal(fs.readFileSync(ignorePath, 'utf8'), 'kept\n');

  const shared = makeTempRoot();
  assert.equal(createRunDirectory({ runId: 'r', env: { DISCORD_RESEARCH_OUTPUT: shared }, cwd: workspace }).directory, path.join(shared, 'r'));
});

test('run output is never written inside the skill directory', () => {
  assert.throws(() => createRunDirectory({ runId: 'r', env: {}, cwd: SKILL_DIR }), /inside the skill directory/);
  assert.throws(() => createRunDirectory({ outputRoot: path.join(SKILL_DIR, 'runs'), runId: 'r', env: {} }), /inside the skill directory/);
  assert.equal(fs.existsSync(path.join(SKILL_DIR, 'discord_research')), false);
});

test('the token resolves from the environment, the working directory .env, or an explicit file', () => {
  const workspace = makeTempRoot();
  assert.deepEqual(
    resolveToken({ env: { VITE_DISCORD_TOKEN: 'legacy', DISCORD_TOKEN: 'generic' }, cwd: workspace }),
    { token: 'generic', source: { kind: 'env', variable: 'DISCORD_TOKEN' } },
  );

  fs.writeFileSync(path.join(workspace, '.env'), 'OTHER=1\r\nexport VITE_DISCORD_TOKEN="from-dotenv"\r\n', 'utf8');
  assert.deepEqual(resolveToken({ env: {}, cwd: workspace }), {
    token: 'from-dotenv',
    source: { kind: 'file', path: path.join(workspace, '.env'), variable: 'VITE_DISCORD_TOKEN' },
  });

  const secrets = path.join(makeTempRoot(), 'discord.env');
  fs.writeFileSync(secrets, 'DISCORD_TOKEN=from-shared-file\n', 'utf8');
  assert.equal(resolveToken({ env: { DISCORD_RESEARCH_ENV_FILE: secrets }, cwd: workspace }).token, 'from-shared-file');
  assert.equal(resolveToken({ env: { DISCORD_TOKEN: 'ignored' }, cwd: workspace, envFile: secrets }).token, 'from-shared-file');
  assert.throws(() => resolveToken({ env: {}, cwd: workspace, envFile: path.join(workspace, 'missing.env') }), /was not found in/);
  assert.throws(() => resolveToken({ env: {}, cwd: makeTempRoot() }), /DISCORD_TOKEN or VITE_DISCORD_TOKEN.*--env-file/);
});

test('command outputs mark only the directories they create as private', () => {
  const workspace = makeTempRoot();
  const created = path.join(workspace, 'discord_research', 'media', 'nai-v5');
  ensureOutputFile(path.join(created, 'threads.json'));
  assert.match(fs.readFileSync(path.join(created, '.gitignore'), 'utf8'), /^\*$/m);

  ensurePrivateDirectory(workspace);
  assert.equal(fs.existsSync(path.join(workspace, '.gitignore')), false);
  assert.throws(() => ensureOutputFile(path.join(SKILL_DIR, 'out', 'x.json')), /inside the skill directory/);
  assert.equal(fs.existsSync(path.join(SKILL_DIR, 'out')), false);
});
