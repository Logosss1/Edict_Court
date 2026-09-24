// 技能与 MCP 中心（吏部）— add / edit / enable Skills; configure MCP servers (Cursor-compatible mcp.json),
// trust local commands, per-tool risk & approval, per-official grants; see exactly what an official is given.
import { useEffect, useMemo, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENTS, agentName } from '../../shared/court';
import type { AgentId, McpRisk, McpServerState, SkillInfo } from '../../shared/types';

type Tab = 'skills' | 'mcp' | 'view';

export function Skills() {
  const [tab, setTab] = useState<Tab>('skills');
  const mcp = useStore((s) => s.mcp);
  const skills = useStore((s) => s.skills);
  const okCount = mcp.filter((m) => m.status === 'ok').length;
  return (
    <div className="panel skills-center" data-testid="skills-center">
      <div className="panel-head">
        <h2><Icon name="plug" size={18} /> 技能与 MCP <span className="muted small">吏部 · 掌官员之能</span></h2>
        <div className="subtabs">
          <button className={tab === 'skills' ? 'on' : ''} onClick={() => setTab('skills')} data-testid="tab-skills">技能 Skills · {skills.filter((s) => s.enabled).length}/{skills.length}</button>
          <button className={tab === 'mcp' ? 'on' : ''} onClick={() => setTab('mcp')} data-testid="tab-mcp">MCP 服务 · {okCount}/{mcp.length}</button>
          <button className={tab === 'view' ? 'on' : ''} onClick={() => setTab('view')} data-testid="tab-view">官员视角</button>
        </div>
      </div>
      {tab === 'skills' && <SkillsTab />}
      {tab === 'mcp' && <McpTab />}
      {tab === 'view' && <AgentView />}
    </div>
  );
}

// ───────────────────────── Skills ─────────────────────────
interface Draft { originalName?: string; name: string; description: string; agents: AgentId[] | 'all'; enabled: boolean; content: string; source: SkillInfo['source']; sourceUrl?: string }

function parseBody(text: string) {
  const m = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return m ? m[1] : text;
}

