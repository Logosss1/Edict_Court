// Built-in skill pack (内置技能包): structural and safety invariants of BUILTIN_SKILL_PACK (pure data, no LLM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SKILL_PACK, SKILL_CATEGORY_LABEL, type SkillCategory } from '../src/main/runtime/builtinSkills';
import { TOOL_SPECS } from '../src/main/runtime/tools';
import { AGENTS } from '../src/shared/court';
import { skillSlug } from '../src/main/runtime/extras';
import type { AgentId } from '../src/shared/types';

const PACK = BUILTIN_SKILL_PACK;
const byName = new Map(PACK.map((s) => [s.name, s]));
const AGENT_IDS = new Set<string>(AGENTS.map((a) => a.id));
const TOOL_NAMES = new Set(Object.keys(TOOL_SPECS));
const TOOL_PARAMS = new Set(Object.values(TOOL_SPECS).flatMap((t) => Object.keys((t.parameters.properties ?? {}) as Record<string, unknown>)));
// Identifiers a body may legitimately write in snake_case: tools, their parameters, agent ids.
const ALLOWED_IDENT = new Set([...TOOL_NAMES, ...TOOL_PARAMS, ...AGENT_IDS]);
// Non-tool snake_case words allowed in prose (each one is a well-known external name, not a tool call).
const PROSE_IDENT = new Set(['pull_request_target']);
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const EMOJI = /\p{Extended_Pictographic}/u;

const stripFences = (md: string) => md.replace(/```[\s\S]*?```/g, '');
const inlineSpans = (md: string) => [...stripFences(md).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const prose = (md: string) => stripFences(md).replace(/`[^`\n]+`/g, ' ');

test('pack: names are unique, kebab-case and stable under skillSlug', () => {
  assert.ok(PACK.length >= 30, `expected a full pack, got ${PACK.length}`);
  assert.equal(byName.size, PACK.length, 'duplicate skill names');
  for (const s of PACK) {
    assert.match(s.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${s.name} is not kebab-case`);
    assert.equal(skillSlug(s.name), s.name, `${s.name} would be renamed when saved`);
  }
});

test('pack: covers the requested gstack-style, everyday and legacy skills', () => {
  const required = [
    // gstack-style workflow skills (codex is renamed second-opinion)
    'autoplan', 'benchmark', 'browse', 'canary', 'careful', 'second-opinion', 'cso', 'design-consultation', 'design-review',
    'document-release', 'investigate', 'land-and-deploy', 'office-hours', 'plan-ceo-review', 'plan-design-review', 'plan-eng-review',
    'qa', 'qa-only', 'retro', 'review', 'setup-deploy', 'ship',
    // everyday skills
    'tdd', 'refactor-safely', 'debug-flaky-test', 'dependency-upgrade', 'performance-profile', 'api-design', 'db-migration',
    'accessibility-audit', 'i18n', 'code-reading', 'changelog', 'incident-postmortem',
  ];
  for (const n of required) assert.ok(byName.has(n), `missing skill ${n}`);
  assert.ok(!byName.has('codex'), 'codex must be shipped as second-opinion');
});

test('pack: the three legacy builtin skills keep their names', () => {
  for (const n of ['code-review-checklist', 'test-writing', 'commit-message']) assert.ok(byName.has(n), `legacy skill ${n} missing`);
});

test('pack: metadata fields are well-formed', () => {
  const cats = Object.keys(SKILL_CATEGORY_LABEL) as SkillCategory[];
  for (const s of PACK) {
    assert.ok(cats.includes(s.category), `${s.name}: unknown category ${s.category}`);
    assert.ok(s.title.trim() && [...s.title].length <= 10 && /[一-鿿]/.test(s.title), `${s.name}: title should be a short Chinese name`);
    assert.match(s.icon, /^\p{Extended_Pictographic}️?$/u, `${s.name}: icon must be exactly one emoji`);
    assert.ok(s.description.trim(), `${s.name}: empty description`);
    assert.ok([...s.description].length <= 60, `${s.name}: description is ${[...s.description].length} chars (> 60)`);
    assert.ok(!/[\r\n]/.test(s.description), `${s.name}: description must be one line (it goes into SKILL.md frontmatter)`);
    assert.ok(/[一-鿿]/.test(s.description), `${s.name}: description should be Chinese`);
    assert.ok(Number.isInteger(s.version) && s.version >= 1, `${s.name}: version must be an integer >= 1`);
    if (s.risk !== undefined) assert.ok(s.risk === 'release' || s.risk === 'deploy', `${s.name}: bad risk ${s.risk}`);
  }
  for (const c of cats) assert.ok(PACK.some((s) => s.category === c), `category ${c} has no skills`);
});

