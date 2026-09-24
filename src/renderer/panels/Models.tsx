// 模型配置 — providers (multi-protocol), routing, per-agent hot switch, runtime policy.
import { useEffect, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENTS } from '../../shared/court';
import type { ModelInfo, ModelRef, PermissionMode, ProviderConfig, Protocol, Settings } from '../../shared/types';

interface Preset { id: string; name: string; protocol: Protocol; baseUrl: string; replayReasoning?: boolean; hint: string }

const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: 'openai-chat', label: 'OpenAI Chat Completions' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
];

export function Models() {
  const providers = useStore((s) => s.providers);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [sel, setSel] = useState<string | null>(providers[0]?.id ?? null);
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [info, setInfo] = useState<{ dataDir: string; encrypted: boolean; permissionLabels: Record<string, string> } | null>(null);
  useEffect(() => {
    call<Preset[]>('presets').then(setPresets);
    call('info').then(setInfo);
  }, []);
  useEffect(() => {
    const p = providers.find((x) => x.id === sel);
    if (p) setDraft(JSON.parse(JSON.stringify(p)));
  }, [sel, providers]);

  const addFromPreset = (pid: string) => {
    const pr = presets.find((p) => p.id === pid);
    if (!pr) return;
    setSel(null);
    setDraft({ id: '', name: pr.name, preset: pr.id, protocol: pr.protocol, baseUrl: pr.baseUrl, models: [], hasKey: false, replayReasoning: !!pr.replayReasoning, enabled: true });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2><Icon name="cpu" size={18} /> 模型配置</h2>
        <span className="muted small">兼容 OpenAI 协议 · Anthropic Messages · OpenAI Responses；base_url / API Key / 模型 id 均由你填写</span>
      </div>
      <div className="models-layout">
        <div className="card provider-list">
          <h3>模型服务</h3>
          {providers.map((p) => (
            <div key={p.id} className={`list-item ${sel === p.id ? 'on' : ''}`} onClick={() => setSel(p.id)}>
              <b>{p.name}</b> {!p.enabled && <span className="chip chip-sm">停用</span>}
              <div className="muted small">{PROTOCOLS.find((x) => x.id === p.protocol)?.label} · {p.models.length} 个模型 · {p.hasKey ? '🔑 已存 Key' : '无 Key'}</div>
            </div>
          ))}
          <select className="input" value="" onChange={(e) => addFromPreset(e.target.value)} data-testid="add-provider">
            <option value="">＋ 添加模型服务（选择预设）…</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {presets.length > 0 && draft && !draft.id && <p className="muted small">{presets.find((p) => p.id === draft.preset)?.hint}</p>}
        </div>
        {draft ? <ProviderEditor key={draft.id || 'new'} draft={draft} setDraft={setDraft} onSaved={(id) => setSel(id)} /> : <div className="card muted pad">选择或添加一个模型服务</div>}
      </div>
      <Routing />
      <AgentModels />
      <Policy info={info} />
    </div>
  );
}