function SkillsTab() {
  const skills = useStore((s) => s.skills);
  const [sel, setSel] = useState<string | null>(skills[0]?.name ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remote, setRemote] = useState(false);
  const [filter, setFilter] = useState('');
  const cur = skills.find((s) => s.name === sel);

  useEffect(() => {
    if (!cur) return;
    call<string>('skillRead', cur.name).then((t) => setDraft({ originalName: cur.name, name: cur.name, description: cur.description, agents: cur.agents, enabled: cur.enabled, content: parseBody(t), source: cur.source, sourceUrl: cur.sourceUrl })).catch(() => undefined);
    setRemote(false);
  }, [sel, skills]); // eslint-disable-line react-hooks/exhaustive-deps

  const newSkill = () => {
    setSel(null);
    setRemote(false);
    setDraft({ name: '', description: '', agents: 'all', enabled: true, content: '# 技能名称\n\n## 何时使用\n\n## 步骤\n1. \n\n## 验收\n', source: 'local' });
  };
  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast('请填写技能名称', 'warn');
    if (!draft.description.trim()) return toast('请填写一句话描述（官员据此判断何时加载）', 'warn');
    try {
      const name = await call<string>('skillSave', { name: draft.name, description: draft.description, agents: draft.agents, content: draft.content, enabled: draft.enabled, originalName: draft.originalName });
      toast(`技能已保存：${name}`, 'success');
      setSel(name);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const shown = skills.filter((s) => !filter || s.name.includes(filter) || s.description.includes(filter));
  return (
    <div className="split-panel sc-split">
      <div className="split-list">
        <div className="row-gap pad">
          <input className="input sm" placeholder="筛选技能…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {shown.map((s) => (
          <div key={s.name} className={`list-item ${sel === s.name ? 'on' : ''} ${s.enabled ? '' : 'off'}`} onClick={() => setSel(s.name)} data-testid={`skill-item-${s.name}`}>
            <div className="row-gap">
              <b className="ellipsis">{s.name}</b>
              <span className="chip chip-sm">{({ builtin: '内置', local: '本地', remote: '远程' } as const)[s.source]}</span>
              <span style={{ flex: 1 }} />
              <label className="switch sm" title={s.enabled ? '已启用（点击停用）' : '已停用（点击启用）'} onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={s.enabled} onChange={(e) => call('skillSetEnabled', s.name, e.target.checked).catch((er) => toast(er.message, 'error'))} />
                <span />
              </label>
            </div>
            <div className="muted small ellipsis">{s.description}</div>
            <div className="muted small">授予：{s.agents === 'all' ? '全体官员' : s.agents.map(agentName).join('、') || '（无）'}</div>
          </div>
        ))}
        <div className="row-gap pad wrap">
          <button className="btn sm primary" onClick={newSkill} data-testid="skills-new"><Icon name="plus" size={12} /> 新建技能</button>
          <button className="btn sm" onClick={async () => { try { const n = await call<string | null>('skillImportFolder'); if (n) { toast(`已导入技能：${n}`, 'success'); setSel(n); } } catch (e) { toast((e as Error).message, 'error'); } }}><Icon name="folder" size={12} /> 导入文件夹</button>
          <button className="btn sm" onClick={() => { setSel(null); setDraft(null); setRemote(true); }}><Icon name="external" size={12} /> 远程链接</button>
        </div>
        <p className="muted small pad">技能 = 一份 SKILL.md 说明书。官员的系统提示里只放「名称 + 一句话描述」，需要时用 load_skill 加载全文，节省 Token。存放于数据目录 skills/。</p>
      </div>
      <div className="split-detail">
        {remote && <RemoteSkillForm onDone={(n) => { setRemote(false); setSel(n); }} />}
        {!remote && draft && (
          <div className="card skill-editor">
            <div className="row-gap">
              <h3>{draft.originalName ? `编辑技能 · ${draft.originalName}` : '新建技能'}</h3>
              <span style={{ flex: 1 }} />
              {draft.originalName && <button className="btn sm" onClick={async () => { const n = await call<string>('skillDuplicate', draft.originalName); toast(`已复制为 ${n}（默认停用）`, 'success'); setSel(n); }}><Icon name="copy" size={12} /> 复制</button>}
              {draft.originalName && <button className="btn sm danger" onClick={async () => { if (await call<boolean>('confirm', `删除技能「${draft.originalName}」？`, draft.source === 'builtin' ? '内置技能删除后不会再自动恢复。' : undefined)) { await call('skillRemove', draft.originalName); setSel(null); setDraft(null); } }}><Icon name="trash" size={12} /> 删除</button>}
            </div>
            {draft.source === 'builtin' && <div className="notice small">内置技能：保存修改后转为本地技能（不会被升级覆盖）。</div>}
            {draft.sourceUrl && <div className="muted small">来源：{draft.sourceUrl}</div>}
            <div className="form-grid">
              <label>名称</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如 html-qa（小写、数字、- _）" data-testid="skill-name" />
              <label>一句话描述</label>
              <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="官员据此判断何时加载本技能" data-testid="skill-desc" />
              <label>授予官员</label>
              <AgentPicker value={draft.agents} onChange={(agents) => setDraft({ ...draft, agents })} />
              <label>状态</label>
              <label className="chk small"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用（停用后官员看不到也无法加载）</label>
            </div>
            <textarea className="input mono skill-body" rows={18} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} spellCheck={false} data-testid="skill-body" />
            <div className="row-gap">
              <span className="muted small">约 {Math.ceil(draft.content.length / 2)} tokens（加载时计入上下文）</span>
              <span style={{ flex: 1 }} />
              <button className="btn primary" onClick={save} data-testid="skill-save">保存技能</button>
            </div>
          </div>
        )}
        {!remote && !draft && <div className="card muted pad">选择左侧技能进行编辑，或新建 / 导入一个技能。</div>}
      </div>
    </div>
  );
}

function AgentPicker({ value, onChange }: { value: AgentId[] | 'all'; onChange: (v: AgentId[] | 'all') => void }) {
  const toggle = (id: AgentId) => onChange(value === 'all' ? AGENTS.filter((a) => a.id !== id).map((a) => a.id) : value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="row-gap wrap">
      <label className="chk small"><input type="checkbox" checked={value === 'all'} onChange={(e) => onChange(e.target.checked ? 'all' : [])} /> 全体</label>
      {AGENTS.map((a) => <label key={a.id} className="chk small"><input type="checkbox" checked={value === 'all' || value.includes(a.id)} onChange={() => toggle(a.id)} /> {a.name}</label>)}
    </div>
  );
}

