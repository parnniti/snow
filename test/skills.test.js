import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { bundledSkills, hashDir, installSkills, uninstallSkills, skillStatus } = await import('../src/skills.js');

function tmpDests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-skills-'));
  return { root, dests: { canonical: path.join(root, '.agents', 'skills'), agents: { claude: path.join(root, '.claude', 'skills') } } };
}

test('bundle ships the snow skill with a description', () => {
  const s = bundledSkills().find((x) => x.name === 'snow');
  assert.ok(s, 'snow skill bundled');
  assert.ok(s.description.length > 20);
});

test('install copies, links for claude, is idempotent, and uninstall cleans both', () => {
  const { dests } = tmpDests();
  const skills = bundledSkills();
  const first = installSkills(skills, { dests, agents: ['claude'] });
  assert.deepEqual(first.map((r) => r.action), skills.flatMap(() => ['installed', 'linked']));
  const dst = path.join(dests.canonical, 'snow');
  assert.equal(hashDir(dst), hashDir(skills.find((s) => s.name === 'snow').dir));
  assert.equal(fs.realpathSync(path.join(dests.agents.claude, 'snow')), fs.realpathSync(dst));
  assert.deepEqual(skillStatus(skills[0], dests), { canonical: 'installed', agents: { claude: 'linked' } });

  const again = installSkills(skills, { dests, agents: ['claude'] });
  assert.deepEqual(again.map((r) => r.action), skills.flatMap(() => ['unchanged', 'link-ok']));

  fs.appendFileSync(path.join(dst, 'SKILL.md'), '\nlocal edit\n');
  assert.equal(skillStatus(skills[0], dests).canonical, 'outdated');
  assert.equal(installSkills(skills, { dests })[0].action, 'updated');

  const removed = uninstallSkills(skills, { dests });
  assert.deepEqual(removed.map((r) => r.action), skills.flatMap(() => ['unlinked', 'removed']));
  assert.equal(fs.existsSync(dst), false);
  assert.equal(fs.existsSync(path.join(dests.agents.claude, 'snow')), false);
});

test('a same-named skill not installed by snow is never overwritten or removed without --force', () => {
  const { dests } = tmpDests();
  const skills = bundledSkills();
  const dst = path.join(dests.canonical, 'snow');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'SKILL.md'), 'someone else');

  assert.equal(installSkills(skills, { dests })[0].action, 'skipped-foreign');
  assert.equal(uninstallSkills(skills, { dests })[0].action, 'skipped-foreign');
  assert.equal(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8'), 'someone else');

  assert.equal(installSkills(skills, { dests, force: true })[0].action, 'updated');
  assert.notEqual(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8'), 'someone else');
});

test('dry run writes nothing', () => {
  const { dests } = tmpDests();
  const res = installSkills(bundledSkills(), { dests, agents: ['claude'], dryRun: true });
  assert.ok(res.every((r) => r.action.startsWith('would-')));
  assert.equal(fs.existsSync(dests.canonical), false);
});
