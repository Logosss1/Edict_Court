// Edict 2.0 skills: built-in pack seeding, duty skills vs equipped extras, 1.x upgrade, skill use on the
// memorial, remote skill hashes and update checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit } from '../src/main/runtime/orchestrator';
import { addRemoteSkill, checkSkillUpdate, equipSkill, loadSkills, removeSkill, restoreBuiltinSkill, saveSkill, setSkillDuty, setSkillEnabled, updateRemoteSkill } from '../src/main/runtime/extras';
import { BUILTIN_SKILL_PACK } from '../src/main/runtime/builtinSkills';
import { BUILTIN_SKILLS } from '../src/main/runtime/defaults';
import { systemPromptFor } from '../src/main/runtime/agentLoop';
import { executeTool } from '../src/main/runtime/tools';
import { skillRole } from '../src/shared/skills';

test('pack is seeded: duty officials only, nobody else equipped; equip / duty changes / restore', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  assert.equal(rt.skills.length, BUILTIN_SKILL_PACK.length);
  const review = rt.skills.find((s) => s.name === 'review')!;
  assert.deepEqual(review.duty, ['menxia']);
  assert.deepEqual(review.agents, []);
  assert.equal(review.title, '代码评审');
  assert.equal(skillRole(review, 'menxia'), 'duty');
  assert.equal(skillRole(review, 'bingbu'), null);
  assert.ok(rt.skills.every((s) => s.agents !== 'all' && s.agents.length === 0), 'no extras equipped by default');
  assert.ok(rt.skills.filter((s) => s.risk).every((s) => ['ship', 'setup-deploy', 'land-and-deploy', 'canary'].includes(s.name)));
  // system prompt: duty section, no extras yet
  let sys = systemPromptFor(rt, 'menxia');
  assert.match(sys, /职责技能[\s\S]*review（代码评审）/);
  assert.doesNotMatch(sys, /已配备的其他技能/);
  // equip an extra like an extension
  equipSkill(rt, 'browse', 'menxia', true);
  sys = systemPromptFor(rt, 'menxia');
  assert.match(sys, /已配备的其他技能[\s\S]*browse/);
  assert.equal(skillRole(rt.skills.find((s) => s.name === 'browse')!, 'menxia'), 'extra');
  equipSkill(rt, 'browse', 'menxia', false);
  assert.equal(skillRole(rt.skills.find((s) => s.name === 'browse')!, 'menxia'), null);
  // duty adjustment (Rowan may move duties)
  setSkillDuty(rt, 'review', ['menxia', 'xingbu']);
  assert.equal(skillRole(rt.skills.find((s) => s.name === 'review')!, 'xingbu'), 'duty');
  // disabling hides it from everyone, but it stays a pristine built-in
  setSkillEnabled(rt, 'review', false);
  const off = rt.skills.find((s) => s.name === 'review')!;
  assert.equal(skillRole(off, 'menxia'), null);
  assert.equal(off.source, 'builtin');
  // delete → stays deleted across reloads; restore brings it back
  removeSkill(rt, 'canary');
  loadSkills(rt);
  assert.ok(!rt.skills.some((s) => s.name === 'canary'));
  restoreBuiltinSkill(rt, 'canary');
  assert.ok(rt.skills.some((s) => s.name === 'canary'));
  // taizi carries nothing
  assert.equal(systemPromptFor(rt, 'taizi').includes('职责技能'), false);
  rt.dispose();
  await mock.close();
});

