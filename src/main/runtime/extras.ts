// Skills (技能配置) and news (天下要闻) services.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, SkillInfo } from '../../shared/types';
import type { Runtime } from './runtime';
import { BUILTIN_SKILLS } from './defaults';
import { BUILTIN_SKILL_PACK } from './builtinSkills';
import { now, sha256, uid } from './util';

function skillsDir(rt: Runtime) {
  return path.join(rt.opts.dataDir, 'skills');
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

const PACK = new Map(BUILTIN_SKILL_PACK.map((b) => [b.name, b]));
/** 1.x seeded skills whose untouched text is upgraded to the pack version */
const LEGACY_BODY = new Map(BUILTIN_SKILLS.map((b) => [b.name, b.content.trim()]));
const isBuiltinName = (n: string) => PACK.has(n) || LEGACY_BODY.has(n);

const list = (v: AgentId[] | 'all') => (v === 'all' ? 'all' : v.length ? v.join(',') : 'none');
const parseAgents = (v: string | undefined): AgentId[] | 'all' => (!v || v === 'all' ? 'all' : v === 'none' ? [] : (v.split(',').map((x) => x.trim()).filter(Boolean) as AgentId[]));

interface SkillMeta {
  name: string;
  description: string;
  agents: AgentId[] | 'all';
  duty: AgentId[];
  source: SkillInfo['source'];
  sourceUrl?: string;
  enabled: boolean;
  title?: string;
  category?: string;
  icon?: string;
  risk?: 'release' | 'deploy';
  version?: number;
  bodySha?: string; // body sha256 as written by the pack (unmodified ⇒ safe to upgrade)
  remoteSha256?: string;
}

function renderSkill(m: SkillMeta, body: string): string {
  const lines = [
    `name: ${m.name}`,
    m.title ? `title: ${m.title}` : '',
    `description: ${m.description.replace(/\n/g, ' ')}`,
    m.category ? `category: ${m.category}` : '',
    m.icon ? `icon: ${m.icon}` : '',
    `duty: ${m.duty.length ? m.duty.join(',') : 'none'}`,
    `agents: ${list(m.agents)}`,
    m.risk ? `risk: ${m.risk}` : '',
    m.version ? `version: ${m.version}` : '',
    m.bodySha ? `bodySha: ${m.bodySha}` : '',
    `source: ${m.source}`,
    m.sourceUrl ? `sourceUrl: ${m.sourceUrl}` : '',
    m.remoteSha256 ? `remoteSha256: ${m.remoteSha256}` : '',
    m.enabled === false ? 'enabled: false' : '',
  ].filter(Boolean);
  return `---\n${lines.join('\n')}\n---\n${body.replace(/\s+$/, '')}\n`;
}

function metaOf(meta: Record<string, string>, fallbackName: string): SkillMeta {
  return {
    name: meta.name || fallbackName,
    description: meta.description || '',
    agents: parseAgents(meta.agents),
    duty: parseAgents(meta.duty || 'none') as AgentId[],
    source: (meta.source as SkillInfo['source']) || 'local',
    sourceUrl: meta.sourceUrl,
    enabled: meta.enabled !== 'false',
    title: meta.title,
    category: meta.category,
    icon: meta.icon,
    risk: meta.risk === 'release' || meta.risk === 'deploy' ? meta.risk : undefined,
    version: meta.version ? Number(meta.version) || undefined : undefined,
    bodySha: meta.bodySha,
    remoteSha256: meta.remoteSha256,
  };
}

/**
 * Seed the built-in pack: new skills are written once and equipped to nobody except their duty officials
 * (a skill the emperor deleted stays deleted). A built-in whose text the emperor never edited is upgraded
 * in place when the pack has a newer version; his equip choices are kept.
 */
function seedPack(rt: Runtime, dir: string) {
  const removed = readRemoved(rt);
  for (const b of BUILTIN_SKILL_PACK) {
    if (removed.includes(b.name)) continue;
    const p = path.join(dir, b.name, 'SKILL.md');
    const body = b.content.trim();
    const fresh: SkillMeta = { name: b.name, title: b.title, description: b.description, category: b.category, icon: b.icon, duty: b.duty, agents: [], risk: b.risk, version: b.version, bodySha: sha256(body), source: 'builtin', enabled: true };
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, renderSkill(fresh, body));
      continue;
    }
    const { meta, body: cur } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
    const m = metaOf(meta, b.name);
    if (m.source !== 'builtin') continue;
    const untouched = m.bodySha ? sha256(cur.trim()) === m.bodySha : LEGACY_BODY.get(b.name) === cur.trim();
    const legacy = !m.version; // seeded by 1.x
    if (!untouched || (!legacy && (m.version ?? 0) >= b.version)) continue;
    // 1.x equipped its built-ins to several officials: keep that as extras, add the 2.0 duty holders
    const agents = legacy ? (m.agents === 'all' ? 'all' : m.agents.filter((a) => !b.duty.includes(a))) : m.agents;
    fs.writeFileSync(p, renderSkill({ ...fresh, agents, duty: legacy ? b.duty : m.duty, enabled: m.enabled }, body));
    rt.audit.record('system', 'skill_upgraded', { name: b.name, from: m.version ?? '1.x', to: b.version });
  }
}

