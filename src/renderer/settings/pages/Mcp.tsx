// 设置 · 连接服务（MCP）: summary tiles (click to filter), filter tabs, 刷新 / 从工作区导入 / 编辑 JSON, the two add
// cards, and a 2-column grid of server cards. Everything is saved as Cursor-compatible mcp.json through mcpSave.
import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api';
import { toast, useStore } from '../../store';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import type { McpServerEntry, McpServerState } from '../../../shared/types';
import { Page, Tile } from '../ui';
import { McpServerCard, explainError } from './McpServerCard';
import { McpAddCards } from './McpAddCards';
import { addToConfig, entriesOf, entrySummary, removeFromConfig } from './mcpForm';
import './mcp.css';

type Filter = 'all' | 'ok' | 'auth' | 'err' | 'trust' | 'off';
const IN: Record<Exclude<Filter, 'all'>, (s: McpServerState) => boolean> = {
  ok: (s) => s.status === 'ok',
  auth: (s) => s.status === 'needs_auth',
  err: (s) => s.status === 'error',
  trust: (s) => s.status === 'untrusted',
  off: (s) => s.status === 'disabled' || s.status === 'stopped',
};
const TABS: { id: Filter; label: string; always?: boolean }[] = [
  { id: 'all', label: '全部', always: true },
  { id: 'ok', label: '已连接', always: true },
  { id: 'auth', label: '需要登录' },
  { id: 'err', label: '异常' },
  { id: 'trust', label: '待信任' },
  { id: 'off', label: '未连接' },
];

type SaveResult = { moved: string[]; untrusted: string[] };
const fail = (e: unknown) => toast((e as Error).message, 'error');

/** Save a whole config text; the main process asks before running new local commands. */
async function saveText(text: string, what: string): Promise<SaveResult | null> {
  try {
    const r = await call<SaveResult>('mcpSave', text);
    toast(`${what}${r.moved.length ? `；${r.moved.length} 个密钥已移入系统钥匙串` : ''}${r.untrusted.length ? `；${r.untrusted.join('、')} 待信任（点「信任并运行」后才会启动）` : ''}`, 'success');
    return r;
  } catch (e) {
    fail(e);
    return null;
  }
}
const currentConfig = () => call<{ text: string; path: string }>('mcpConfig');