test('1.x seeded skills: untouched ones upgrade to the pack (equip kept as extras), edited ones are left alone', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-data-');
  const dir = path.join(dataDir, 'skills');
  const legacy = BUILTIN_SKILLS.find((b) => b.name === 'code-review-checklist')!;
  const edited = BUILTIN_SKILLS.find((b) => b.name === 'test-writing')!;
  fs.mkdirSync(path.join(dir, legacy.name), { recursive: true });
  fs.writeFileSync(path.join(dir, legacy.name, 'SKILL.md'), `---\nname: ${legacy.name}\ndescription: ${legacy.description}\nagents: menxia,xingbu,bingbu\nsource: builtin\n---\n${legacy.content}\n`);
  fs.mkdirSync(path.join(dir, edited.name), { recursive: true });
  fs.writeFileSync(path.join(dir, edited.name, 'SKILL.md'), `---\nname: ${edited.name}\ndescription: mine\nagents: solo\nsource: builtin\n---\n# 我自己改过的\n`);
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const up = rt.skills.find((s) => s.name === legacy.name)!;
  const pack = BUILTIN_SKILL_PACK.find((b) => b.name === legacy.name)!;
  assert.equal(up.version, pack.version);
  assert.deepEqual(up.duty, pack.duty);
  assert.deepEqual(up.agents, ['xingbu', 'bingbu'], '1.x equip kept as extras, minus the duty holder');
  assert.ok(fs.readFileSync(up.path, 'utf8').includes(pack.content.trim().split('\n')[0]));
  const mine = rt.skills.find((s) => s.name === edited.name)!;
  assert.ok(fs.readFileSync(mine.path, 'utf8').includes('我自己改过的'));
  assert.deepEqual(mine.agents, ['solo']);
  // an edited built-in becomes the emperor's own (never overwritten by later upgrades)
  saveSkill(rt, { name: 'review', description: 'x', agents: [], content: '# 改', originalName: 'review' });
  assert.equal(rt.skills.find((s) => s.name === 'review')!.source, 'local');
  assert.deepEqual(rt.skills.find((s) => s.name === 'review')!.duty, ['menxia'], 'duty survives an edit');
  loadSkills(rt);
  assert.ok(fs.readFileSync(rt.skills.find((s) => s.name === 'review')!.path, 'utf8').includes('# 改'));
  rt.dispose();
  await mock.close();
});

test('load_skill: only duty or equipped skills; each load is recorded on the edict and in the memorial', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ finalGate: false });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const denied = await executeTool({ rt, agentId: 'bingbu' }, 'load_skill', { name: 'review' });
  assert.equal(denied.ok, false);
  assert.match(denied.output, /未配备/);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 25000, 'done');
  const t = rt.tasks.get(r.taskId)!;
  const ok = await executeTool({ rt, agentId: 'bingbu', task: t }, 'load_skill', { name: 'tdd' });
  assert.equal(ok.ok, true);
  assert.match(ok.output, /测试驱动/);
  await executeTool({ rt, agentId: 'bingbu', task: t }, 'load_skill', { name: 'tdd' });
  assert.equal(t.skillsUsed!.length, 1, 'same text by the same official is recorded once');
  assert.equal(t.skillsUsed![0].sha256, rt.skills.find((s) => s.name === 'tdd')!.sha256);
  const { buildMemorial } = await import('../src/main/runtime/runtime');
  const m = buildMemorial(t);
  assert.ok(m.stages.some((s) => s.key === 'skills' && s.items.some((i) => i.includes('tdd'))));
  assert.ok(rt.audit.list({ limit: 50 }).some((e) => e.action === 'skill_loaded' && e.detail.name === 'tdd'));
  rt.dispose();
  await mock.close();
});

test('E4: remote skills keep the source hash; update check sees changes; update keeps the equip', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  let body = '# 远程技能 v1\n内容';
  (rt.opts as { fetchImpl: unknown }).fetchImpl = async () => new Response(body, { status: 200 });
  await addRemoteSkill(rt, { name: 'remote-one', url: 'https://example.com/SKILL.md', description: 'r', agents: ['gongbu'] });
  const s = rt.skills.find((x) => x.name === 'remote-one')!;
  assert.equal(s.remoteSha256, s.sha256);
  assert.equal((await checkSkillUpdate(rt, 'remote-one')).changed, false);
  body = '# 远程技能 v2\n新内容';
  const chk = await checkSkillUpdate(rt, 'remote-one');
  assert.equal(chk.changed, true);
  await updateRemoteSkill(rt, 'remote-one');
  const s2 = rt.skills.find((x) => x.name === 'remote-one')!;
  assert.deepEqual(s2.agents, ['gongbu']);
  assert.equal(s2.remoteSha256, chk.remoteSha);
  assert.ok(fs.readFileSync(s2.path, 'utf8').includes('v2'));
  await assert.rejects(checkSkillUpdate(rt, 'review'), /只有从链接添加/);
  rt.dispose();
  await mock.close();
});