test('duty: every duty id is a real AgentId and each official holds a few fixed skills', () => {
  const held = new Map<string, string[]>();
  for (const s of PACK) {
    assert.equal(new Set(s.duty).size, s.duty.length, `${s.name}: duplicate duty ids`);
    for (const a of s.duty) {
      assert.ok(AGENT_IDS.has(a), `${s.name}: unknown agent id ${a}`);
      held.set(a, [...(held.get(a) ?? []), s.name]);
    }
  }
  for (const a of ['taizi', 'zaochao'] satisfies AgentId[]) assert.deepEqual(held.get(a) ?? [], [], `${a} should hold no duty skills`);
  for (const a of AGENTS.map((x) => x.id).filter((id) => id !== 'taizi' && id !== 'zaochao')) {
    const n = held.get(a)?.length ?? 0;
    assert.ok(n >= 1 && n <= 4, `${a} holds ${n} duty skills (expected 1-4)`);
  }
});

test('risk: release/deploy skills require 皇上 confirmation and are never default-equipped where reserved', () => {
  assert.equal(byName.get('ship')?.risk, 'release');
  for (const n of ['setup-deploy', 'land-and-deploy', 'canary']) assert.equal(byName.get(n)?.risk, 'deploy', `${n} should be marked deploy`);
  for (const n of ['land-and-deploy', 'canary']) assert.deepEqual(byName.get(n)?.duty, [], `${n} must only be equipped by the emperor's choice`);
  const gated = PACK.filter((s) => s.risk || s.category === 'release' || s.category === 'deploy');
  assert.ok(gated.length >= 6);
  for (const s of gated) {
    assert.ok(s.content.includes('请皇上确认'), `${s.name}: must say Edict asks 皇上 to confirm`);
    assert.ok(s.content.includes('永久允许'), `${s.name}: must mention the workspace permission setting exception`);
    assert.ok(s.content.includes('绝不绕过确认'), `${s.name}: must forbid bypassing the confirmation`);
    for (const op of ['推送', '发布', '部署', '不可逆']) assert.ok(s.content.includes(op), `${s.name}: risk gate should name ${op}`);
  }
});

test('content: size bounds, heading, required sections, no emoji, no leftover placeholders', () => {
  for (const s of PACK) {
    const lines = s.content.split('\n');
    assert.ok(lines.length >= 25 && lines.length <= 80, `${s.name}: ${lines.length} lines (expected 25-80)`);
    assert.ok(s.content.length <= 6000, `${s.name}: ${s.content.length} chars (load_skill truncates long bodies)`);
    assert.ok(!s.content.startsWith('---'), `${s.name}: body must not carry frontmatter`);
    assert.equal(lines[0], `# ${s.title}（${s.name}）`, `${s.name}: first line must be the heading`);
    for (const h of ['## 步骤', '## 证据', '## 回报格式', '## 停下请示']) assert.ok(lines.includes(h), `${s.name}: missing section ${h}`);
    assert.ok(!EMOJI.test(s.content), `${s.name}: body contains an emoji`);
    assert.ok(!/\{\{[A-Z_]+\}\}|\$\{/.test(s.content), `${s.name}: unresolved placeholder`);
  }
});

test('content: ministries close with EXEC_OUTPUT_RULE by reference, never a restated schema', () => {
  for (const s of PACK) {
    assert.ok(s.content.includes('EXEC_OUTPUT_RULE') && s.content.includes('结构化结论'), `${s.name}: must point to the structured conclusion`);
    assert.ok(!/"status"\s*:\s*"done"/.test(s.content), `${s.name}: must not redefine the conclusion JSON`);
  }
});

test('content: only real tool names are referenced', () => {
  for (const s of PACK) {
    // 1. backticked snake_case identifiers (optionally written as a call) must be tools, tool parameters or agent ids
    for (const span of inlineSpans(s.content)) {
      const id = span.match(/^([a-z][a-z0-9_]*)(?:\(.*\))?$/)?.[1];
      if (id && SNAKE.test(id)) assert.ok(ALLOWED_IDENT.has(id), `${s.name}: \`${span}\` is not a real tool`);
    }
    // 2. bare snake_case words in prose
    for (const m of prose(s.content).matchAll(/(?<![\w-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g)) {
      assert.ok(ALLOWED_IDENT.has(m[0]) || PROSE_IDENT.has(m[0]), `${s.name}: "${m[0]}" looks like a tool name but no such tool exists`);
    }
    // 3. call-shaped snake_case anywhere, including report templates in fenced blocks
    for (const m of s.content.matchAll(/(?<![\w.-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)) {
      assert.ok(TOOL_NAMES.has(m[1]), `${s.name}: "${m[1]}(" is not a real tool`);
    }
    // 4. MCP tools are only referenced generically (mcp__服务__工具), never as a concrete invented tool
    for (const m of s.content.matchAll(/mcp__[A-Za-z0-9_-]+/g)) assert.fail(`${s.name}: concrete MCP tool ${m[0]} may not exist`);
    assert.ok([...TOOL_NAMES].some((t) => s.content.includes(t)), `${s.name}: names no tool at all`);
  }
});

test('content: cross-references (技能 `x`) point at skills in the pack', () => {
  for (const s of PACK) {
    for (const m of s.content.matchAll(/技能\s*`([a-z0-9-]+)`/g)) {
      assert.ok(byName.has(m[1]), `${s.name}: references unknown skill ${m[1]}`);
      assert.notEqual(m[1], s.name, `${s.name}: references itself`);
    }
  }
});
