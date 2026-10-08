// 协同设计库：versioned, immutable design files under <dataDir>/designs/<id>/v<n>.json plus an index
// (active version, enabled/disabled). The built-in 三省六部 lives in code, is read-only and runs on the
// native engine; its declarative description is what "复制" starts from.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, Tier } from '../../shared/types';
import {
  BUILTIN_DESIGN_ID, DEFAULT_RESILIENCE, DESIGN_SCHEMA, canonical, designBody, validateDesign,
  type CollabDesign, type DesignInfo, type DesignPin, type RoleSpec, type StepSpec,
} from '../../shared/design';
import { AGENT_MAP, MINISTRIES } from '../../shared/court';
import { SOULS, EXEC_OUTPUT_RULE } from './souls';
import type { Runtime } from './runtime';
import { now, sha256, uid } from './util';

interface IndexEntry { activeVersion: number; status: 'active' | 'disabled'; favorite?: boolean }
interface DesignIndex { designs: Record<string, IndexEntry> }

export const designHash = (d: CollabDesign) => sha256(canonical(designBody(d)));

const role = (id: AgentId, toolAccess: RoleSpec['toolAccess']): RoleSpec => ({
  id, name: AGENT_MAP[id].name, duty: AGENT_MAP[id].duty, prompt: SOULS[id], modelClass: AGENT_MAP[id].modelClass, toolAccess, avatar: id,
});

/** Declarative description of the built-in 三省六部 for a tier — the starting point of "复制为我的设计". */
export function builtinDeclarative(tier: 'lite' | 'full', s: Runtime['settings']): CollabDesign {
  const full = tier === 'full';
  const steps: StepSpec[] = [
    { id: 'plan', label: '中书规划', type: 'plan', phase: 'plan', role: 'zhongshu', executors: [...MINISTRIES], output: 'plan',
      instruction: full ? '档位：Full Court —— 子任务 2~6 个，充分利用六部并行，写清依赖。' : '档位：Court Lite —— 子任务控制在 1~3 个，避免仪式性步骤。' },
    { id: 'review', label: '门下审议', type: 'review', phase: 'review', role: 'menxia', output: 'verdict', onReject: { goto: 'plan', max: full ? s.maxRejections.full : s.maxRejections.lite },
      gate: (full ? s.planGate.full : s.planGate.lite) ? 'plan' : undefined,
      instruction: '请从可行性、完整性、风险、资源四个维度审议方案。' },
  ];
  if (full) steps.push({ id: 'dispatch', label: '尚书派发', type: 'agent', phase: 'dispatch', role: 'shangshu', output: 'text', inputs: ['plan'], instruction: '请为每个子任务写执行令，输出 JSON：{"orders":[{"subtaskId":"S1","instruction":"执行令"}],"note":"协调说明"}' });
  steps.push(
    { id: 'execute', label: '六部执行', type: 'fanout', phase: 'execute', planStep: 'plan', executors: [...MINISTRIES], output: 'conclusion', instruction: EXEC_OUTPUT_RULE },
    { id: 'summary', label: '尚书汇总回奏', type: 'summary', phase: 'report', role: 'shangshu', output: 'text', instruction: '请撰写回奏折（Markdown）。' },
  );
  if (full) steps.push({ id: 'result-review', label: '门下审议成果', type: 'review', phase: 'report', role: 'menxia', output: 'verdict', onReject: { goto: 'execute', max: s.maxRejections.full },
    instruction: '请核对实际改动（view_changes）与验收标准，审议成果。不合格则 reject 并在 rework 中列出需返工的子任务 id。' });
  const roles: RoleSpec[] = [role('zhongshu', 'read'), role('menxia', 'read'), role('shangshu', 'none'), ...MINISTRIES.map((m) => role(m, 'write'))];
  return {
    schema: DESIGN_SCHEMA, id: BUILTIN_DESIGN_ID, name: full ? '三省六部 · Full Court' : '三省六部 · Court Lite', version: 1,
    description: full ? '太子分拣 → 中书规划 → 门下审议（封驳返工）→ 尚书派发 → 六部并行执行 → 尚书回奏 → 门下审议成果 → 皇上御批' : '太子分拣 → 中书规划 → 门下审议 → 六部执行 → 尚书回奏 → 皇上御批',
    origin: { kind: 'builtin' }, roles, steps,
    policies: { tier, maxRejections: full ? s.maxRejections.full : s.maxRejections.lite, tokenBudget: 0, parallelism: 0, finalGate: s.finalGate, resilience: { ...DEFAULT_RESILIENCE } },
    createdAt: 0,
  };
}

