// 技能 (2.0) — every official carries fixed 职责技能 (the job itself); extra skills
// are switched on per official. Also: the whole library (enable / edit / copy / restore / delete), update
// checks for skills added from a link, and the prompt an official actually receives.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getState, toast, useStore } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { askConfirm } from '../../common/Prompt';
import { AGENT_MAP } from '../../../shared/court';
import { SKILL_AGENTS } from '../../../shared/skills';
import type { AgentId, SkillInfo } from '../../../shared/types';
import { Toggle } from '../ui';
import './skills.css';

interface PackSkill { name: string; title: string; category: string; icon: string; duty: AgentId[]; version: number }
interface PackInfo { categories: Record<string, string>; builtins: PackSkill[] }
interface UpdateState { changed: boolean; edited: boolean; error?: string }
type View = { kind: 'agent'; id: AgentId } | { kind: 'all' } | { kind: 'updates' };
interface Draft { originalName?: string; name: string; description: string; agents: AgentId[] | 'all'; enabled: boolean; content: string; source: SkillInfo['source']; sourceUrl?: string; duty: AgentId[] }

/** court order: 三省, 吏户礼兵刑工, then 独相 */
const ORDER: AgentId[] = (['zhongshu', 'menxia', 'shangshu', 'libu_hr', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'solo'] as AgentId[]).filter((a) => SKILL_AGENTS.includes(a));
const RISK_LABEL: Record<NonNullable<SkillInfo['risk']>, string> = { release: '发版 · 需确认', deploy: '部署 · 需确认' };
const SOURCE_LABEL: Record<SkillInfo['source'], string> = { builtin: '内置', local: '自定义', remote: '来自链接' };
const CUSTOM = '_custom';
const NEW_BODY = '# 技能名称\n\n## 何时使用\n\n## 步骤\n1. \n\n## 验收\n';

// remembered while the app runs (switching settings pages keeps the place)
const mem: { view: View; cat: string; viewer: AgentId; autoChecked: boolean; updates: Record<string, UpdateState>; pack: PackInfo | null } = {
  view: { kind: 'agent', id: 'bingbu' }, cat: 'all', viewer: 'bingbu', autoChecked: false, updates: {}, pack: null,
};

const equipped = (s: SkillInfo, a: AgentId) => s.agents === 'all' || s.agents.includes(a);
const stripFrontmatter = (t: string) => t.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)?.[1] ?? t;
const tokensOf = (t: string) => Math.ceil(t.length / 2);
const slug = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9_\-一-龥]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const names = (ids: AgentId[]) => ids.map((a) => AGENT_MAP[a]?.name ?? a).join('、');

async function attempt<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (ok) toast(ok, 'success');
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

/** Everything the panes share: pack metadata lookups and the actions. */
interface Ctx {
  pack: PackInfo | null;
  icon: (s: SkillInfo) => string | undefined;
  title: (s: SkillInfo) => string;
  cat: (s: SkillInfo) => string | undefined;
  isPack: (name: string) => boolean;
  /** the skill just saved from the editor: shown first and flashed so it is easy to find */
  fresh: string | null;
  updates: Record<string, UpdateState>;
  checking: boolean;
  checkUpdates: () => void;
  update: (s: SkillInfo) => void;
  detail: (name: string) => void;
  edit: (s?: SkillInfo) => void;
  copy: (s: SkillInfo) => void;
  restore: (name: string, present: boolean) => void;
  remove: (s: SkillInfo) => void;
  equip: (s: SkillInfo, a: AgentId, on: boolean) => void;
  setDuty: (s: SkillInfo, duty: AgentId[]) => void;
  setEnabled: (s: SkillInfo, on: boolean) => void;
}