export function loadSkills(rt: Runtime) {
  const dir = skillsDir(rt);
  fs.mkdirSync(dir, { recursive: true });
  seedPack(rt, dir);
  const out: SkillInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
    const m = metaOf(meta, name);
    out.push({
      name: m.name, description: m.description, agents: m.agents, duty: m.duty, path: p, source: m.source, sourceUrl: m.sourceUrl, enabled: m.enabled,
      title: m.title, category: m.category, icon: m.icon, risk: m.risk, version: m.version, sha256: sha256(body.trim()), remoteSha256: m.remoteSha256,
    });
  }
  rt.skills = out.sort((a, b) => a.name.localeCompare(b.name));
  rt.emit({ type: 'skills', skills: rt.skills });
}

/** Equip / unequip one extra skill for one official (the duty set is changed with setSkillDuty). */
export function equipSkill(rt: Runtime, name: string, agentId: AgentId, on: boolean) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  const { meta, body } = parseFrontmatter(fs.readFileSync(s.path, 'utf8'));
  const m = metaOf(meta, name);
  if (m.agents === 'all') {
    if (on) return;
    m.agents = (['zhongshu', 'menxia', 'shangshu', 'libu', 'hubu', 'libu_hr', 'bingbu', 'xingbu', 'gongbu', 'solo'] as AgentId[]).filter((a) => a !== agentId);
  } else m.agents = on ? [...new Set([...m.agents, agentId])] : m.agents.filter((a) => a !== agentId);
  fs.writeFileSync(s.path, renderSkill(m, body));
  rt.audit.record('emperor', on ? 'skill_equipped' : 'skill_unequipped', { name, agentId });
  loadSkills(rt);
}

/** Change which officials hold a skill as a duty skill (职责技能). */
export function setSkillDuty(rt: Runtime, name: string, duty: AgentId[]) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  const { meta, body } = parseFrontmatter(fs.readFileSync(s.path, 'utf8'));
  const m = metaOf(meta, name);
  m.duty = [...new Set(duty)];
  if (m.agents !== 'all') m.agents = m.agents.filter((a) => !m.duty.includes(a));
  fs.writeFileSync(s.path, renderSkill(m, body));
  rt.audit.record('emperor', 'skill_duty_set', { name, duty: m.duty });
  loadSkills(rt);
}

