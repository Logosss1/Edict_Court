// Skills (技能配置) and news (天下要闻) services.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, SkillInfo } from '../../shared/types';
import type { Runtime } from './runtime';
import { BUILTIN_SKILLS } from './defaults';
import { now, uid } from './util';

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

export function loadSkills(rt: Runtime) {
  const dir = skillsDir(rt);
  fs.mkdirSync(dir, { recursive: true });
  // seed builtin skills once (a builtin the emperor deleted stays deleted)
  const removed = readRemoved(rt);
  for (const b of BUILTIN_SKILLS) {
    const p = path.join(dir, b.name, 'SKILL.md');
    if (!fs.existsSync(p) && !removed.includes(b.name)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `---\nname: ${b.name}\ndescription: ${b.description}\nagents: ${b.agents === 'all' ? 'all' : b.agents.join(',')}\nsource: builtin\n---\n${b.content}\n`);
    }
  }
  const out: SkillInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const { meta } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
    out.push({
      name: meta.name || name,
      description: meta.description || '',
      agents: !meta.agents || meta.agents === 'all' ? 'all' : (meta.agents.split(',').map((s) => s.trim()) as AgentId[]),
      path: p,
      source: (meta.source as SkillInfo['source']) || 'local',
      sourceUrl: meta.sourceUrl,
      enabled: meta.enabled !== 'false',
    });
  }
  rt.skills = out.sort((a, b) => a.name.localeCompare(b.name));
  rt.emit({ type: 'skills', skills: rt.skills });
}

export function readSkill(rt: Runtime, name: string): string {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  return fs.readFileSync(s.path, 'utf8');
}

export function skillSlug(n: string) {
  return n.trim().toLowerCase().replace(/[^a-z0-9_\-一-龥]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

export function saveSkill(rt: Runtime, o: { name: string; description: string; agents: AgentId[] | 'all'; content: string; source?: 'local' | 'remote'; sourceUrl?: string; enabled?: boolean; originalName?: string }) {
  const name = skillSlug(o.name);
  if (!name) throw new Error('技能名称无效');
  if (o.originalName && o.originalName !== name && rt.skills.some((s) => s.name === name)) throw new Error(`已存在同名技能：${name}`);
  const dir = path.join(skillsDir(rt), name);
  fs.mkdirSync(dir, { recursive: true });
  const body = parseFrontmatter(o.content).body.replace(/\s+$/, '');
  if (body.length > 200_000) throw new Error('技能正文过长（>200KB）');
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${o.description.replace(/\n/g, ' ')}\nagents: ${o.agents === 'all' ? 'all' : o.agents.join(',')}\nsource: ${o.source ?? 'local'}\n${o.sourceUrl ? `sourceUrl: ${o.sourceUrl}\n` : ''}${o.enabled === false ? 'enabled: false\n' : ''}---\n${body}\n`,
  );
  if (o.originalName && o.originalName !== name) {
    const old = rt.skills.find((s) => s.name === o.originalName);
    if (old) fs.rmSync(path.dirname(old.path), { recursive: true, force: true });
  }
  rt.audit.record('emperor', 'skill_saved', { name, agents: o.agents, source: o.source ?? 'local', sourceUrl: o.sourceUrl, enabled: o.enabled !== false, renamedFrom: o.originalName !== name ? o.originalName : undefined });
  loadSkills(rt);
  return name;
}

export function setSkillEnabled(rt: Runtime, name: string, enabled: boolean) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  const text = fs.readFileSync(s.path, 'utf8');
  const { body } = parseFrontmatter(text);
  saveSkill(rt, { name, description: s.description, agents: s.agents, content: body, source: s.source === 'builtin' ? 'local' : s.source, sourceUrl: s.sourceUrl, enabled });
}

export function duplicateSkill(rt: Runtime, name: string) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) throw new Error('技能不存在');
  let n = `${name}-copy`;
  for (let i = 2; rt.skills.some((x) => x.name === n); i++) n = `${name}-copy${i}`;
  return saveSkill(rt, { name: n, description: s.description, agents: s.agents, content: parseFrontmatter(fs.readFileSync(s.path, 'utf8')).body, enabled: false });
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

export async function addRemoteSkill(rt: Runtime, o: { name: string; url: string; description: string; agents: AgentId[] | 'all' }) {
  if (!/^https:\/\//.test(o.url)) throw new Error('仅支持 https 链接');
  const res = await rt.opts.fetchImpl(o.url, { method: 'GET', headers: { accept: 'text/plain, text/markdown, */*' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 200_000) throw new Error('技能文件过大');
  saveSkill(rt, { ...o, content: text, source: 'remote', sourceUrl: o.url });
}

export function removeSkill(rt: Runtime, name: string) {
  const s = rt.skills.find((x) => x.name === name);
  if (!s) return;
  fs.rmSync(path.dirname(s.path), { recursive: true, force: true });
  if (BUILTIN_SKILLS.some((b) => b.name === name)) fs.writeFileSync(removedFile(rt), [...new Set([...readRemoved(rt), name])].join('\n'));
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