export function McpPage() {
  const servers = useStore((s) => s.mcp);
  const [filter, setFilter] = useState<Filter>('all');
  const [panel, setPanel] = useState<'json' | 'import' | null>(null);
  const [jsonSeed, setJsonSeed] = useState<string | null>(null);
  const [imported, setImported] = useState<{ text: string; from: string; added: string[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const stats = useMemo(() => {
    const ok = servers.filter(IN.ok);
    const sum = (f: (s: McpServerState) => number) => ok.reduce((n, s) => n + f(s), 0);
    return {
      all: servers.length,
      remote: servers.filter((s) => s.transport !== 'stdio').length,
      ok: ok.length,
      tools: sum((s) => s.tools.length),
      resources: sum((s) => (s.capabilities?.resources ? s.resourceCount ?? s.resources?.length ?? 0 : 0)),
      prompts: sum((s) => s.prompts?.length ?? 0),
      auth: servers.filter(IN.auth),
      err: servers.filter(IN.err),
      count: (f: Filter) => (f === 'all' ? servers.length : servers.filter(IN[f]).length),
    };
  }, [servers]);
  const shown = filter === 'all' ? servers : servers.filter(IN[filter]);
  const names = useMemo(() => servers.map((s) => s.name), [servers]);
  const pick = (f: Filter) => setFilter((cur) => (cur === f && f !== 'all' ? 'all' : f));

  const add = async (name: string, entry: McpServerEntry) => {
    try {
      const cfg = await currentConfig();
      const r = await saveText(addToConfig(cfg.text, name, entry), `已添加 ${name}`);
      if (r) setFilter('all');
      return !!r;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const remove = async (name: string) => {
    if (!(await call<boolean>('confirm', `移除 MCP 服务「${name}」？`, '会从 mcp.json 删除这一项，并清除它的登录令牌与工具权限设置。'))) return;
    try {
      const cfg = await currentConfig();
      await saveText(removeFromConfig(cfg.text, name), `已移除 ${name}`);
    } catch (e) {
      fail(e);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    const bad = servers.filter((s) => s.status === 'error');
    try {
      for (const s of bad) await call('mcpRestart', s.name);
      await Promise.all([call('mcpListResources').catch(() => undefined), call('mcpListPrompts').catch(() => undefined)]);
      toast(bad.length ? `正在重连 ${bad.map((s) => s.name).join('、')}；已刷新资源与提示词` : '已刷新资源与提示词', 'info');
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  };
  const importWs = async () => {
    try {
      const r = await call<{ text: string; from: string; added: string[] }>('mcpImportWorkspace');
      setImported(r);
      setPanel('import');
    } catch (e) {
      fail(e);
    }
  };

  const firstErr = stats.err[0];
  const errSub = firstErr ? `${firstErr.name}：${explainError(firstErr.error)?.split('：')[0] ?? (firstErr.error ?? '连接失败').replace(/\s+/g, ' ')}${stats.err.length > 1 ? ` 等 ${stats.err.length} 个` : ''}` : stats.all ? '一切正常' : '—';
  return (
    <Page icon="plug" title="连接服务（MCP）" lead="让官员使用外部工具：本地命令或远程服务；新本地命令要你信任后才运行。每个工具可以单独设成「直接用 / 先问我 / 禁用」。" testid="settings-mcp">
      <div className="mcpp">
        <div className="stat-tiles">
          <Tile label="总数" value={stats.all} sub={stats.all ? `远程 ${stats.remote} · 本地 ${stats.all - stats.remote}` : '尚未添加'} onClick={() => setFilter('all')} />
          <Tile label="已连接" value={stats.ok} tone={stats.ok ? 'ok' : undefined} sub={stats.ok ? `共 ${stats.tools} 个工具 · ${stats.resources} 个资源 · ${stats.prompts} 个提示词` : '—'} onClick={() => pick('ok')} active={filter === 'ok'} />
          <Tile label="需要登录" value={stats.auth.length} tone={stats.auth.length ? 'attn' : undefined} sub={stats.auth.length ? stats.auth.map((s) => `${s.name}（OAuth）`).join('、') : '—'} onClick={() => pick('auth')} active={filter === 'auth'} />
          <Tile label="异常" value={stats.err.length} tone={stats.err.length ? 'bad' : undefined} sub={errSub} onClick={() => pick('err')} active={filter === 'err'} />
        </div>

        <div className="mp-bar">
          {TABS.filter((t) => t.always || stats.count(t.id) > 0 || filter === t.id).map((t) => (
            <button key={t.id} className={`mp-tab ${filter === t.id ? 'on' : ''}`} onClick={() => setFilter(t.id)} data-testid={`mcp-filter-${t.id}`}>
              {t.label}<span className="n">{stats.count(t.id)}</span>
            </button>
          ))}
          <span className="mp-sp" />
          <button className="btn sm" onClick={refresh} disabled={refreshing || !servers.length} {...tip('刷新', '重连异常的服务，并重新拉取已连接服务的资源与提示词', undefined, 'below')} data-testid="mcp-refresh">
            <Icon name="refresh" size={12} /> {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button className="btn sm" onClick={importWs} {...tip('从工作区导入', '读取当前工作区的 .cursor/mcp.json、.vscode/mcp.json 或 mcp.json，先给你过目再保存', undefined, 'below')} data-testid="mcp-import">
            <Icon name="folder" size={12} /> 从工作区导入
          </button>
          <button className={`btn sm ${panel === 'json' ? 'on' : ''}`} onClick={() => { setJsonSeed(null); setPanel(panel === 'json' ? null : 'json'); }} {...tip('编辑 JSON', '直接编辑 mcp.json（与 Cursor 格式相同）', undefined, 'below')} data-testid="mcp-edit-json">
            <Icon name="code" size={12} /> 编辑 JSON
          </button>
        </div>

        {panel === 'import' && imported && <ImportPreview r={imported} existing={names} onClose={() => setPanel(null)} onEdit={() => { setJsonSeed(imported.text); setPanel('json'); }} />}
        {panel === 'json' && <JsonEditor key={jsonSeed ?? ''} seed={jsonSeed} serverCount={servers.length} onClose={() => setPanel(null)} />}

        {!servers.length && (
          <div className="mp-empty" data-testid="mcp-empty">
            <span className="ic"><Icon name="plug" size={18} /></span>
            <div>
              <b>还没有连接任何服务</b>
              <p>MCP 服务能把外部工具接给官员：查 GitHub、读数据库、操作浏览器、翻设计稿……远程服务填一个地址即可，本地服务填一条命令。也可以「从工作区导入」现成的 .cursor/mcp.json。</p>
            </div>
          </div>
        )}

        <McpAddCards existing={names} onAdd={add} />

        {servers.length > 0 && (
          shown.length ? (
            <div className="mp-grid">
              {shown.map((s) => <McpServerCard key={s.name} s={s} onRemove={remove} />)}
            </div>
          ) : (
            <div className="sp-empty">没有「{TABS.find((t) => t.id === filter)?.label}」的服务。<button className="link" onClick={() => setFilter('all')}>看全部</button></div>
          )
        )}

        <div className="mp-note muted">
          <Icon name="shield" size={12} /> 本地服务以你的用户身份运行，首次运行或命令行改变时都要你确认；形似密钥的请求头、环境变量保存时移入系统钥匙串。官员调用 MCP 工具受「权限与审批」约束，每次调用都写入审计。
        </div>
      </div>
    </Page>
  );
}

function ImportPreview({ r, existing, onClose, onEdit }: { r: { text: string; from: string; added: string[] }; existing: string[]; onClose: () => void; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const entries = entriesOf(r.text) ?? {};
  const save = async () => {
    setBusy(true);
    const ok = await saveText(r.text, `已从 ${r.from} 导入 ${r.added.length} 个服务`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <section className="sp-sec mp-import" data-testid="mcp-import-preview">
      <div className="sp-sec-h">
        <b>从工作区导入</b>
        <span className="muted">来自 <code>{r.from}</code> · {r.added.length} 个服务（尚未保存）</span>
        <span className="sp-sec-r"><button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={13} /></button></span>
      </div>
      {r.added.length === 0 ? (
        <div className="sp-empty">这个文件里没有服务。</div>
      ) : (
        <div className="mp-imp-list">
          {r.added.map((n) => {
            const e = entries[n];
            const sum = e ? entrySummary(e) : null;
            return (
              <div key={n} className="mp-imp-row">
                <b>{n}</b>
                <span className="ttag">{sum?.local ? '本地' : '远程'}</span>
                <code className="ellipsis" title={sum?.target}>{sum?.target}</code>
                {existing.includes(n) && <span className="badge2 auth">覆盖同名</span>}
                {sum?.local && <span className="badge2 trust">保存时需信任</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="mp-imp-foot">
        <span className="muted">同名的服务会被文件中的配置覆盖；本地命令保存时会弹出系统确认框。</span>
        <span className="mp-sp" />
        <button className="btn sm" onClick={onEdit}>在 JSON 中查看</button>
        <button className="btn sm primary" onClick={save} disabled={busy || !r.added.length} data-testid="mcp-import-save">{busy ? '保存中…' : '保存并连接'}</button>
      </div>
    </section>
  );
}

function JsonEditor({ seed, serverCount, onClose }: { seed: string | null; serverCount: number; onClose: () => void }) {
  const [text, setText] = useState(seed ?? '');
  const [path, setPath] = useState('');
  const [dirty, setDirtyState] = useState(seed !== null);
  const dirtyRef = useRef(seed !== null); // read when the config arrives: never overwrite what the user typed meanwhile
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  const [busy, setBusy] = useState(false);
  const validate = (t: string) => {
    try {
      const j = JSON.parse(t || '{}');
      if (!j || typeof j !== 'object' || Array.isArray(j)) return '顶层必须是对象';
      if (!j.mcpServers && !j.servers) return '缺少顶层 "mcpServers" 对象';
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const [err, setErr] = useState<string | null>(seed !== null ? validate(seed) : null);
  useEffect(() => {
    void currentConfig().then((r) => {
      setPath(r.path);
      if (!dirtyRef.current) setText(r.text);
    }, fail);
  }, [serverCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const v = validate(text);
    if (v) return setErr(v);
    setBusy(true);
    const r = await saveText(text, '已保存 mcp.json');
    setBusy(false);
    if (!r) return;
    setDirty(false);
    void currentConfig().then((c) => setText(c.text), () => undefined);
  };
  return (
    <section className="sp-sec mp-jsoned" data-testid="mcp-json-editor">
      <div className="sp-sec-h">
        <b>mcp.json</b>
        <span className="muted ellipsis" title={path}>{path}</span>
        <span className="sp-sec-r"><button className="icon-btn" onClick={onClose} aria-label="收起"><Icon name="x" size={13} /></button></span>
      </div>
      <textarea className="input mono mp-json" rows={14} value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); setDirty(true); setErr(validate(e.target.value)); }} data-testid="mcp-json" />
      {err && <div className="mp-json-err">JSON：{err}</div>}
      <div className="mp-json-foot">
        <span className="muted">
          与 Cursor 格式相同：<code>command / args / env / envFile / cwd</code>（本地）或 <code>url / headers / auth</code>（远程，先试 Streamable HTTP，再退回 SSE）。变量 <code>{'${env:NAME}'}</code> <code>{'${workspaceFolder}'}</code> <code>{'${userHome}'}</code>；形似密钥的值保存时移入系统钥匙串，文件中只留 <code>{'${secret:…}'}</code>。
        </span>
        <span className="mp-sp" />
        {dirty && <button className="btn sm" onClick={() => { setDirty(false); setErr(null); void currentConfig().then((c) => setText(c.text), fail); }}>还原</button>}
        <button className="btn sm primary" disabled={busy || !!err} onClick={save} data-testid="mcp-save">{busy ? '保存中…' : '保存并连接'}</button>
      </div>
    </section>
  );
}