/** Restore a deleted built-in (or reset an edited one) to the pack text, keeping nothing equipped beyond its duty. */
export function restoreBuiltinSkill(rt: Runtime, name: string) {
  const b = PACK.get(name);
  if (!b) throw new Error('不是内置技能');
  fs.writeFileSync(removedFile(rt), readRemoved(rt).filter((n) => n !== name).join('\n'));
  const p = path.join(skillsDir(rt), name, 'SKILL.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = b.content.trim();
  fs.writeFileSync(p, renderSkill({ name, title: b.title, description: b.description, category: b.category, icon: b.icon, duty: b.duty, agents: [], risk: b.risk, version: b.version, bodySha: sha256(body), source: 'builtin', enabled: true }, body));
  rt.audit.record('emperor', 'skill_restored', { name, version: b.version });
  loadSkills(rt);
}

export function readSkill(rt: Runtime, name: string): string {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  return fs.readFileSync(s.path, 'utf8');
}

export function skillSlug(n: string) {
  return n.trim().toLowerCase().replace(/[^a-z0-9_\-一-龥]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export function saveSkill(rt: Runtime, o: { name: string; description: string; agents: AgentId[] | 'all'; content: string; source?: 'local' | 'remote'; sourceUrl?: string; enabled?: boolean; originalName?: string; duty?: AgentId[]; remoteSha256?: string }) {
  const name = skillSlug(o.name);
  if (!name) throw new Error('技能名称无效');
  if (o.originalName && o.originalName !== name && rt.skills.some((s) => s.name === name)) throw new Error(`已存在同名技能：${name}`);
  const prev = rt.skills.find((s) => s.name === (o.originalName ?? name));
  const dir = path.join(skillsDir(rt), name);
  fs.mkdirSync(dir, { recursive: true });
  const body = parseFrontmatter(o.content).body.replace(/\s+$/, '');
  if (body.length > 200_000) throw new Error('技能正文过长（>200KB）');
  // an edited built-in becomes the emperor's own copy (never overwritten by pack upgrades)
  const meta: SkillMeta = {
    name, description: o.description, agents: o.agents, duty: o.duty ?? prev?.duty ?? [], source: o.source ?? 'local', sourceUrl: o.sourceUrl, enabled: o.enabled !== false,
    title: prev?.title, category: prev?.category, icon: prev?.icon, risk: prev?.risk, remoteSha256: o.remoteSha256 ?? (o.source === 'remote' ? prev?.remoteSha256 : undefined),
  };
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkill(meta, body));
  if (o.originalName && o.originalName !== name) {
    const old = rt.skills.find((s) => s.name === o.originalName);
    if (old) fs.rmSync(path.dirname(old.path), { recursive: true, force: true });
  }
  rt.audit.record('emperor', 'skill_saved', { name, agents: o.agents, duty: meta.duty, source: meta.source, sourceUrl: o.sourceUrl, enabled: o.enabled !== false, sha256: sha256(body.trim()), renamedFrom: o.originalName !== name ? o.originalName : undefined });
  loadSkills(rt);
  return name;
}

export function setSkillEnabled(rt: Runtime, name: string, enabled: boolean) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  const text = fs.readFileSync(s.path, 'utf8');
  const { body } = parseFrontmatter(text);
  if (s.source === 'builtin') {
    // toggling keeps it a pristine built-in (still upgradable)
    const { meta } = parseFrontmatter(text);
    const m = metaOf(meta, name);
    fs.writeFileSync(s.path, renderSkill({ ...m, enabled }, body));
    rt.audit.record('emperor', 'skill_saved', { name, enabled });
    return loadSkills(rt);
  }
  saveSkill(rt, { name, description: s.description, agents: s.agents, content: body, source: s.source, sourceUrl: s.sourceUrl, enabled });
}

export function duplicateSkill(rt: Runtime, name: string) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  let n = `${name}-copy`;
  for (let i = 2; rt.skills.some((x) => x.name === n); i++) n = `${name}-copy${i}`;
  return saveSkill(rt, { name: n, description: s.description, agents: s.agents, duty: [], content: parseFrontmatter(fs.readFileSync(s.path, 'utf8')).body, enabled: false });
}

/** Import a skill folder (Anthropic / Cursor style: a folder containing SKILL.md). Only SKILL.md text is copied. */
export function importSkillFolder(rt: Runtime, folder: string) {
  const file = ['SKILL.md', 'skill.md', 'README.md'].map((f) => path.join(folder, f)).find((f) => fs.existsSync(f));
  if (!file) throw new Error('所选文件夹中没有 SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > 200_000) throw new Error('技能文件过大');
  const { meta, body } = parseFrontmatter(text);
  const name = saveSkill(rt, { name: meta.name || path.basename(folder), description: meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 120) || '', agents: 'all', content: body });
  rt.audit.record('emperor', 'skill_imported', { name, from: path.basename(folder) });
  return name;
}