function RemoteSkillForm({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [url, setUrl] = useState('');
  const [agents, setAgents] = useState<AgentId[] | 'all'>('all');
  const save = async () => {
    if (!name.trim() || !url.trim()) return toast('请填写名称与链接', 'warn');
    try {
      await call('skillAddRemote', { name, url, description: desc, agents });
      toast('远程技能已下载保存', 'success');
      onDone(name.trim().toLowerCase());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card">
      <h3>从链接添加技能（SKILL.md）</h3>
      <div className="form-grid">
        <label>名称</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 api-design" />
        <label>描述</label><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <label>链接</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/SKILL.md（仅 https；下载一次后本地保存）" />
        <label>授予官员</label><AgentPicker value={agents} onChange={setAgents} />
      </div>
      <p className="muted small">外发请求只会发往你填写的这个链接。下载内容会原样保存为本地文件，可随后编辑。</p>
      <div className="row-gap"><span style={{ flex: 1 }} /><button className="btn primary" onClick={save}>下载并保存</button></div>
    </div>
  );
}

// ───────────────────────── MCP ─────────────────────────
const STATUS: Record<McpServerState['status'], string> = { ok: '已连接', starting: '连接中…', error: '连接失败', untrusted: '待信任', disabled: '已停用', stopped: '已停止' };
const RISK: Record<McpRisk, string> = { read: '只读', write: '有副作用', high: '高风险' };

const EXAMPLES: Record<string, { label: string; entry: Record<string, unknown> }> = {
  filesystem: { label: '文件系统（stdio · npx）', entry: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'] } },
  remote: { label: '远程服务（Streamable HTTP）', entry: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer 在此粘贴，保存时自动移入钥匙串' } } },
  python: { label: 'Python 服务（stdio · uvx）', entry: { command: 'uvx', args: ['your-mcp-server'], env: { API_KEY: '在此粘贴，保存时自动移入钥匙串' } } },
};

function McpTab() {
  const servers = useStore((s) => s.mcp);
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dirty) void call<{ text: string; path: string }>('mcpConfig').then((r) => { setText(r.text); setPath(r.path); });
  }, [servers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const validate = (t: string) => {
    try {
      const j = JSON.parse(t || '{}');
      if (!j.mcpServers && !j.servers) return '缺少顶层 "mcpServers" 对象';
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const save = async () => {
    const v = validate(text);
    if (v) return setErr(v);
    setBusy(true);
    try {
      const r = await call<{ moved: string[]; untrusted: string[] }>('mcpSave', text);
      setDirty(false);
      const cfg = await call<{ text: string }>('mcpConfig');
      setText(cfg.text);
      toast(`已保存 mcp.json${r.moved.length ? `；${r.moved.length} 个密钥已移入系统钥匙串` : ''}${r.untrusted.length ? `；${r.untrusted.join('、')} 待信任` : ''}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const addExample = (k: string) => {
    try {
      const j = JSON.parse(text || '{"mcpServers":{}}');
      const box = j.mcpServers ?? (j.mcpServers = {});
      let n = k;
      for (let i = 2; box[n]; i++) n = `${k}${i}`;
      box[n] = EXAMPLES[k].entry;
      setText(JSON.stringify(j, null, 2));
      setDirty(true);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mcp-tab">
      {servers.length === 0 && <div className="card muted pad">尚未配置 MCP 服务。在下方 mcp.json 中添加（格式与 Cursor 相同），或从工作区的 .cursor/mcp.json 导入。</div>}
      <div className="mcp-servers">
        {servers.map((s) => <McpServerCard key={s.name} s={s} />)}
      </div>
      <section className="card">
        <div className="row-gap">
          <h3>mcp.json</h3>
          <span className="muted small ellipsis" title={path}>{path}</span>
          <span style={{ flex: 1 }} />
          <select className="input sm" value="" onChange={(e) => e.target.value && addExample(e.target.value)}>
            <option value="">＋ 插入示例…</option>
            {Object.entries(EXAMPLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button className="btn sm" onClick={async () => { try { const r = await call<{ text: string; from: string; added: string[] }>('mcpImportWorkspace'); setText(r.text); setDirty(true); toast(`已从 ${r.from} 读入 ${r.added.length} 个服务（尚未保存）`, 'info'); } catch (e) { toast((e as Error).message, 'error'); } }}>从工作区导入</button>
        </div>
        <textarea className="input mono mcp-json" rows={14} value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); setDirty(true); setErr(validate(e.target.value)); }} data-testid="mcp-json" />
        {err && <div className="danger small">JSON：{err}</div>}
        <div className="row-gap">
          <span className="muted small">
            支持 <code>command/args/env/envFile/cwd</code>（本地进程）与 <code>url/headers</code>（Streamable HTTP，自动回退旧版 SSE）；变量 <code>{'${env:NAME}'}</code> <code>{'${workspaceFolder}'}</code> <code>{'${userHome}'}</code>。形似密钥的值保存时自动移入系统钥匙串，文件中只留 <code>{'${secret:…}'}</code>。
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !!err} onClick={save} data-testid="mcp-save">{busy ? '保存中…' : '保存并连接'}</button>
        </div>
      </section>
      <div className="notice small">
        <b>安全：</b>本地 MCP 服务是以你的用户身份运行的程序——首次运行或命令行改变时必须由你确认。官员调用 MCP 工具受权限模式约束：「只读」工具直接执行；「有副作用」工具需批准（除非勾选自动批准或全自动模式）；「高风险」工具每次都要皇上确认。所有调用写入审计（只记参数名，不记参数值）。
      </div>
    </div>
  );
}

function McpServerCard({ s }: { s: McpServerState }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState(false);
  const tone = s.status === 'ok' ? 'ok' : s.status === 'error' ? 'bad' : s.status === 'untrusted' ? 'warn' : 'idle';
  const counts = useMemo(() => ({ on: s.tools.filter((t) => t.policy.enabled).length, all: s.tools.length }), [s.tools]);
  return (
    <div className={`card mcp-card ${tone}`} data-testid={`mcp-server-${s.name}`}>
      <div className="row-gap">
        <span className={`mcp-status ${s.status}`} />
        <b>{s.name}</b>
        <span className="chip chip-sm">{s.transport === 'stdio' ? '本地进程' : s.transport === 'sse' ? 'SSE' : 'HTTP'}</span>
        <span className={`mcp-state ${tone}`}>{STATUS[s.status]}</span>
        {s.serverInfo && <span className="muted small">{s.serverInfo.name} {s.serverInfo.version} · 协议 {s.protocolVersion}</span>}
        <span style={{ flex: 1 }} />
        {s.status === 'untrusted' && <button className="btn sm primary" onClick={() => call('mcpTrust', s.name)} data-testid="mcp-trust">信任并启动</button>}
        {s.status === 'ok' || s.status === 'starting' ? <button className="btn sm" onClick={() => call('mcpStop', s.name)}>停止</button> : s.status !== 'untrusted' && s.status !== 'disabled' && <button className="btn sm" onClick={() => call('mcpStart', s.name)}>启动</button>}
        {s.status !== 'untrusted' && s.status !== 'disabled' && <button className="icon-btn" title="重启" onClick={() => call('mcpRestart', s.name)}><Icon name="retry" size={13} /></button>}
        <label className="switch sm" title={s.policy.enabled ? '已启用' : '已停用'}>
          <input type="checkbox" checked={s.policy.enabled} onChange={(e) => call('mcpSetServerPolicy', s.name, { enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      <div className="muted small mono ellipsis" title={s.target}>{s.target}</div>
      {s.error && <div className="danger small">{s.error}</div>}
      <div className="row-gap small">
        <button className="link" onClick={() => setOpen(!open)}>工具 {counts.on}/{counts.all} {open ? '▾' : '▸'}</button>
        <span className="muted">{s.tools.slice(0, 6).map((t) => t.name).join(' · ')}{s.tools.length > 6 ? ' …' : ''}</span>
        <span style={{ flex: 1 }} />
        <span className="muted">授予：</span>
        <select className="input sm" value={s.policy.agents === 'all' ? 'all' : 'some'} onChange={(e) => call('mcpSetServerPolicy', s.name, { agents: e.target.value === 'all' ? 'all' : ['solo', 'bingbu', 'xingbu', 'gongbu'] })}>
          <option value="all">全体官员</option>
          <option value="some">指定官员…</option>
        </select>
        <button className="link" onClick={() => setLogs(!logs)}>日志 {s.logs.length}</button>
      </div>
      {s.policy.agents !== 'all' && (
        <div className="row-gap wrap small">
          {AGENTS.map((a) => (
            <label key={a.id} className="chk small"><input type="checkbox" checked={(s.policy.agents as AgentId[]).includes(a.id)} onChange={(e) => call('mcpSetServerPolicy', s.name, { agents: e.target.checked ? [...(s.policy.agents as AgentId[]), a.id] : (s.policy.agents as AgentId[]).filter((x) => x !== a.id) })} /> {a.name}</label>
          ))}
        </div>
      )}
      {open && (
        <table className="table small mcp-tools">
          <thead><tr><th>启用</th><th>工具</th><th>风险</th><th>自动批准</th><th>官员看到的名字</th></tr></thead>
          <tbody>
            {s.tools.map((t) => (
              <tr key={t.name} className={t.policy.enabled ? '' : 'off'}>
                <td><input type="checkbox" checked={t.policy.enabled} onChange={(e) => call('mcpSetToolPolicy', s.name, t.name, { enabled: e.target.checked })} /></td>
                <td><b>{t.title || t.name}</b>{t.title && <span className="muted"> {t.name}</span>}<div className="muted ellipsis" style={{ maxWidth: 380 }} title={t.description}>{t.description}</div></td>
                <td>
                  <select className="input sm" value={t.policy.risk} onChange={(e) => call('mcpSetToolPolicy', s.name, t.name, { risk: e.target.value as McpRisk })}>
                    {(['read', 'write', 'high'] as McpRisk[]).map((r) => <option key={r} value={r}>{RISK[r]}</option>)}
                  </select>
                  {t.annotations?.readOnlyHint && <div className="muted">服务声明只读</div>}
                  {t.annotations?.destructiveHint && <div className="muted">服务声明破坏性</div>}
                </td>
                <td><input type="checkbox" disabled={t.policy.risk !== 'write'} checked={t.policy.autoApprove} onChange={(e) => call('mcpSetToolPolicy', s.name, t.name, { autoApprove: e.target.checked })} title={t.policy.risk === 'high' ? '高风险工具每次都需确认' : t.policy.risk === 'read' ? '只读工具无需批准' : ''} /></td>
                <td><code className="small">{t.exposed}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {logs && (
        <pre className="mcp-logs">{s.logs.slice(-120).map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level === 'info' ? '·' : l.level === 'error' ? '✖' : '›'} ${l.text}`).join('\n') || '（无日志）'}</pre>
      )}
    </div>
  );
}

// ───────────────────────── 官员视角 ─────────────────────────
function AgentView() {
  const [agent, setAgent] = useState<AgentId>('bingbu');
  const [view, setView] = useState<{ system: string; mcpTools: string[] } | null>(null);
  const skills = useStore((s) => s.skills);
  const mcp = useStore((s) => s.mcp);
  useEffect(() => {
    void call<{ system: string; mcpTools: string[] }>('skillAgentView', agent).then(setView);
  }, [agent, skills, mcp]);
  return (
    <div className="card">
      <div className="row-gap">
        <h3>官员实际获得的能力</h3>
        <select className="input sm" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
        </select>
      </div>
      <p className="muted small">下面是该官员的系统提示（职责 + 技能索引）。技能全文只在官员调用 load_skill 时才进入上下文；MCP 工具以函数形式提供（规划/审议类官员只拿到「只读」工具）。</p>
      <pre className="skill-content">{view?.system}</pre>
      <h4>MCP 工具（{view?.mcpTools.length ?? 0}）</h4>
      <div className="row-gap wrap">{view?.mcpTools.length ? view.mcpTools.map((t) => <code key={t} className="chip">{t}</code>) : <span className="muted small">（无）</span>}</div>
    </div>
  );
}