export function SkillsPage() {
  const skills = useStore((s) => s.skills);
  const [pack, setPack] = useState<PackInfo | null>(mem.pack);
  const [view, setViewState] = useState<View>(mem.view);
  const [cat, setCatState] = useState(mem.cat);
  const [q, setQ] = useState('');
  const [updates, setUpdatesState] = useState(mem.updates);
  const [checking, setChecking] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remoteForm, setRemoteForm] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  useEffect(() => {
    if (!mem.pack) void call<PackInfo>('skillPackInfo').then((p) => { mem.pack = p; setPack(p); }).catch(() => undefined);
  }, []);
  const setView = (v: View) => {
    mem.view = v;
    setViewState(v);
  };
  const setCat = (c: string) => {
    mem.cat = c;
    setCatState(c);
  };
  const setUpdates = (next: Record<string, UpdateState>) => {
    mem.updates = next;
    setUpdatesState(next);
  };

  const byName = useMemo(() => new Map((pack?.builtins ?? []).map((b) => [b.name, b])), [pack]);
  const remotes = skills.filter((s) => s.source === 'remote' && s.sourceUrl);

  const checkUpdates = async (quiet = false) => {
    if (!remotes.length) {
      if (!quiet) toast('没有从链接添加的技能需要检查；内置技能随 Edict 升级自动更新（你改过的除外）', 'info');
      return;
    }
    setChecking(true);
    const results = await Promise.all(
      remotes.map(async (s): Promise<[string, UpdateState]> => {
        try {
          const r = await call<{ changed: boolean; edited: boolean }>('skillCheckUpdate', s.name);
          return [s.name, { changed: r.changed, edited: r.edited }];
        } catch (e) {
          return [s.name, { changed: false, edited: false, error: (e as Error).message }];
        }
      }),
    );
    setChecking(false);
    setUpdates(Object.fromEntries(results));
    if (quiet) return;
    const n = results.filter(([, r]) => r.changed).length;
    const bad = results.filter(([, r]) => r.error).length;
    if (n) toast(`${n} 个技能有更新`, 'info');
    else if (bad) toast(`${bad} 个技能检查失败，链接可能暂时打不开`, 'warn');
    else toast('从链接添加的技能都是最新的', 'success');
  };
  // look for updates once per run when the page is first opened
  useEffect(() => {
    if (mem.autoChecked || !remotes.length) return;
    mem.autoChecked = true;
    void checkUpdates(true);
  }, [remotes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx = {
    pack,
    icon: (s) => s.icon || byName.get(s.name)?.icon,
    title: (s) => s.title || byName.get(s.name)?.title || s.name,
    cat: (s) => (s.category ? pack?.categories[s.category] ?? s.category : undefined),
    isPack: (n) => byName.has(n),
    fresh,
    updates,
    checking,
    checkUpdates: () => void checkUpdates(),
    update: async (s) => {
      if (updates[s.name]?.edited && !(await askConfirm(`更新「${ctx.title(s)}」？`, '你改过这个技能的内容。更新会用链接上的新版本覆盖你的修改，配给谁保持不变。', { ok: '覆盖并更新', danger: true }))) return;
      const r = await attempt(call('skillUpdateRemote', s.name).then(() => true), `已更新：${s.name}`);
      if (r) setUpdates({ ...mem.updates, [s.name]: { changed: false, edited: false } });
    },
    detail: (n) => setDetail(n),
    edit: async (s) => {
      if (!s) {
        setDraft({ name: '', description: '', agents: view.kind === 'agent' ? [view.id] : [], enabled: true, content: NEW_BODY, source: 'local', duty: [] });
        return;
      }
      const text = await attempt(call<string>('skillRead', s.name));
      if (text === undefined) return;
      setDetail(null);
      setDraft({ originalName: s.name, name: s.name, description: s.description, agents: s.agents, enabled: s.enabled, content: stripFrontmatter(text), source: s.source, sourceUrl: s.sourceUrl, duty: s.duty });
    },
    copy: async (s) => {
      const n = await attempt(call<string>('skillDuplicate', s.name));
      if (!n) return;
      toast(`已复制为 ${n}（默认停用，改好后再启用）`, 'success');
      const copy = getState().skills.find((x) => x.name === n);
      const text = await attempt(call<string>('skillRead', n));
      if (text === undefined) return;
      setDetail(null);
      setDraft({ originalName: n, name: n, description: copy?.description ?? s.description, agents: copy?.agents ?? s.agents, enabled: false, content: stripFrontmatter(text), source: 'local', duty: [] });
    },
    restore: async (n, present) => {
      const b = byName.get(n);
      if (present && !(await askConfirm(`恢复内置技能「${b?.title ?? n}」？`, '会用内置版本覆盖现在的内容；除了职责官员，另配的官员需要重新打开。', { ok: '恢复内置' }))) return;
      await attempt(call('skillRestoreBuiltin', n), `已恢复内置技能：${b?.title ?? n}`);
    },
    remove: async (s) => {
      const builtin = byName.has(s.name);
      if (!(await askConfirm(`删除技能「${ctx.title(s)}」？`, builtin ? '内置技能删除后不会自动回来，可以在「全部技能」底部恢复。' : '技能文件会被删除，无法撤销。', { ok: '删除', danger: true }))) return;
      if ((await attempt(call('skillRemove', s.name).then(() => true), `已删除：${s.name}`)) && detail === s.name) setDetail(null);
    },
    equip: (s, a, on) => void attempt(call('skillEquip', s.name, a, on)),
    setDuty: (s, duty) => void attempt(call('skillSetDuty', s.name, duty)),
    setEnabled: (s, on) => void attempt(call('skillSetEnabled', s.name, on)),
  };

  const importFolder = async () => {
    const n = await attempt(call<string | null>('skillImportFolder'));
    if (!n) return;
    toast(`已导入技能：${n}（已配给全体官员，可在详情里调整）`, 'success');
    setDetail(n);
  };

  const query = q.trim().toLowerCase();
  const match = (s: SkillInfo) => !query || `${s.name} ${ctx.title(s)} ${s.description}`.toLowerCase().includes(query);
  const updCount = Object.entries(updates).filter(([n, u]) => u.changed && skills.some((s) => s.name === n)).length;
  const counts = (a: AgentId) => ({
    duty: skills.filter((s) => s.enabled && s.duty.includes(a)).length,
    extra: skills.filter((s) => s.enabled && !s.duty.includes(a) && equipped(s, a)).length,
  });
  const navItem = (key: string, on: boolean, onClick: () => void, children: ReactNode, testid?: string) => (
    <button key={key} className={`skp-i ${on ? 'on' : ''}`} onClick={onClick} data-testid={testid}>{children}</button>
  );

  return (
    <div className="skp" data-testid="skills-center">
      <div className="skp-body">
        <aside className="skp-side">
          <label className="sn-search">
            <Icon name="search" size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索技能" onKeyDown={(e) => e.key === 'Escape' && setQ('')} data-testid="skills-search" />
            {q && <button className="icon-btn" onClick={() => setQ('')} aria-label="清空"><Icon name="x" size={12} /></button>}
          </label>
          <div className="skp-g">按官员配备</div>
          {ORDER.map((a) => {
            const c = counts(a);
            return navItem(a, view.kind === 'agent' && view.id === a, () => setView({ kind: 'agent', id: a }), (
              <>
                <span className="e">{AGENT_MAP[a].emoji}</span>
                <span className="ellipsis">{AGENT_MAP[a].name}</span>
                <span className="c" {...tip(`${AGENT_MAP[a].name}：职责 ${c.duty} · 另配 ${c.extra}`, '职责技能随官职而来；另配的技能由你按官员打开')}>
                  {c.duty}{c.extra > 0 && <span className="x"> · {c.extra}</span>}
                </span>
              </>
            ), `skills-agent-${a}`);
          })}
          <div className="skp-g">技能库</div>
          {navItem('all', view.kind === 'all', () => setView({ kind: 'all' }), (<><Icon name="grid" size={14} /> 全部技能<span className="c">{skills.length}</span></>), 'skills-all')}
          {navItem('upd', view.kind === 'updates', () => setView({ kind: 'updates' }), (<><Icon name="refresh" size={14} /> 有更新<span className={`c ${updCount ? 'blue' : ''}`}>{updCount}</span></>), 'skills-updates')}
          <div className="skp-g">添加技能</div>
          {navItem('new', false, () => ctx.edit(), (<><Icon name="plus" size={14} /> 新建技能</>), 'skills-new')}
          {navItem('dir', false, () => void importFolder(), (<><Icon name="folder" size={14} /> 从文件夹导入…</>), 'skills-import')}
          {navItem('url', false, () => setRemoteForm(true), (<><Icon name="link" size={14} /> 从链接添加…</>), 'skills-remote')}
        </aside>

        <div className="skp-main">
          {view.kind === 'agent' && <AgentPane key={view.id} agent={view.id} skills={skills} ctx={ctx} match={match} cat={cat} setCat={setCat} />}
          {view.kind === 'all' && <AllPane skills={skills} ctx={ctx} match={match} cat={cat} setCat={setCat} />}
          {view.kind === 'updates' && <UpdatesPane skills={remotes.filter(match)} total={remotes.length} ctx={ctx} onAdd={() => setRemoteForm(true)} />}
        </div>
      </div>

      {detail && <SkillDetail name={detail} skills={skills} ctx={ctx} onClose={() => setDetail(null)} />}
      {draft && <SkillEditor draft={draft} setDraft={setDraft} onClose={() => setDraft(null)} onSaved={(n) => { setDraft(null); setFresh(n); }} />}
      {remoteForm && <RemoteForm defaultAgents={view.kind === 'agent' ? [view.id] : []} onClose={() => setRemoteForm(false)} onDone={(n) => { setRemoteForm(false); setDetail(n); }} />}
    </div>
  );
}

// ───────────────────────── panes ─────────────────────────

function sortSkills(list: SkillInfo[], ctx: Ctx) {
  const order = Object.keys(ctx.pack?.categories ?? {});
  const rank = (s: SkillInfo) => (s.category && order.includes(s.category) ? order.indexOf(s.category) : order.length);
  return [...list].sort((a, b) => rank(a) - rank(b) || ctx.title(a).localeCompare(ctx.title(b), 'zh'));
}

function CatChips({ list, ctx, cat, setCat }: { list: SkillInfo[]; ctx: Ctx; cat: string; setCat: (c: string) => void }) {
  const present = new Set(list.map((s) => s.category ?? CUSTOM));
  const cats = [...Object.keys(ctx.pack?.categories ?? {}).filter((c) => present.has(c)), ...(present.has(CUSTOM) ? [CUSTOM] : [])];
  const cur = cat === 'all' || cats.includes(cat) ? cat : 'all';
  return (
    <div className="skp-chips" role="tablist" aria-label="按类别筛选">
      {['all', ...cats].map((c) => (
        <button key={c} role="tab" aria-selected={cur === c} className={`fchip ${cur === c ? 'on' : ''}`} onClick={() => setCat(c)}>
          {c === 'all' ? '全部' : c === CUSTOM ? '自定义' : ctx.pack?.categories[c] ?? c}
        </button>
      ))}
    </div>
  );
}
const inCat = (s: SkillInfo, cat: string) => cat === 'all' || (cat === CUSTOM ? !s.category : s.category === cat);

function CheckBtn({ ctx }: { ctx: Ctx }) {
  return (
    <button className="btn sm" onClick={ctx.checkUpdates} disabled={ctx.checking} {...tip('检查更新', '向来源链接核对从链接添加的技能；内置技能随 Edict 升级自动更新')}>
      <Icon name="refresh" size={12} /> {ctx.checking ? '检查中…' : '检查更新'}
    </button>
  );
}

function AgentPane({ agent, skills, ctx, match, cat, setCat }: { agent: AgentId; skills: SkillInfo[]; ctx: Ctx; match: (s: SkillInfo) => boolean; cat: string; setCat: (c: string) => void }) {
  const a = AGENT_MAP[agent];
  // equipped skills first, as they were when this official was opened — cards don't jump while toggling
  const [first] = useState(() => new Set(skills.filter((s) => s.enabled && !s.duty.includes(agent) && equipped(s, agent)).map((s) => s.name)));
  const rank = (s: SkillInfo) => (s.name === ctx.fresh ? 2 : first.has(s.name) ? 1 : 0);
  const pool = sortSkills(skills.filter((s) => s.enabled && !s.duty.includes(agent)), ctx).sort((x, y) => rank(y) - rank(x));
  const searched = pool.filter(match);
  const shown = searched.filter((s) => inCat(s, cat));
  const on = pool.filter((s) => equipped(s, agent)).length;
  const disabled = skills.filter((s) => !s.enabled && !s.duty.includes(agent)).length;
  return (
    <div className="skp-pane" data-testid={`skills-pane-${agent}`}>
      <div className="skp-head">
        <h2><span className="emo">{a.emoji}</span>{a.name}的技能</h2>
        <span className="muted small ellipsis duty-t">{a.duty}</span>
        <span className="grow" />
        <CheckBtn ctx={ctx} />
      </div>
      <DutyBox key={`duty-${agent}`} agent={agent} skills={skills} ctx={ctx} />
      <div className="skp-lane">
        <b>另配技能</b>
        <span className="muted">· 打开开关就配给{a.name}；其他官员不受影响</span>
        <span className="grow" />
        <span className="muted small nowrap">已配 {on} / {pool.length}</span>
      </div>
      <CatChips list={searched} ctx={ctx} cat={cat} setCat={setCat} />
      {shown.length ? (
        <div className="skx-grid">
          {shown.map((s) => (
            <ExtCard key={s.name} s={s} ctx={ctx} on={equipped(s, agent)} accent onToggle={(v) => ctx.equip(s, agent, v)} toggleLabel={`配给${a.name}`} />
          ))}
        </div>
      ) : (
        <div className="sp-empty">{pool.length ? '没有符合条件的技能。' : '所有技能都已是它的职责技能。'}</div>
      )}
      <div className="muted small skp-foot">
        内置 {ctx.pack?.builtins.length ?? '…'} 个技能，默认都不配备；配上的技能会出现在官员的提示里，官员用到时才加载全文，并记在奏折「所用技能」里。
        {disabled > 0 && <> {disabled} 个技能已停用，不在这里显示，可在「全部技能」中重新启用。</>}
      </div>
      <AgentViewer key={`view-${agent}`} fixed={agent} />
    </div>
  );
}

function DutyBox({ agent, skills, ctx }: { agent: AgentId; skills: SkillInfo[]; ctx: Ctx }) {
  const name = AGENT_MAP[agent].name;
  const duty = sortSkills(skills.filter((s) => s.duty.includes(agent)), ctx);
  // while adjusting, rows stay put even after this official is unticked (so a slip is easy to undo)
  const [rows, setRows] = useState<string[] | null>(null);
  const addable = sortSkills(skills.filter((s) => !s.duty.includes(agent) && !rows?.includes(s.name)), ctx);
  return (
    <div className="skp-duty" data-testid="skills-duty">
      <div className="h">
        <Icon name="lock" size={13} />
        <b>职责技能</b>
        <span className="muted">· {name}的本职，始终带着，不用另配</span>
        <span className="grow" />
        <button className="link" onClick={() => setRows(rows ? null : duty.map((s) => s.name))} data-testid="skills-duty-adjust" {...tip(rows ? '完成调整' : '调整职责技能', '改由哪些官员负责这些技能；一般不需要动')}>
          {rows ? '完成' : '调整'}
        </button>
      </div>
      {!rows && (duty.length ? (
        <div className="chips">
          {duty.map((s) => (
            <button key={s.name} className={`dchip ${s.enabled ? '' : 'off'}`} onClick={() => ctx.detail(s.name)} {...tip(ctx.title(s), s.enabled ? `随${name}的官职而来，始终带着，不能单独卸下；要改由谁负责，点右侧「调整」。` : '已停用：在「全部技能」里重新启用后才会生效。')}>
              <Icon name="lock" size={10} className="lk" />
              <SkillGlyph s={s} ctx={ctx} small />
              {ctx.title(s)}
              <span className="mono muted">{s.name}</span>
              {!s.enabled && <span className="muted">· 已停用</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="muted small">{name}没有职责技能。</div>
      ))}
      {rows && (
        <div className="skp-adj">
          {rows.map((n) => {
            const s = skills.find((x) => x.name === n);
            if (!s) return null;
            return (
              <div className="adj-row" key={n}>
                <span className="adj-nm"><SkillGlyph s={s} ctx={ctx} small /> {ctx.title(s)} <span className="mono muted">{n}</span></span>
                <OfficialChips value={s.duty} onToggle={(a, v) => ctx.setDuty(s, v ? [...s.duty, a] : s.duty.filter((x) => x !== a))} highlight={agent} />
              </div>
            );
          })}
          <div className="adj-add">
            <select className="input sm" value="" onChange={(e) => {
              const s = skills.find((x) => x.name === e.target.value);
              if (!s) return;
              ctx.setDuty(s, [...s.duty, agent]);
              setRows([...rows, s.name]);
            }}>
              <option value="">＋ 再设一项为{name}的职责技能…</option>
              {addable.map((s) => <option key={s.name} value={s.name}>{ctx.title(s)}（{s.name}）</option>)}
            </select>
            <span className="muted small">点官员名切换：亮起的官员把它当作本职，始终带着。</span>
          </div>
        </div>
      )}
    </div>
  );
}

function AllPane({ skills, ctx, match, cat, setCat }: { skills: SkillInfo[]; ctx: Ctx; match: (s: SkillInfo) => boolean; cat: string; setCat: (c: string) => void }) {
  const searched = sortSkills(skills.filter(match), ctx).sort((x, y) => Number(y.name === ctx.fresh) - Number(x.name === ctx.fresh));
  const shown = searched.filter((s) => inCat(s, cat));
  const deleted = (ctx.pack?.builtins ?? []).filter((b) => !skills.some((s) => s.name === b.name));
  return (
    <div className="skp-pane" data-testid="skills-pane-all">
      <div className="skp-head">
        <h2><Icon name="grid" size={17} /> 全部技能</h2>
        <span className="muted small">{skills.length} 个 · 启用 {skills.filter((s) => s.enabled).length} 个</span>
        <span className="grow" />
        <CheckBtn ctx={ctx} />
      </div>
      <div className="muted small skp-note">这里的开关是「启用」：停用后所有官员都看不到它，也无法加载。配给哪位官员，在左侧选官员后打开，或点「详情」。</div>
      <CatChips list={searched} ctx={ctx} cat={cat} setCat={setCat} />
      {shown.length ? (
        <div className="skx-grid">
          {shown.map((s) => (
            <ExtCard
              key={s.name}
              s={s}
              ctx={ctx}
              on={s.enabled}
              onToggle={(v) => ctx.setEnabled(s, v)}
              toggleLabel="启用"
              holders
              actions={
                <>
                  <button className="icon-btn sm" onClick={() => ctx.edit(s)} {...tip('编辑', '改名称、描述、配给谁和 SKILL.md 正文')} data-testid={`skill-edit-${s.name}`}><Icon name="edit" size={13} /></button>
                  <button className="icon-btn sm" onClick={() => ctx.copy(s)} {...tip('复制', '复制一份（默认停用）再改')}><Icon name="copy" size={13} /></button>
                  {ctx.isPack(s.name) && s.source !== 'builtin' && (
                    <button className="icon-btn sm" onClick={() => ctx.restore(s.name, true)} {...tip('恢复内置', '丢掉你的修改，回到内置版本')}><Icon name="undo" size={13} /></button>
                  )}
                  <button className="icon-btn sm danger" onClick={() => ctx.remove(s)} {...tip('删除')}><Icon name="trash" size={13} /></button>
                </>
              }
            />
          ))}
        </div>
      ) : (
        <div className="sp-empty">没有符合条件的技能。</div>
      )}
      {deleted.length > 0 && (
        <div className="skp-deleted">
          <span className="muted small">已删除的内置技能：</span>
          {deleted.map((b) => (
            <button key={b.name} className="dchip" onClick={() => ctx.restore(b.name, false)} {...tip(`恢复「${b.title}」`, '放回技能库；除职责官员外不配给任何人')}>
              <span className="glyph sm">{b.icon}</span> {b.title} <span className="muted">恢复</span>
            </button>
          ))}
        </div>
      )}
      <AgentViewer />
    </div>
  );
}

function UpdatesPane({ skills, total, ctx, onAdd }: { skills: SkillInfo[]; total: number; ctx: Ctx; onAdd: () => void }) {
  const sorted = [...skills].sort((a, b) => Number(!!ctx.updates[b.name]?.changed) - Number(!!ctx.updates[a.name]?.changed) || a.name.localeCompare(b.name));
  return (
    <div className="skp-pane" data-testid="skills-pane-updates">
      <div className="skp-head">
        <h2><Icon name="refresh" size={17} /> 有更新</h2>
        <span className="muted small">只检查从链接添加的技能；内置技能随 Edict 升级自动更新（你改过的除外）</span>
        <span className="grow" />
        <CheckBtn ctx={ctx} />
      </div>
      {!total ? (
        <div className="sp-empty skp-empty">
          还没有从链接添加的技能。<button className="link" onClick={onAdd}>从链接添加…</button>
        </div>
      ) : sorted.length ? (
        <div className="skx-grid">
          {sorted.map((s) => <ExtCard key={s.name} s={s} ctx={ctx} on={s.enabled} onToggle={(v) => ctx.setEnabled(s, v)} toggleLabel="启用" status />)}
        </div>
      ) : (
        <div className="sp-empty">没有符合条件的技能。</div>
      )}
    </div>
  );
}

// ───────────────────────── pieces ─────────────────────────

function SkillGlyph({ s, ctx, small, big }: { s: SkillInfo; ctx: Ctx; small?: boolean; big?: boolean }) {
  const e = ctx.icon(s);
  return <span className={`glyph ${small ? 'sm' : ''} ${big ? 'big' : ''}`}>{e ?? <Icon name="puzzle" size={small ? 12 : big ? 20 : 16} />}</span>;
}

function Tags({ s, ctx, withSource = true }: { s: SkillInfo; ctx: Ctx; withSource?: boolean }) {
  const c = ctx.cat(s);
  return (
    <>
      {c && <span className="tag">{c}</span>}
      {withSource && s.source !== 'builtin' && <span className="tag">{SOURCE_LABEL[s.source]}</span>}
      {s.risk && <span className="tag risk" {...tip(RISK_LABEL[s.risk], '推送、发布、部署等高风险操作每次都会请你确认，除非本工作区的权限设置已永久允许')}>{RISK_LABEL[s.risk]}</span>}
    </>
  );
}

/** accent: outline the card while it is on (equipped); the library views only show it on the switch. */
function ExtCard({ s, ctx, on, accent, onToggle, toggleLabel, holders, actions, status }: { s: SkillInfo; ctx: Ctx; on: boolean; accent?: boolean; onToggle: (v: boolean) => void; toggleLabel: string; holders?: boolean; actions?: ReactNode; status?: boolean }) {
  const title = ctx.title(s);
  const upd = ctx.updates[s.name];
  const extra = s.agents === 'all' ? '全体官员' : names(s.agents.filter((a) => !s.duty.includes(a)));
  const isFresh = ctx.fresh === s.name;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFresh) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isFresh]);
  return (
    <div ref={ref} className={`skx ${accent && on ? 'on' : ''} ${s.enabled ? '' : 'disabled'} ${isFresh ? 'fresh' : ''}`} data-testid={`skill-card-${s.name}`}>
      <div className="h">
        <SkillGlyph s={s} ctx={ctx} />
        <button className="nm" onClick={() => ctx.detail(s.name)}>
          <b className="ellipsis">{title}</b>
          <span className="mono muted ellipsis">{title !== s.name ? s.name : SOURCE_LABEL[s.source]}</span>
        </button>
        <Toggle on={on} onChange={onToggle} label={`${toggleLabel}：${title}`} testid={`skill-toggle-${s.name}`} />
      </div>
      <div className="ds" title={s.description}>{s.description || '（没有描述）'}</div>
      {holders && (
        <div className="who ellipsis" title={`职责：${names(s.duty) || '无'}；另配：${extra || '无'}`}>
          {s.duty.length > 0 && <span><Icon name="lock" size={10} /> {names(s.duty)}</span>}
          {extra && <span className="ex">另配 {extra}</span>}
          {!s.duty.length && !extra && <span className="muted">还没配给任何官员</span>}
        </div>
      )}
      {status && (
        <div className="who">
          {ctx.checking && !upd ? <span className="muted">检查中…</span>
            : !upd ? <span className="muted">尚未检查</span>
            : upd.error ? <span className="err ellipsis" title={upd.error}>检查失败：{upd.error}</span>
            : upd.changed ? <span className="upd-t">链接上有新版本{upd.edited ? '（你改过本地内容）' : ''}</span>
            : <span className="ok-t">已是最新</span>}
        </div>
      )}
      <div className="ft">
        <Tags s={s} ctx={ctx} />
        {upd?.changed && (
          <>
            <span className="tag upd">有更新</span>
            <button className="link strong" onClick={() => ctx.update(s)} data-testid={`skill-update-${s.name}`}>更新</button>
          </>
        )}
        <span className="grow" />
        {actions}
        <button className="link" onClick={() => ctx.detail(s.name)}>详情</button>
      </div>
    </div>
  );
}

function OfficialChips({ value, onToggle, highlight, disabledFor, disabledNote }: { value: AgentId[] | 'all'; onToggle: (a: AgentId, on: boolean) => void; highlight?: AgentId; disabledFor?: AgentId[]; disabledNote?: string }) {
  return (
    <span className="ochips">
      {ORDER.map((a) => {
        const on = value === 'all' || value.includes(a);
        const locked = disabledFor?.includes(a);
        return (
          <button
            key={a}
            type="button"
            className={`ochip ${on || locked ? 'on' : ''} ${locked ? 'locked' : ''} ${highlight === a ? 'hl' : ''}`}
            aria-pressed={on}
            disabled={locked}
            onClick={() => onToggle(a, !on)}
            {...(locked && disabledNote ? tip(AGENT_MAP[a].name, disabledNote) : {})}
          >
            <span>{AGENT_MAP[a].emoji}</span>{AGENT_MAP[a].name}{locked && <Icon name="lock" size={9} />}
          </button>
        );
      })}
    </span>
  );
}

function Modal({ title, onClose, children, wide, testid }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; testid?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // an in-app confirm on top handles its own Escape
      if (e.key === 'Escape' && document.querySelectorAll('.modal-backdrop').length <= 1) onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop skp-backdrop" onMouseDown={onClose}>
      <div className={`skp-modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" data-testid={testid}>
        <div className="skp-modal-h">
          <b>{title}</b>
          <span className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SkillDetail({ name, skills, ctx, onClose }: { name: string; skills: SkillInfo[]; ctx: Ctx; onClose: () => void }) {
  const s = skills.find((x) => x.name === name);
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    void call<string>('skillRead', name).then((t) => setBody(stripFrontmatter(t).trim())).catch(() => setBody(''));
  }, [name, s?.sha256]);
  if (!s) return null;
  const upd = ctx.updates[s.name];
  return (
    <Modal title="技能详情" onClose={onClose} wide testid="skill-detail">
      <div className="skd-head">
        <SkillGlyph s={s} ctx={ctx} big />
        <div className="skd-t">
          <h3>{ctx.title(s)}</h3>
          <span className="mono muted">{s.name}</span>
        </div>
        <span className="grow" />
        <span className="muted small">{s.enabled ? '已启用' : '已停用'}</span>
        <Toggle on={s.enabled} onChange={(v) => ctx.setEnabled(s, v)} label="启用" />
      </div>
      <div className="skd-tags">
        <span className="tag">{SOURCE_LABEL[s.source]}{s.version ? ` · 第 ${s.version} 版` : ''}</span>
        <Tags s={s} ctx={ctx} withSource={false} />
        {upd?.changed && <span className="tag upd">有更新</span>}
      </div>
      <p className="skd-desc">{s.description || '（没有描述）'}</p>
      {s.sourceUrl && <div className="muted small skd-src">来源：<span className="mono">{s.sourceUrl}</span></div>}
      <div className="skd-sec">
        <div className="k"><Icon name="lock" size={12} /> 职责 <span className="muted">· 随官职而来，始终带着</span></div>
        <OfficialChips value={s.duty} onToggle={(a, v) => ctx.setDuty(s, v ? [...s.duty, a] : s.duty.filter((x) => x !== a))} />
      </div>
      <div className="skd-sec">
        <div className="k"><Icon name="puzzle" size={12} /> 另配 <span className="muted">· 按官员单独开关</span></div>
        <OfficialChips value={s.agents === 'all' ? 'all' : s.agents.filter((a) => !s.duty.includes(a))} onToggle={(a, v) => ctx.equip(s, a, v)} disabledFor={s.duty} disabledNote="已是职责技能，始终带着" />
      </div>
      {!s.enabled && <div className="warnbox"><Icon name="alert" size={13} /><span>已停用：所有官员都看不到它，打开右上角开关后才生效。</span></div>}
      <div className="skd-body">
        <div className="k">SKILL.md <span className="muted">· 约 {tokensOf(body ?? '')} tokens，官员调用 load_skill 时才进入上下文</span></div>
        <pre data-testid="skill-detail-body">{body ?? '加载中…'}</pre>
      </div>
      <div className="skd-actions">
        {upd?.changed && <button className="btn sm" onClick={() => ctx.update(s)}><Icon name="refresh" size={12} /> 更新</button>}
        {ctx.isPack(s.name) && s.source !== 'builtin' && <button className="btn sm" onClick={() => ctx.restore(s.name, true)}><Icon name="undo" size={12} /> 恢复内置</button>}
        <button className="btn sm" onClick={() => ctx.copy(s)}><Icon name="copy" size={12} /> 复制</button>
        <button className="btn sm danger" onClick={() => ctx.remove(s)}><Icon name="trash" size={12} /> 删除</button>
        <span className="grow" />
        <button className="btn sm primary" onClick={() => ctx.edit(s)} data-testid="skill-detail-edit"><Icon name="edit" size={12} /> 编辑</button>
      </div>
    </Modal>
  );
}

function AgentsPick({ value, onChange }: { value: AgentId[] | 'all'; onChange: (v: AgentId[] | 'all') => void }) {
  const all = value === 'all';
  return (
    <div className="skp-pick">
      <button type="button" className={`ochip ${all ? 'on' : ''}`} onClick={() => onChange(all ? [] : 'all')} aria-pressed={all}>全体官员</button>
      <OfficialChips value={value} onToggle={(a, on) => onChange(all ? ORDER.filter((x) => x !== a) : on ? [...value, a] : value.filter((x) => x !== a))} />
    </div>
  );
}

function SkillEditor({ draft, setDraft, onClose, onSaved }: { draft: Draft; setDraft: (d: Draft) => void; onClose: () => void; onSaved: (name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!draft.name.trim()) return toast('请填写技能名称', 'warn');
    if (!draft.description.trim()) return toast('请填写一句话描述（官员据此判断何时加载）', 'warn');
    setBusy(true);
    const name = await attempt(call<string>('skillSave', { name: draft.name, description: draft.description, agents: draft.agents, content: draft.content, enabled: draft.enabled, originalName: draft.originalName }));
    setBusy(false);
    if (!name) return;
    toast(`技能已保存：${name}`, 'success');
    onSaved(name);
  };
  const isNew = !draft.originalName;
  return (
    <Modal title={isNew ? '新建技能' : `编辑技能 · ${draft.originalName}`} onClose={onClose} wide testid="skill-editor">
      {draft.source === 'builtin' && <div className="warnbox"><Icon name="alert" size={13} /><span>内置技能：保存修改后变成你自己的版本，不再随内置包升级；随时可以「恢复内置」。</span></div>}
      {draft.sourceUrl && <div className="muted small">来源：<span className="mono">{draft.sourceUrl}</span>（改过之后，「更新」会提示覆盖你的修改）</div>}
      <div className="form-grid skp-form">
        <label>名称</label>
        <input className="input mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如 html-qa（小写字母、数字、- _）" autoFocus={isNew} data-testid="skill-name" />
        <label>一句话描述</label>
        <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="官员据此判断何时加载本技能" data-testid="skill-desc" />
        <label>另配给</label>
        <AgentsPick value={draft.agents} onChange={(agents) => setDraft({ ...draft, agents })} />
        {draft.duty.length > 0 && (
          <>
            <label>职责</label>
            <span className="small muted"><Icon name="lock" size={11} /> {names(draft.duty)}（在「详情」里调整）</span>
          </>
        )}
        <label>启用</label>
        <span className="row-gap small">
          <Toggle on={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="启用" />
          <span className="muted">{draft.enabled ? '已启用' : '停用后所有官员都看不到，也无法加载'}</span>
        </span>
      </div>
      <textarea className="input mono skill-body" rows={15} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} spellCheck={false} data-testid="skill-body" />
      <div className="skd-actions">
        <span className="muted small">约 {tokensOf(draft.content)} tokens（加载时计入上下文）· 官员提示里只放名称和一句话描述</span>
        <span className="grow" />
        <button className="btn sm" onClick={onClose}>取消</button>
        <button className="btn sm primary" onClick={save} disabled={busy} data-testid="skill-save">{busy ? '保存中…' : '保存技能'}</button>
      </div>
    </Modal>
  );
}

function RemoteForm({ defaultAgents, onClose, onDone }: { defaultAgents: AgentId[]; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<AgentId[] | 'all'>(defaultAgents);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim() || !url.trim()) return toast('请填写名称与链接', 'warn');
    if (!/^https:\/\//.test(url.trim())) return toast('只支持 https:// 链接', 'warn');
    setBusy(true);
    const ok = await attempt(call('skillAddRemote', { name, url: url.trim(), description: desc, agents }).then(() => true), '已下载并保存技能');
    setBusy(false);
    if (ok) onDone(slug(name));
  };
  return (
    <Modal title="从链接添加技能" onClose={onClose} wide testid="skill-remote">
      <div className="form-grid skp-form">
        <label>链接</label>
        <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/SKILL.md" autoFocus data-testid="skill-remote-url" />
        <label>名称</label>
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 api-design" data-testid="skill-remote-name" />
        <label>一句话描述</label>
        <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="官员据此判断何时加载本技能" />
        <label>另配给</label>
        <AgentsPick value={agents} onChange={setAgents} />
      </div>
      <div className="muted small">只会向你填写的这个链接发一次请求；内容原样保存到本地，之后可以编辑。「检查更新」时再去核对链接上的版本。</div>
      <div className="skd-actions">
        <span className="grow" />
        <button className="btn sm" onClick={onClose}>取消</button>
        <button className="btn sm primary" onClick={save} disabled={busy}>{busy ? '下载中…' : '下载并保存'}</button>
      </div>
    </Modal>
  );
}

/** The system prompt an official really gets (duty + skill index) and its MCP tools. */
function AgentViewer({ fixed }: { fixed?: AgentId }) {
  const [pick, setPick] = useState<AgentId>(mem.viewer);
  const agent = fixed ?? pick;
  const [open, setOpen] = useState(!fixed);
  const [view, setView] = useState<{ system: string; mcpTools: string[] } | null>(null);
  const skills = useStore((s) => s.skills);
  const mcp = useStore((s) => s.mcp);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void call<{ system: string; mcpTools: string[] }>('skillAgentView', agent).then((v) => alive && setView(v)).catch(() => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [agent, open, skills, mcp]);
  const a = AGENT_MAP[agent];
  return (
    <section className="sp-sec skp-viewer" data-testid="skills-agent-view">
      <div className="sp-sec-h">
        <Icon name="eye" size={14} />
        <b>{fixed ? `${a.name}实际获得的能力` : '官员实际获得的能力'}</b>
        {!fixed && (
          <select className="input sm" value={agent} onChange={(e) => { mem.viewer = e.target.value as AgentId; setPick(e.target.value as AgentId); }} data-testid="skills-agent-view-pick">
            {ORDER.map((id) => <option key={id} value={id}>{AGENT_MAP[id].emoji} {AGENT_MAP[id].name}</option>)}
          </select>
        )}
        <span className="muted">· 系统提示里的职责与技能索引；技能全文只在调用 load_skill 时才进入上下文</span>
        <span className="sp-sec-r">{fixed && <button className="link" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</button>}</span>
      </div>
      {open && (
        <>
          <pre className="skp-pre">{view?.system ?? '加载中…'}</pre>
          <div className="skp-mcp">
            <span className="muted small">MCP 工具（{view?.mcpTools.length ?? 0}）</span>
            {view?.mcpTools.length ? view.mcpTools.map((t) => <code key={t}>{t}</code>) : <span className="muted small">无</span>}
          </div>
        </>
      )}
    </section>
  );
}