export class DesignStore {
  private index: DesignIndex = { designs: {} };
  constructor(private rt: Runtime) {}

  get dir() {
    return path.join(this.rt.opts.dataDir, 'designs');
  }
  private get indexFile() {
    return path.join(this.dir, 'index.json');
  }

  load() {
    try {
      this.index = fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : { designs: {} };
      if (!this.index.designs) this.index = { designs: {} };
    } catch {
      // keep a copy of an unreadable index, start fresh (designs on disk are re-discovered)
      try {
        fs.copyFileSync(this.indexFile, `${this.indexFile}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.index = { designs: {} };
    }
    // re-discover design folders missing from the index
    if (fs.existsSync(this.dir)) {
      for (const id of fs.readdirSync(this.dir)) {
        if (id.startsWith('.') || this.index.designs[id] || !fs.statSync(path.join(this.dir, id)).isDirectory()) continue;
        const vs = this.versionsOf(id);
        if (vs.length) this.index.designs[id] = { activeVersion: vs.at(-1)!, status: 'active' };
      }
    }
  }

  private saveIndex() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2));
    fs.renameSync(tmp, this.indexFile);
  }

  private versionsOf(id: string): number[] {
    const d = path.join(this.dir, id);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  }

  private readVersion(id: string, v: number): CollabDesign | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, id, `v${v}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** A design version (default: the active one). The built-in returns its declarative description. */
  get(id: string, version?: number): CollabDesign | null {
    if (id === BUILTIN_DESIGN_ID) return { ...builtinDeclarative('full', this.rt.settings), native: true };
    const e = this.index.designs[id];
    if (!e) return null;
    return this.readVersion(id, version ?? e.activeVersion);
  }

  list(): DesignInfo[] {
    const b = this.get(BUILTIN_DESIGN_ID)!;
    const mine: DesignInfo[] = [];
    const out: DesignInfo[] = [{
      id: BUILTIN_DESIGN_ID, name: '三省六部（内置）', description: 'Solo / Court Lite / Full Court 三档；原生引擎执行，不可修改，可复制后自定义。', native: true, origin: { kind: 'builtin' },
      status: 'active', activeVersion: 1, latestVersion: 1, versions: [{ version: 1, hash: designHash(b), createdAt: 0 }], roles: b.roles.length, steps: b.steps.length,
    }];
    for (const [id, e] of Object.entries(this.index.designs)) {
      const vs = this.versionsOf(id);
      const cur = this.readVersion(id, e.activeVersion);
      if (!cur) continue;
      const versions = vs.map((v) => {
        const d = this.readVersion(id, v);
        return { version: v, hash: d ? designHash(d) : '', createdAt: d?.createdAt ?? 0, note: d?.note };
      });
      mine.push({
        id, name: cur.name, description: cur.description, native: false, origin: cur.origin, status: e.status, favorite: !!e.favorite, activeVersion: e.activeVersion, latestVersion: vs.at(-1) ?? e.activeVersion,
        versions, updatedAt: Math.max(0, ...versions.map((v) => v.createdAt)), roles: cur.roles.length, steps: cur.steps.length,
      });
    }
    // built-in first, then favourites, then the most recently changed
    mine.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return [...out, ...mine];
  }

  /** Save as a new immutable version (never overwrites). New design when `id` is absent/unknown. Activates the new version. */
  save(input: Omit<CollabDesign, 'version' | 'createdAt' | 'id'> & { id?: string }, note?: string): CollabDesign {
    if (input.id === BUILTIN_DESIGN_ID) throw new Error('内置三省六部不可修改：请先「复制为我的设计」');
    const v = validateDesign({ ...input, version: 1, createdAt: 0 });
    if (!v.ok) throw new Error(`协同设计无效：\n${v.errors.join('\n')}`);
    const isNew = !input.id || !this.index.designs[input.id];
    const id = isNew ? (input.id && /^[a-z0-9][a-z0-9-]{2,40}$/.test(input.id) && input.id !== BUILTIN_DESIGN_ID ? input.id : `d-${uid('').slice(-8)}`) : input.id!;
    const prev = isNew ? [] : this.versionsOf(id);
    const version = (prev.at(-1) ?? 0) + 1;
    const design: CollabDesign = { ...(input as CollabDesign), id, version, createdAt: now(), note: note?.slice(0, 200), native: undefined };
    const last = prev.length ? this.readVersion(id, prev.at(-1)!) : null;
    if (last && designHash(last) === designHash(design) && last.name === design.name && last.description === design.description && canonical(last.court ?? null) === canonical(design.court ?? null)) return last; // no-op save
    fs.mkdirSync(path.join(this.dir, id), { recursive: true });
    fs.writeFileSync(path.join(this.dir, id, `v${version}.json`), JSON.stringify(design, null, 2), { flag: 'wx' });
    this.index.designs[id] = { activeVersion: version, status: this.index.designs[id]?.status ?? 'active' };
    this.saveIndex();
    this.rt.audit.record('emperor', 'design_saved', { id, version, name: design.name, hash: designHash(design), origin: design.origin.kind, roles: design.roles.length, steps: design.steps.length, note: design.note ?? null });
    this.emit();
    return design;
  }

  /** Copy the built-in (as Lite or Full) or another design into a new editable design. */
  copy(fromId: string, opts: { tier?: 'lite' | 'full'; name?: string } = {}): CollabDesign {
    const src = fromId === BUILTIN_DESIGN_ID ? builtinDeclarative(opts.tier ?? 'full', this.rt.settings) : this.get(fromId);
    if (!src) throw new Error('要复制的协同设计不存在');
    const name = (opts.name || `${src.name.replace(/（内置）$/, '')} · 副本`).slice(0, 60);
    const { version: _v, createdAt: _c, native: _n, id: _id, ...rest } = src;
    void _v; void _c; void _n; void _id;
    const d = this.save({ ...rest, name, origin: { kind: 'copy', from: `${fromId}@${src.version}${fromId === BUILTIN_DESIGN_ID ? `:${opts.tier ?? 'full'}` : ''}` } }, `复制自 ${src.name}`);
    this.rt.audit.record('emperor', 'design_copied', { from: fromId, tier: opts.tier ?? null, to: d.id });
    return d;
  }

  /** Switch the active version (rollback = activating an older one). Running tasks keep their pinned version. */
  activate(id: string, version: number) {
    const e = this.index.designs[id];
    if (!e) throw new Error('协同设计不存在');
    if (!this.versionsOf(id).includes(version)) throw new Error(`版本 v${version} 不存在`);
    const from = e.activeVersion;
    e.activeVersion = version;
    this.saveIndex();
    this.rt.audit.record('emperor', 'design_activated', { id, from, to: version, rollback: version < from });
    this.emit();
  }

  /** 收藏 / 取消收藏 — favourites sort to the top of every design list */
  setFavorite(id: string, favorite: boolean) {
    if (id === BUILTIN_DESIGN_ID) throw new Error('内置三省六部始终排在最前，无需收藏');
    const e = this.index.designs[id];
    if (!e) throw new Error('协同设计不存在');
    e.favorite = favorite || undefined;
    this.saveIndex();
    this.emit();
  }

  /**
   * Delete a user design. Its folder moves to designs/.trash (recoverable by hand); edicts already
   * running keep their pinned snapshot, so nothing in flight is affected.
   */
  /** Moves the design to designs/.trash (kept, so it can be restored); returns the restore token. */
  remove(id: string): { token: string } {
    if (id === BUILTIN_DESIGN_ID) throw new Error('内置三省六部不可删除');
    const e = this.index.designs[id];
    if (!e) throw new Error('协同设计不存在');
    const name = this.readVersion(id, e.activeVersion)?.name ?? id;
    const trash = path.join(this.dir, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const token = `${id}-${Date.now()}`;
    const wasDefault = this.rt.settings.defaultDesign === id;
    const src = path.join(this.dir, id);
    if (fs.existsSync(src)) {
      fs.writeFileSync(path.join(src, 'entry.json'), JSON.stringify({ ...e, wasDefault }));
      fs.renameSync(src, path.join(trash, token));
    }
    delete this.index.designs[id];
    this.saveIndex();
    if (wasDefault) this.rt.updateSettings({ defaultDesign: BUILTIN_DESIGN_ID });
    this.rt.audit.record('emperor', 'design_deleted', { id, name, versions: e.activeVersion });
    this.emit();
    return { token };
  }

  /** Undo a remove(): move the folder back from the trash with its index entry (and default flag). */
  restore(token: string): string {
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)-(\d{10,})$/.exec(token);
    const from = m && path.join(this.dir, '.trash', token);
    if (!m || !from || !fs.existsSync(from)) throw new Error('找不到可恢复的设计');
    const id = m[1];
    if (this.index.designs[id] || fs.existsSync(path.join(this.dir, id))) throw new Error('已有同 id 的设计，无法恢复');
    let saved: IndexEntry & { wasDefault?: boolean } = { activeVersion: 0, status: 'active' };
    try {
      saved = JSON.parse(fs.readFileSync(path.join(from, 'entry.json'), 'utf8'));
      fs.unlinkSync(path.join(from, 'entry.json'));
    } catch {
      /* older trash folders have no entry file */
    }
    fs.renameSync(from, path.join(this.dir, id));
    const versions = this.versionsOf(id);
    if (!versions.length) throw new Error('恢复的设计没有可用版本');
    const { wasDefault, ...entry } = saved;
    this.index.designs[id] = { ...entry, activeVersion: versions.includes(entry.activeVersion) ? entry.activeVersion : versions[versions.length - 1] };
    this.saveIndex();
    if (wasDefault && entry.status === 'active') this.rt.updateSettings({ defaultDesign: id });
    this.rt.audit.record('emperor', 'design_restored', { id });
    this.emit();
    return id;
  }

  setStatus(id: string, status: 'active' | 'disabled') {
    if (id === BUILTIN_DESIGN_ID) throw new Error('内置三省六部不可停用');
    const e = this.index.designs[id];
    if (!e) throw new Error('协同设计不存在');
    e.status = status;
    this.saveIndex();
    if (status === 'disabled' && this.rt.settings.defaultDesign === id) this.rt.updateSettings({ defaultDesign: BUILTIN_DESIGN_ID });
    this.rt.audit.record('emperor', 'design_status', { id, status });
    this.emit();
  }

  /** Pin a design for a new task: version + hash, plus a frozen snapshot for non-native designs. */
  pin(id: string | undefined): { pin: DesignPin; spec?: CollabDesign } {
    const did = id || BUILTIN_DESIGN_ID;
    if (did === BUILTIN_DESIGN_ID) {
      const b = this.get(BUILTIN_DESIGN_ID)!;
      return { pin: { id: BUILTIN_DESIGN_ID, version: 1, hash: designHash(b), name: '三省六部（内置）', native: true } };
    }
    const e = this.index.designs[did];
    if (!e) throw new Error('所选协同设计不存在');
    if (e.status === 'disabled') throw new Error('所选协同设计已停用');
    const d = this.readVersion(did, e.activeVersion);
    if (!d) throw new Error('协同设计文件缺失或损坏');
    const v = validateDesign(d);
    if (!v.ok) throw new Error(`协同设计已损坏：${v.errors[0]}`);
    return { pin: { id: did, version: d.version, hash: designHash(d), name: d.name, native: false }, spec: JSON.parse(JSON.stringify(d)) };
  }

  emit() {
    this.rt.emit({ type: 'designs', designs: this.list() });
  }
}

/** Which tier a design runs as (budgets, labels). */
export function designTier(spec: CollabDesign | undefined, fallback: Tier): Tier {
  return spec?.policies.tier ?? fallback;
}
