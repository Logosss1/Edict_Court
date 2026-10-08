// 协同设计 — the collaboration designs library: built-in 三省六部 (read-only) and user designs with
// versions, rollback, enable/disable, copy, "default for new edicts", and the editor (flow canvas,
// forms, court layout) for user designs.
import { useEffect, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENT_MAP } from '../../shared/court';
import { BUILTIN_DESIGN_ID, PHASE_LABEL, type CollabDesign, type DesignInfo, type DesignPhase } from '../../shared/design';
import { fmtTime } from '../common/format';
import { DesignEditor } from './designs/DesignEditor';
import { blankDesign, type Draft } from './designs/edit';
import { clearStash, readStash, type StashedDraft } from './designs/draftState';
import { askConfirm } from '../common/Prompt';
import { tip } from '../common/Tip';

const TIER_LABEL = { lite: '精简版', full: '完整版' } as const;

const ORIGIN: Record<string, string> = { builtin: '内置', user: '自建', copy: '复制来的', github: 'GitHub 导入' };
const STEP_TYPE: Record<string, string> = { agent: '单人执行', plan: '规划拆解', review: '审议（可封驳）', fanout: '分派执行', summary: '汇总', gate: '皇上关卡' };
const PHASES: DesignPhase[] = ['plan', 'review', 'dispatch', 'execute', 'report', 'confirm'];

