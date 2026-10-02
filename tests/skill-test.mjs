// The skill must keep working after its directory is copied into another
// project or agent platform; these checks guard that contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SKILL_DIR } from '../scripts/lib/io.mjs';

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// Static imports and re-exports, side-effect imports, and dynamic imports.
const IMPORT_PATTERN = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
const read = (file) => fs.readFileSync(path.join(SKILL_DIR, file), 'utf8');
const isInsideSkill = (target) => !path.relative(SKILL_DIR, target).startsWith('..');

function frontmatter() {
  const block = read('SKILL.md').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(block, 'SKILL.md starts with a frontmatter block');
  // Single-line plain values parse the same in strict YAML and in the simple
  // frontmatter readers some agent platforms use.
  return Object.fromEntries(block[1].split(/\r?\n/).map((line) => {
    const field = line.match(/^([a-z-]+): (.+)$/);
    assert.ok(field, `frontmatter line is not a single-line "key: value": ${line}`);
    assert.doesNotMatch(field[2], /: | #|^[[{&*!|>'"%@`]/, `frontmatter value for ${field[1]} needs YAML quoting`);
    return [field[1], field[2]];
  }));
}

test('frontmatter follows the Agent Skills specification', () => {
  const fields = frontmatter();
  for (const key of Object.keys(fields)) assert.ok(SPEC_FIELDS.has(key), `unknown frontmatter field ${key}`);
  assert.equal(fields.name, path.basename(SKILL_DIR), `the skill directory must be named ${fields.name}; clone into a directory with that name`);
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description.length <= 1024, `description is ${fields.description.length} characters`);
  assert.ok((fields.compatibility ?? '').length <= 500);
  assert.match(read(path.join('agents', 'openai.yaml')), new RegExp(`\\$${fields.name}\\b`));
});

test('scripts import only Node built-ins and files inside the skill', () => {
  const scriptsDir = path.join(SKILL_DIR, 'scripts');
  const files = fs.readdirSync(scriptsDir, { recursive: true }).filter((file) => file.endsWith('.mjs'));
  assert.ok(files.length > 0);
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      checked += 1;
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${file} imports ${specifier}, which would need an install step`);
      const target = path.resolve(scriptsDir, path.dirname(file), specifier);
      assert.ok(isInsideSkill(target) && fs.existsSync(target), `${file} imports ${specifier} from outside the skill`);
    }
  }
  // Guards the pattern itself: a regex that matched nothing would pass vacuously.
  assert.ok(checked >= files.length, `only ${checked} imports found in ${files.length} files`);
});

test('docs use skill-relative paths that exist', () => {
  const docs = ['SKILL.md', ...fs.readdirSync(path.join(SKILL_DIR, 'references')).map((name) => path.join('references', name))];
  for (const doc of docs) {
    const text = read(doc);
    assert.doesNotMatch(text, /\b[A-Za-z]:\\|\.agents\/|\.codex\b|\.claude\/|\/Users\/|\/home\//, `${doc} hard-codes a machine or install path`);
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const resolved = path.resolve(SKILL_DIR, path.dirname(doc), target);
      assert.ok(isInsideSkill(resolved) && fs.existsSync(resolved), `${doc} links to missing ${target}`);
    }
    for (const [, script] of text.matchAll(/<skill-dir>\/(scripts\/[\w.-]+)/g)) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, script)), `${doc} names missing ${script}`);
    }
    for (const [, script] of text.matchAll(/`([\w-]+\.mjs)`/g)) {
      assert.ok(fs.existsSync(path.join(SKILL_DIR, 'scripts', script)), `${doc} names missing script ${script}`);
    }
  }
});

test('SKILL.md lists every command', () => {
  const skill = read('SKILL.md');
  for (const script of fs.readdirSync(path.join(SKILL_DIR, 'scripts')).filter((file) => file.endsWith('.mjs'))) {
    assert.match(skill, new RegExp(`\`${script.replace('.', '\\.')}\``), `SKILL.md does not list ${script}`);
  }
});