function removedFile(rt: Runtime) {
  return path.join(skillsDir(rt), '.removed-builtins');
}
function readRemoved(rt: Runtime): string[] {
  try {
    return fs.readFileSync(removedFile(rt), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchSkillText(rt: Runtime, url: string): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new Error('仅支持 https 链接');
  const res = await rt.opts.fetchImpl(url, { method: 'GET', headers: { accept: 'text/plain, text/markdown, */*' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 200_000) throw new Error('技能文件过大');
  return text;
}

export async function addRemoteSkill(rt: Runtime, o: { name: string; url: string; description: string; agents: AgentId[] | 'all' }) {
  const text = await fetchSkillText(rt, o.url);
  saveSkill(rt, { ...o, content: text, source: 'remote', sourceUrl: o.url, remoteSha256: sha256(parseFrontmatter(text).body.trim()) });
}

/** E4: compare a remote skill with its source (sha256 of the body). */
export async function checkSkillUpdate(rt: Runtime, name: string): Promise<{ changed: boolean; localSha: string; remoteSha: string; edited: boolean }> {
  const s = rt.skills.find((x) => x.name === name);
  if (!s || s.source !== 'remote' || !s.sourceUrl) throw new Error('只有从链接添加的技能可以检查更新');
  const text = await fetchSkillText(rt, s.sourceUrl);
  const remoteSha = sha256(parseFrontmatter(text).body.trim());
  return { changed: remoteSha !== (s.remoteSha256 ?? s.sha256), localSha: s.sha256, remoteSha, edited: !!s.remoteSha256 && s.remoteSha256 !== s.sha256 };
}

/** Re-download a remote skill, keeping who it is equipped to. */
export async function updateRemoteSkill(rt: Runtime, name: string) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s || s.source !== 'remote' || !s.sourceUrl) throw new Error('只有从链接添加的技能可以更新');
  const text = await fetchSkillText(rt, s.sourceUrl);
  const remoteSha = sha256(parseFrontmatter(text).body.trim());
  saveSkill(rt, { name, description: s.description, agents: s.agents, duty: s.duty, content: text, source: 'remote', sourceUrl: s.sourceUrl, enabled: s.enabled, remoteSha256: remoteSha });
  rt.audit.record('emperor', 'skill_updated', { name, from: s.remoteSha256 ?? s.sha256, to: remoteSha });
}

export function removeSkill(rt: Runtime, name: string) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) return;
  fs.rmSync(path.dirname(s.path), { recursive: true, force: true });
  if (isBuiltinName(name)) fs.writeFileSync(removedFile(rt), [...new Set([...readRemoved(rt), name])].join('\n'));
  rt.audit.record('emperor', 'skill_removed', { name });
  loadSkills(rt);
}

// ───────────────────────── news ─────────────────────────
function decodeEntities(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseFeed(xml: string, source: string, category: string) {
  const items: { title: string; link?: string; at: number; summary?: string; source: string; category: string }[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
  for (const b of blocks.slice(0, 30)) {
    const title = decodeEntities(b.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = b.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? decodeEntities(b.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    const date = b.match(/<(pubDate|updated|published|dc:date)>([\s\S]*?)<\/\1>/)?.[2];
    const summary = decodeEntities(b.match(/<(description|summary)[^>]*>([\s\S]*?)<\/\1>/)?.[2] ?? '').slice(0, 240);
    if (title) items.push({ title, link: link || undefined, at: date ? Date.parse(date) || now() : now(), summary, source, category });
  }
  return items;
}

export async function refreshNews(rt: Runtime): Promise<{ fetched: number; errors: string[] }> {
  const errors: string[] = [];
  let fetched = 0;
  const feeds = rt.settings.newsFeeds.filter((f) => f.enabled && /^https?:\/\//.test(f.url));
  for (const f of feeds) {
    try {
      const res = await rt.opts.fetchImpl(f.url, { method: 'GET', headers: { accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const host = new URL(f.url).hostname;
      const items = parseFeed(xml, host, f.category);
      const known = new Set(rt.news.map((n) => n.link ?? n.title));
      for (const it of items.reverse()) {
        if (known.has(it.link ?? it.title)) continue;
        rt.news.unshift({ id: uid('nw'), ...it });
        fetched++;
      }
    } catch (e) {
      errors.push(`${f.url}: ${(e as Error).message}`);
    }
  }
  rt.news.sort((a, b) => b.at - a.at);
  rt.news = rt.news.slice(0, 200);
  rt.audit.record('system', 'news_refreshed', { feeds: feeds.length, fetched, errors: errors.length });
  rt.emit({ type: 'news', news: rt.news.slice(0, 100) });
  rt.persist();
  return { fetched, errors };
}