export function Designs() {
  const designs = useStore((s) => s.designs);
  const defaultId = useStore((s) => s.settings.defaultDesign) ?? BUILTIN_DESIGN_ID;
  const [sel, setSel] = useState<string>(designs[0]?.id ?? BUILTIN_DESIGN_ID);
  const [version, setVersion] = useState<number | null>(null);
  const [spec, setSpec] = useState<CollabDesign | null>(null);
  const [json, setJson] = useState(false);
  const [editing, setEditing] = useState<{ draft: Draft; court?: boolean; resume?: { draft: Draft; note: string } } | null>(null);
  const [stash, setStash] = useState<StashedDraft | null>(() => readStash());
  const [more, setMore] = useState(false);
  const info = designs.find((d) => d.id === sel) ?? designs[0];
  useEffect(() => {
    if (!info) return;
    void call<CollabDesign | null>('designGet', info.id, version ?? undefined).then(setSpec);
  }, [info?.id, info?.activeVersion, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMore(false), [info?.id]);

  /** 修改: user designs open as-is; the built-in opens as an unsaved copy (saved only when you save) */
  const edit = async (d: DesignInfo, opts: { tier?: 'lite' | 'full'; court?: boolean } = {}) => {
    try {
      if (d.native) {
        const tier = opts.tier ?? 'full';
        const t = await call<CollabDesign>('designTemplate', tier);
        const { version: _v, createdAt: _c, ...body } = t;
        void _v; void _c;
        setEditing({ draft: { ...body, id: '', name: `三省六部 · ${TIER_LABEL[tier]} · 我的版本`, origin: { kind: 'copy', from: `${BUILTIN_DESIGN_ID}@1:${tier}` } }, court: opts.court });
        return;
      }
      const cur = d.id === info?.id && spec?.id === d.id ? spec : await call<CollabDesign | null>('designGet', d.id);
      if (cur) setEditing({ draft: cur, court: opts.court });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const duplicate = async (d: DesignInfo) => {
    const cur = await call<CollabDesign | null>('designGet', d.id);
    if (!cur) return;
    const { version: v, createdAt: _c, ...body } = cur;
    void _c;
    setEditing({ draft: { ...body, id: '', name: `${cur.name} · 副本`.slice(0, 60), origin: { kind: 'copy', from: `${d.id}@${v}` } } });
  };
  const favorite = (d: DesignInfo) => call('designSetFavorite', d.id, !d.favorite).catch((e) => toast((e as Error).message, 'error'));
  const remove = async (d: DesignInfo) => {
    const ok = await askConfirm(`删除「${d.name}」？`, `共 ${d.versions.length} 个版本会一起删除。正在按它执行的旨意不受影响。${d.id === defaultId ? '它是当前默认设计，删除后默认改回三省六部。' : ''}`, { ok: '删除', danger: true });
    if (!ok) return;
    try {
      const { token } = await call<{ token: string }>('designDelete', d.id);
      toast(`已删除「${d.name}」`, 'success', {
        label: '撤销',
        run: () => call<string>('designRestore', token).then((id) => { setSel(id); toast(`已恢复「${d.name}」`, 'success'); }, (e) => toast((e as Error).message, 'error')),
      });
      if (sel === d.id) setSel(BUILTIN_DESIGN_ID);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const setDefault = (d: DesignInfo) => call('updateSettings', { defaultDesign: d.id }).then(() => toast(`新下的旨意将按「${d.native ? '三省六部' : d.name}」办理`, 'success'));

  if (editing) {
    return (
      <div className="panel designs-panel editing" data-testid="designs-panel">
        <DesignEditor key={editing.draft.id || `new-${editing.draft.name}`} initial={editing.draft} resume={editing.resume} startWithCourt={editing.court} onClose={() => { setEditing(null); setStash(readStash()); }} onSaved={(id) => { setEditing(null); setStash(readStash()); setSel(id); setVersion(null); }} />
      </div>
    );
  }
  if (!info) return <div className="panel muted pad">加载中…</div>;
  const viewing = version ?? info.activeVersion;
  const mineCount = designs.filter((d) => !d.native).length;
  return (
    <div className="panel split-panel designs-panel" data-testid="designs-panel">
      <div className="split-list">
        <div className="panel-head"><h2><Icon name="layers" size={18} /> 协同设计</h2><span style={{ flex: 1 }} /><button className="btn sm primary" onClick={() => setEditing({ draft: blankDesign() as Draft })} data-testid="design-new"><Icon name="plus" size={12} /> 新建</button></div>
        <p className="muted small pad">决定一道旨意由哪些 AI 角色、按什么步骤协作完成。下旨时选用；修改或回滚不影响已在执行的旨意。</p>
        {stash && (
          <div className="design-stash" data-testid="design-stash">
            <span>有一份没保存的修改：<b>{stash.draft.name || '未命名设计'}</b><div className="muted small">自动保存于 {fmtTime(stash.at)}</div></span>
            <span className="row-gap">
              <button className="btn sm primary" onClick={() => { setEditing({ draft: stash.base, resume: { draft: stash.draft, note: stash.note } }); setStash(null); }} data-testid="design-stash-resume">继续编辑</button>
              <button className="btn sm" onClick={async () => { if (await askConfirm('丢弃这份修改？', `「${stash.draft.name || '未命名设计'}」里没保存的改动会被丢弃。`, { ok: '丢弃', danger: true })) { clearStash(); setStash(null); } }} data-testid="design-stash-drop">丢弃</button>
            </span>
          </div>
        )}
        {designs.map((d) => (
          <div key={d.id} className={`list-item design-row ${sel === d.id ? 'on' : ''} ${d.status === 'disabled' ? 'off' : ''}`} onClick={() => { setSel(d.id); setVersion(null); }} data-testid={`design-item-${d.id}`}>
            <div className="row-gap">
              {d.native ? (
                <span className="dr-star fixed" {...tip('内置', '默认的协作流程，始终在最前，不能删除')}><Icon name="shield" size={13} /></span>
              ) : (
                <button className={`dr-star ${d.favorite ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); void favorite(d); }} {...tip(d.favorite ? '取消收藏' : '收藏', '收藏的设计排在前面，下旨时也更好找')} data-testid={`design-fav-${d.id}`}>{d.favorite ? '★' : '☆'}</button>
              )}
              <b className="ellipsis">{d.native ? '三省六部（内置）' : d.name}</b>
              {d.id === defaultId && <span className="chip chip-sm on" {...tip('默认', '新下的旨意默认按这套办')}>默认</span>}
              {d.status === 'disabled' && <span className="chip chip-sm">已停用</span>}
              <span style={{ flex: 1 }} />
              <span className="dr-actions">
                <button className="icon-btn" onClick={(e) => { e.stopPropagation(); void edit(d); }} {...tip(d.native ? '复制后修改' : '修改', d.native ? '内置流程不能直接改，会先复制一份给你改' : '打开编辑器修改流程、角色和朝堂站位')} data-testid={`design-row-edit-${d.id}`}><Icon name="edit" size={13} /></button>
                {!d.native && <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); void remove(d); }} {...tip('删除', '连同所有版本一起删除')} data-testid={`design-row-del-${d.id}`}><Icon name="trash" size={13} /></button>}
              </span>
            </div>
            <div className="muted small dr-sub">{d.native ? '精简版 / 完整版 两档 · 9 个角色' : `v${d.activeVersion}${d.latestVersion !== d.activeVersion ? `（最新 v${d.latestVersion}）` : ''} · ${d.roles} 个角色 · ${d.steps} 步 · ${ORIGIN[d.origin.kind] ?? d.origin.kind}`}</div>
          </div>
        ))}
        {mineCount === 0 && (
          <div className="design-empty" data-testid="design-empty">
            <b>还没有自己的协作流程</b>
            <span className="muted small">点「新建」从空白开始，或点三省六部右边的 ✎ 复制一份再改。</span>
          </div>
        )}
      </div>
      <div className="split-detail">
        <div className="card">
          <div className="row-gap wrap">
            <h3>{info.native ? '三省六部（内置）' : info.name}</h3>
            {info.native && <span className="chip chip-sm" {...tip('只读', '内置流程由原生引擎执行，不能直接修改，可复制后修改')}>只读</span>}
            <span style={{ flex: 1 }} />
            {info.id !== defaultId && info.status === 'active' && <button className="btn sm" onClick={() => setDefault(info)} data-testid="design-set-default">设为默认</button>}
            {info.native ? (
              <>
                <button className="btn sm" onClick={() => edit(info, { tier: 'lite' })} {...tip('复制精简版后修改', '规划 → 审议 → 执行 → 回奏，步骤少、省 token')} data-testid="design-copy-lite"><Icon name="copy" size={12} /> 复制精简版修改</button>
                <button className="btn sm primary" onClick={() => edit(info, { tier: 'full' })} {...tip('复制完整版后修改', '含尚书派发与成果审议的完整流程')} data-testid="design-copy-full"><Icon name="edit" size={12} /> 复制完整版修改</button>
              </>
            ) : (
              <>
                <button className="btn sm primary" disabled={!spec || spec.id !== info.id} onClick={() => spec && setEditing({ draft: spec })} data-testid="design-edit"><Icon name="edit" size={12} /> {viewing === info.activeVersion ? '修改' : `基于 v${viewing} 修改`}</button>
                <span className="more-wrap">
                  <button className="btn sm" onClick={() => setMore(!more)} data-testid="design-more">更多 ▾</button>
                  {more && (
                    <div className="more-menu" onMouseLeave={() => setMore(false)}>
                      <button onClick={() => { setMore(false); void favorite(info); }}>{info.favorite ? '☆ 取消收藏' : '★ 收藏'}</button>
                      <button onClick={() => { setMore(false); void duplicate(info); }}><Icon name="copy" size={12} /> 复制一份</button>
                      <button onClick={() => { setMore(false); call('designSetStatus', info.id, info.status === 'active' ? 'disabled' : 'active').catch((e) => toast(e.message, 'error')); }} data-testid="design-toggle">{info.status === 'active' ? '停用（下旨时不再列出）' : '重新启用'}</button>
                      <button className="danger" onClick={() => { setMore(false); void remove(info); }} data-testid="design-delete"><Icon name="trash" size={12} /> 删除</button>
                    </div>
                  )}
                </span>
              </>
            )}
          </div>
          <p className="muted">{info.native ? '太子分拣 → 中书规划 → 门下审议（可封驳）→ 尚书派发 → 六部执行 → 尚书回奏 → 皇上御批。' : info.description || '（没有说明）'}</p>
          {info.native && (
            <div className="design-versions">
              <span className="muted small">下旨时可选精简版或完整版。</span>
              <span style={{ flex: 1 }} />
              <button className="link small corner-link" onClick={() => edit(info, { tier: 'full', court: true })} {...tip('朝堂站位', '内置流程的站位不能直接改，会先复制完整版再打开站位')} data-testid="design-court-link"><Icon name="crown" size={11} /> 朝堂站位</button>
            </div>
          )}
          {!info.native && (
            <div className="design-versions">
              <span className="muted small">版本：</span>
              {info.versions.map((v) => (
                <span key={v.version} className={`chip chip-sm ver ${v.version === viewing ? 'on' : ''}`} onClick={() => setVersion(v.version)} title={`${fmtTime(v.createdAt)}${v.note ? ` · ${v.note}` : ''}`}>
                  v{v.version}{v.version === info.activeVersion ? ' · 使用中' : ''}
                </span>
              ))}
              {viewing !== info.activeVersion && (
                <button className="btn sm primary" onClick={() => call('designActivate', info.id, viewing).then(() => { toast(`已切换到 v${viewing}（进行中的旨意不受影响）`, 'success'); setVersion(null); })} data-testid="design-activate">
                  {viewing < info.activeVersion ? `回滚到 v${viewing}` : `启用 v${viewing}`}
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="link small corner-link" onClick={() => edit(info, { court: true })} {...tip('朝堂站位', '这套设计的角色在像素朝堂里站哪、做什么（只影响画面）')} data-testid="design-court-link"><Icon name="crown" size={11} /> 朝堂站位</button>
            </div>
          )}
        </div>
        {spec && (
          <>
            <div className="card">
              <div className="row-gap"><h4>流程</h4><span style={{ flex: 1 }} /><button className="link small" onClick={() => setJson(!json)}>{json ? '看流程' : '看 JSON'}</button></div>
              {json ? (
                <pre className="skill-content">{JSON.stringify(spec, null, 2)}</pre>
              ) : (
                <div className="design-flow" data-testid="design-flow">
                  {PHASES.filter((p) => spec.steps.some((s) => s.phase === p)).map((p) => (
                    <div key={p} className="df-phase">
                      <div className="df-phase-h">{PHASE_LABEL[p]}</div>
                      {spec.steps.filter((s) => s.phase === p).map((s) => {
                        const r = spec.roles.find((x) => x.id === s.role);
                        return (
                          <div key={s.id} className={`df-step t-${s.type}`}>
                            <b>{s.label}</b>
                            <div className="muted small">{STEP_TYPE[s.type]}{s.parallel ? ' · 与上一步并行' : ''}{s.optional ? ' · 可选' : ''}</div>
                            {r && <div className="small">{AGENT_MAP[r.avatar]?.emoji} {r.name}</div>}
                            {s.type === 'fanout' && <div className="small">执行：{(s.executors ?? []).map((id) => spec.roles.find((x) => x.id === id)?.name ?? id).join('、')}</div>}
                            {s.onReject && <div className="small df-loop">↺ 封驳回到「{spec.steps.find((x) => x.id === s.onReject!.goto)?.label}」，上限 {s.onReject.max} 次</div>}
                            {s.gate && <div className="small df-gate">⚑ {s.gate === 'plan' ? '方案御览' : '御批'}</div>}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {spec.policies.finalGate && <div className="df-phase"><div className="df-phase-h">结案</div><div className="df-step t-gate"><b>皇上御批</b><div className="muted small">准奏结案 / 封驳返工</div></div></div>}
                </div>
              )}
            </div>
            <div className="card">
              <h4>角色（{spec.roles.length}）</h4>
              <table className="table small">
                <thead><tr><th>角色</th><th>职责</th><th>模型档</th><th>工具权限</th><th>朝堂形象</th></tr></thead>
                <tbody>
                  {spec.roles.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.name}</b> <code className="muted">{r.id}</code></td>
                      <td>{r.duty}</td>
                      <td>{r.modelClass === 'strong' ? '强' : '经济'}</td>
                      <td>{{ none: '无', read: '只读', write: '读写（受权限模式约束）' }[r.toolAccess]}</td>
                      <td>{AGENT_MAP[r.avatar]?.emoji} {AGENT_MAP[r.avatar]?.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted small">
                预算：{spec.policies.tokenBudget || '按档位默认'} · 封驳上限 {spec.policies.maxRejections} · 并行度 {spec.policies.parallelism || '全局设置'}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