function ProviderEditor({ draft, setDraft, onSaved }: { draft: ProviderConfig; setDraft: (p: ProviderConfig) => void; onSaved: (id: string) => void }) {
  const [key, setKey] = useState('');
  const [testModel, setTestModel] = useState(draft.models[0]?.id ?? '');
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ProviderConfig>) => setDraft({ ...draft, ...patch });
  const setModel = (i: number, patch: Partial<ModelInfo>) => set({ models: draft.models.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  const save = async () => {
    if (!draft.baseUrl.trim()) return toast('请填写 base_url', 'warn');
    if (!draft.models.length) return toast('请至少添加一个模型 id', 'warn');
    try {
      const saved = await call<ProviderConfig>('upsertProvider', draft, key ? key : undefined);
      setKey('');
      toast('已保存（API Key 已加密存储，不会出现在日志中）', 'success');
      onSaved(saved.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const test = async () => {
    if (!draft.id) return toast('请先保存', 'warn');
    setBusy(true);
    setTestMsg('测试中…');
    const r = await call<{ ok: boolean; message: string; latencyMs: number }>('testProvider', draft.id, testModel);
    setTestMsg(`${r.ok ? '✅' : '❌'} ${r.message}（${r.latencyMs}ms）`);
    setBusy(false);
  };
  const fetchModels = async () => {
    if (!draft.id) return toast('请先保存', 'warn');
    try {
      const ids = await call<string[]>('fetchModels', draft.id);
      const existing = new Set(draft.models.map((m) => m.id));
      set({ models: [...draft.models, ...ids.filter((i) => !existing.has(i)).slice(0, 40).map((id) => ({ id, inputPrice: 0, outputPrice: 0, contextWindow: 128000 }))] });
      toast(`获取到 ${ids.length} 个模型（请保存）`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card provider-editor" data-testid="provider-editor">
      <div className="form-grid">
        <label>名称</label>
        <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        <label>协议</label>
        <select className="input" value={draft.protocol} onChange={(e) => set({ protocol: e.target.value as Protocol })}>
          {PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <label>base_url</label>
        <input className="input" value={draft.baseUrl} placeholder="https://your-endpoint/v1" onChange={(e) => set({ baseUrl: e.target.value })} data-testid="provider-baseurl" />
        <label>API Key</label>
        <input className="input" type="password" value={key} placeholder={draft.hasKey ? '已加密保存（留空则不变）' : '填写你的 API Key（本机模型可留空）'} onChange={(e) => setKey(e.target.value)} autoComplete="off" data-testid="provider-key" />
        <label>选项</label>
        <div className="row-gap">
          <label className="chk small"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 启用</label>
          <label className="chk small" title="DeepSeek / Kimi 等思考模式在工具调用后需回传 reasoning_content"><input type="checkbox" checked={!!draft.replayReasoning} onChange={(e) => set({ replayReasoning: e.target.checked })} /> 回传思考内容</label>
          {draft.hasKey && <button className="link small" onClick={async () => { await call('upsertProvider', draft, ''); toast('已删除 Key', 'success'); }}>删除已存 Key</button>}
        </div>
      </div>
      <h4>模型（价格单位：美元 / 百万 tokens，用于费用统计与预估；未知可填 0）</h4>
      <table className="table small models-table">
        <thead><tr><th>模型 id</th><th>显示名</th><th>输入价</th><th>输出价</th><th>缓存价</th><th>上下文</th><th /></tr></thead>
        <tbody>
          {draft.models.map((m, i) => (
            <tr key={i}>
              <td><input className="input" value={m.id} placeholder="模型 id" onChange={(e) => setModel(i, { id: e.target.value })} data-testid="model-id" /></td>
              <td><input className="input" value={m.label ?? ''} onChange={(e) => setModel(i, { label: e.target.value })} /></td>
              <td><input className="input num" type="number" step="0.01" value={m.inputPrice} onChange={(e) => setModel(i, { inputPrice: +e.target.value })} /></td>
              <td><input className="input num" type="number" step="0.01" value={m.outputPrice} onChange={(e) => setModel(i, { outputPrice: +e.target.value })} /></td>
              <td><input className="input num" type="number" step="0.01" value={m.cachedInputPrice ?? ''} placeholder="同输入" onChange={(e) => setModel(i, { cachedInputPrice: e.target.value === '' ? undefined : +e.target.value })} /></td>
              <td><input className="input num" type="number" value={m.contextWindow} onChange={(e) => setModel(i, { contextWindow: +e.target.value })} /></td>
              <td><button className="icon-btn" onClick={() => set({ models: draft.models.filter((_, k) => k !== i) })}><Icon name="trash" size={12} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-gap">
        <button className="btn sm" onClick={() => set({ models: [...draft.models, { id: '', inputPrice: 0, outputPrice: 0, contextWindow: 128000 }] })}><Icon name="plus" size={12} /> 添加模型</button>
        <button className="btn sm" onClick={fetchModels}>从服务获取列表</button>
        <span style={{ flex: 1 }} />
        {draft.id && <button className="btn sm danger" onClick={async () => { if (await call<boolean>('confirm', `删除模型服务「${draft.name}」？`)) await call('deleteProvider', draft.id); }}>删除服务</button>}
        <button className="btn primary" onClick={save} data-testid="provider-save">保存</button>
      </div>
      {draft.id && (
        <div className="row-gap test-row">
          <select className="input sm" value={testModel} onChange={(e) => setTestModel(e.target.value)}>{draft.models.map((m) => <option key={m.id}>{m.id}</option>)}</select>
          <button className="btn sm" disabled={busy} onClick={test}>测试连接</button>
          {testMsg && <span className="small">{testMsg}</span>}
        </div>
      )}
    </div>
  );
}

function ModelSelect({ value, onChange, allowDefault }: { value: ModelRef | null | undefined; onChange: (r: ModelRef | null) => void; allowDefault?: string }) {
  const providers = useStore((s) => s.providers);
  const v = value ? `${value.providerId}::${value.model}` : '';
  return (
    <select className="input sm" value={v} onChange={(e) => { const [providerId, model] = e.target.value.split('::'); onChange(e.target.value ? { providerId, model } : null); }}>
      <option value="">{allowDefault ?? '（未设置）'}</option>
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.models.map((m) => <option key={m.id} value={`${p.id}::${m.id}`}>{m.label || m.id}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function Routing() {
  const s = useStore((st) => st.settings);
  const up = (routing: Settings['routing']) => call('updateSettings', { routing });
  return (
    <section className="card">
      <h3>分级模型路由（Token 经济性）</h3>
      <p className="muted small">规划（中书省）、封驳（门下省）与 Solo 使用<b>强模型</b>；分拣、派发、六部执行、议政发言等粗活使用<b>经济模型</b>。</p>
      <div className="form-grid">
        <label>强模型</label>
        <ModelSelect value={s.routing?.strong} onChange={(r) => up({ ...s.routing, strong: r })} />
        <label>经济模型</label>
        <ModelSelect value={s.routing?.economy} onChange={(r) => up({ ...s.routing, economy: r })} />
      </div>
    </section>
  );
}

function AgentModels() {
  const s = useStore((st) => st.settings);
  return (
    <section className="card">
      <h3>官员独立模型（热切换，下一次调用生效）</h3>
      <div className="agent-model-grid">
        {AGENTS.map((a) => (
          <div key={a.id} className="agent-model-row">
            <span>{a.emoji} {a.name}</span>
            <span className="muted small">{a.modelClass === 'strong' ? '强' : '经济'}</span>
            <ModelSelect value={s.agentModels?.[a.id]} allowDefault="默认路由" onChange={(r) => call('setAgentModel', a.id, r)} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Policy({ info }: { info: { dataDir: string; encrypted: boolean; permissionLabels: Record<string, string> } | null }) {
  const s = useStore((st) => st.settings);
  const up = (p: Partial<Settings>) => call('updateSettings', p);
  return (
    <section className="card">
      <h3>运行策略</h3>
      <div className="form-grid">
        <label>权限模式</label>
        <select className="input" value={s.permissionMode} onChange={(e) => up({ permissionMode: e.target.value as PermissionMode })}>
          {Object.entries(info?.permissionLabels ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label>单旨 Token 预算</label>
        <div className="row-gap">
          {(['solo', 'lite', 'full'] as const).map((t) => (
            <label key={t} className="small">{t} <input className="input num" type="number" value={s.budgets?.[t]} onChange={(e) => up({ budgets: { ...s.budgets, [t]: +e.target.value } })} /></label>
          ))}
        </div>
        <label>单旨费用上限 $</label>
        <input className="input num" type="number" step="0.1" value={s.maxCostUsd} onChange={(e) => up({ maxCostUsd: +e.target.value })} placeholder="0 = 不限" />
        <label>封驳上限</label>
        <div className="row-gap">
          <label className="small">Lite <input className="input num" type="number" min={0} value={s.maxRejections?.lite} onChange={(e) => up({ maxRejections: { ...s.maxRejections, lite: +e.target.value } })} /></label>
          <label className="small">Full <input className="input num" type="number" min={0} value={s.maxRejections?.full} onChange={(e) => up({ maxRejections: { ...s.maxRejections, full: +e.target.value } })} /></label>
          <span className="muted small">超限升级为皇上裁决</span>
        </div>
        <label>审批门</label>
        <div className="row-gap">
          <label className="chk small"><input type="checkbox" checked={s.planGate?.full} onChange={(e) => up({ planGate: { ...s.planGate, full: e.target.checked } })} /> Full：方案御览（可涂改）</label>
          <label className="chk small"><input type="checkbox" checked={s.planGate?.lite} onChange={(e) => up({ planGate: { ...s.planGate, lite: e.target.checked } })} /> Lite：方案御览</label>
          <label className="chk small"><input type="checkbox" checked={s.finalGate} onChange={(e) => up({ finalGate: e.target.checked })} /> 回奏须御批结案</label>
        </div>
        <label>朝堂议政</label>
        <div className="row-gap">
          <label className="chk small"><input type="checkbox" checked={s.debateBeforePlan} onChange={(e) => up({ debateBeforePlan: e.target.checked })} /> Full Court 默认规划前议政</label>
          <label className="small">轮数 <input className="input num" type="number" min={1} max={5} value={s.debateRounds} onChange={(e) => up({ debateRounds: +e.target.value })} /></label>
        </div>
        <label>六部并行度</label>
        <input className="input num" type="number" min={1} max={6} value={s.parallelism} onChange={(e) => up({ parallelism: +e.target.value })} />
        <label>压缩阈值基准</label>
        <div className="row-gap"><input className="input num" type="number" value={s.contextWindowTokens} onChange={(e) => up({ contextWindowTokens: +e.target.value })} /><span className="muted small">tokens；超过 60% 时滚动压缩</span></div>
        <label>外观</label>
        <select className="input" value={s.theme} onChange={(e) => up({ theme: e.target.value as Settings['theme'] })}>
          <option value="system">跟随系统</option><option value="dark">深色</option><option value="light">浅色</option>
        </select>
      </div>
      {info && (
        <div className="notice small">
          <b>数据与安全：</b>数据存放于 <code>{info.dataDir}</code>（本地存储不是安全沙箱）。API Key {info.encrypted ? '经系统钥匙串（safeStorage）加密保存' : '⚠ 当前系统不支持 safeStorage 加密，已退化为本地编码存储'}，不会写入日志、审计或导出。外发请求仅发往你配置的模型服务、你添加的新闻源与远程技能链接。
          <button className="link" onClick={() => call('openDataDir')}>打开数据目录</button>
        </div>
      )}
    </section>
  );
}
