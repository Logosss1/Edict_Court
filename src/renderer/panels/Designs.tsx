// 协同设计 — the collaboration designs library: built-in 三省六部 (read-only) and user designs with
// versions, rollback, enable/disable, copy and "default for new edicts". (Editing UI: Phase 2.)
import { useEffect, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENT_MAP } from '../../shared/court';
import { BUILTIN_DESIGN_ID, PHASE_LABEL, type CollabDesign, type DesignPhase } from '../../shared/design';
import { fmtTime } from '../common/format';

const ORIGIN: Record<string, string> = { builtin: '内置', user: '自建', copy: '复制', github: 'GitHub 导入' };
const STEP_TYPE: Record<string, string> = { agent: '单人执行', plan: '规划拆解', review: '审议（可封驳）', fanout: '分派执行', summary: '汇总', gate: '皇上关卡' };
const PHASES: DesignPhase[] = ['plan', 'review', 'dispatch', 'execute', 'report', 'confirm'];

export function Designs() {
  const designs = useStore((s) => s.designs);
  const defaultId = useStore((s) => s.settings.defaultDesign) ?? BUILTIN_DESIGN_ID;
  const [sel, setSel] = useState<string>(designs[0]?.id ?? BUILTIN_DESIGN_ID);
  const [version, setVersion] = useState<number | null>(null);
  const [spec, setSpec] = useState<CollabDesign | null>(null);
  const [json, setJson] = useState(false);
  const info = designs.find((d) => d.id === sel) ?? designs[0];
  useEffect(() => {
    if (!info) return;
    void call<CollabDesign | null>('designGet', info.id, version ?? undefined).then(setSpec);
  }, [info?.id, info?.activeVersion, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (tier?: 'lite' | 'full') => {
    try {
      const d = await call<CollabDesign>('designCopy', info!.id, tier ? { tier } : {});
      toast(`已复制为「${d.name}」`, 'success');
      setSel(d.id);
      setVersion(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (!info) return <div className="panel muted pad">加载中…</div>;
  const viewing = version ?? info.activeVersion;
  return (
    <div className="panel split-panel designs-panel" data-testid="designs-panel">
      <div className="split-list">
        <div className="panel-head"><h2><Icon name="layers" size={18} /> 协同设计</h2></div>
        <p className="muted small pad">一套「谁参与、按什么步骤、怎么评审与返工」的协作逻辑。下旨时选择使用哪一套；切换或回滚不影响已经在跑的旨意。</p>
        {designs.map((d) => (
          <div key={d.id} className={`list-item ${sel === d.id ? 'on' : ''} ${d.status === 'disabled' ? 'off' : ''}`} onClick={() => { setSel(d.id); setVersion(null); }} data-testid={`design-item-${d.id}`}>
            <div className="row-gap">
              <b className="ellipsis">{d.name}</b>
              {d.native && <Icon name="shield" size={12} />}
              <span className="chip chip-sm">{ORIGIN[d.origin.kind] ?? d.origin.kind}</span>
              {d.id === defaultId && <span className="chip chip-sm">默认</span>}
            </div>
            <div className="muted small">v{d.activeVersion}{d.latestVersion !== d.activeVersion ? `（最新 v${d.latestVersion}）` : ''} · {d.roles} 个角色 · {d.steps} 步{d.status === 'disabled' ? ' · 已停用' : ''}</div>
          </div>
        ))}
      </div>
      <div className="split-detail">
        <div className="card">
          <div className="row-gap wrap">
            <h3>{info.name}</h3>
            {info.native && <span className="chip chip-sm" title="内置设计由原生引擎执行，不可修改">只读 · 原生引擎</span>}
            <span style={{ flex: 1 }} />
            {info.id !== defaultId && info.status === 'active' && <button className="btn sm" onClick={() => call('updateSettings', { defaultDesign: info.id }).then(() => toast('已设为新旨意的默认协同设计', 'success'))} data-testid="design-set-default">设为默认</button>}
            {info.native ? (
              <>
                <button className="btn sm" onClick={() => copy('lite')} data-testid="design-copy-lite"><Icon name="copy" size={12} /> 复制 Court Lite</button>
                <button className="btn sm primary" onClick={() => copy('full')} data-testid="design-copy-full"><Icon name="copy" size={12} /> 复制 Full Court</button>
              </>
            ) : (
              <>
                <button className="btn sm" onClick={() => copy()}><Icon name="copy" size={12} /> 复制</button>
                <button className="btn sm" onClick={() => call('designSetStatus', info.id, info.status === 'active' ? 'disabled' : 'active').catch((e) => toast(e.message, 'error'))} data-testid="design-toggle">{info.status === 'active' ? '停用' : '启用'}</button>
              </>
            )}
          </div>
          <p className="muted">{info.description}</p>
          {info.origin.from && <div className="muted small">来源：{info.origin.from}{info.origin.url ? ` · ${info.origin.url}` : ''}</div>}
          {!info.native && (
            <div className="design-versions">
              <span className="muted small">版本：</span>
              {info.versions.map((v) => (
                <span key={v.version} className={`chip chip-sm ver ${v.version === viewing ? 'on' : ''}`} onClick={() => setVersion(v.version)} title={`${fmtTime(v.createdAt)} · ${v.note ?? ''} · ${v.hash.slice(0, 12)}`}>
                  v{v.version}{v.version === info.activeVersion ? ' · 使用中' : ''}
                </span>
              ))}
              {viewing !== info.activeVersion && (
                <button className="btn sm primary" onClick={() => call('designActivate', info.id, viewing).then(() => { toast(`已切换到 v${viewing}（进行中的旨意不受影响）`, 'success'); setVersion(null); })} data-testid="design-activate">
                  {viewing < info.activeVersion ? `回滚到 v${viewing}` : `启用 v${viewing}`}
                </button>
              )}
            </div>
          )}
          {info.native && <div className="notice small">内置三省六部按 Solo / Court Lite / Full Court 三档运行（在下旨框选择）。下方展示的是 Full Court 的声明式描述；复制后即可在自己的设计里增删角色与步骤。</div>}
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
