// 连接服务（MCP）: one server card — status, counts, target, error, the actions that fit its status, and three
// expandable parts: 工具权限 (per-tool 直接用 / 先问我 / 禁用 + risk, server switch and grants), 资源与提示词, 日志.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { call } from '../../api';
import { toast } from '../../store';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { AGENTS } from '../../../shared/court';
import { mcpRefToken } from '../../../shared/mcpRefs';
import type { AgentId, McpPromptListItem, McpReadResult, McpResourceInfo, McpRisk, McpServerState, McpToolInfo } from '../../../shared/types';
import { Toggle } from '../ui';

type Tone = 'ok' | 'auth' | 'err' | 'off' | 'trust';
export const STATUS: Record<McpServerState['status'], { label: string; tone: Tone }> = {
  ok: { label: '已连接', tone: 'ok' },
  starting: { label: '连接中…', tone: 'off' },
  needs_auth: { label: '需要登录', tone: 'auth' },
  error: { label: '异常', tone: 'err' },
  untrusted: { label: '待信任', tone: 'trust' },
  disabled: { label: '已停用', tone: 'off' },
  stopped: { label: '已停止', tone: 'off' },
};
const RISK: Record<McpRisk, string> = { read: '只读', write: '有副作用', high: '高风险' };
/** 「指定官员…」 starts from the officials that do hands-on work. */
const DEFAULT_SOME: AgentId[] = ['solo', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu'];

/** How a tool behaves when an official calls it (the permission mode can still tighten or loosen 先问我). */
export type ToolUse = 'direct' | 'ask' | 'off';
export function toolUse(t: McpToolInfo): ToolUse {
  if (!t.policy.enabled) return 'off';
  if (t.policy.risk === 'read') return 'direct';
  if (t.policy.risk === 'high') return 'ask';
  return t.policy.autoApprove ? 'direct' : 'ask';
}
const USE_LABEL: Record<ToolUse, string> = { direct: '直接用', ask: '先问我', off: '禁用' };

const remote = (s: McpServerState) => s.transport !== 'stdio';
const TRANSPORT: Record<McpServerState['transport'], [string, string]> = { stdio: ['本地', '本地命令（stdio）'], http: ['远程', '远程服务（Streamable HTTP）'], sse: ['远程', '远程服务（旧版 SSE）'] };

/** A plain-language reading of common connection errors (shown next to the raw message). */
export function explainError(msg: string | undefined): string | null {
  if (!msg) return null;
  if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(msg)) return '连接被拒绝：服务没启动，或地址、端口不对？';
  if (/ENOTFOUND|NAME_NOT_RESOLVED|EAI_AGAIN/i.test(msg)) return '找不到这个主机：检查地址拼写与网络';
  if (/ETIMEDOUT|TIMED_OUT|timeout|超时/i.test(msg)) return '连接超时：服务没响应，或网络不通';
  if (/CERT|SSL|TLS/i.test(msg)) return '证书校验失败：地址的 https 证书无效';
  if (/ENOENT|command not found|not recognized/i.test(msg)) return '找不到这个命令：确认已安装，或填写完整路径';
  if (/EACCES|permission denied/i.test(msg)) return '没有执行权限';
  if (/\b(403|Forbidden)\b/.test(msg)) return '服务拒绝访问（403）：令牌或权限不对';
  if (/\b404\b/.test(msg)) return '地址不存在（404）：检查路径，如 /mcp 或 /sse';
  return null;
}
const fail = (e: unknown) => toast((e as Error).message, 'error');

type Part = 'tools' | 'res' | 'logs' | null;

export function McpServerCard({ s, onRemove }: { s: McpServerState; onRemove: (name: string) => void }) {
  const [part, setPart] = useState<Part>(null);
  const [menu, setMenu] = useState(false);
  const st = STATUS[s.status];
  const loggedIn = !!s.auth?.loggedIn;
  const loggingIn = !!s.auth?.loggingIn;
  const toggle = (p: Exclude<Part, null>) => setPart((cur) => (cur === p ? null : p));
  const hasRes = !!(s.capabilities?.resources || s.capabilities?.prompts);
  const uses = useMemo(() => {
    const c: Record<ToolUse, number> = { direct: 0, ask: 0, off: 0 };
    for (const t of s.tools) c[toolUse(t)]++;
    return c;
  }, [s.tools]);

  const login = () => call('mcpLogin', s.name).then(() => toast(`${s.name} 已登录`, 'success'), fail);
  const logout = () => call('mcpLogout', s.name).then(() => toast(`已退出 ${s.name} 的登录`, 'info'), fail);
  const live = s.status === 'ok' || s.status === 'starting';
  const verb = remote(s) ? { stop: '断开', start: '连接' } : { stop: '停止', start: '启动' };

  // the (at most three) buttons that fit the status; everything else goes in the ⋯ menu
  const shown: ReactElement[] = [];
  if (s.status === 'needs_auth') shown.push(<button key="login" className="btn sm primary" disabled={loggingIn} onClick={login} data-testid="mcp-login"><Icon name="key" size={12} /> {loggingIn ? '等待浏览器授权…' : '登录'}</button>);
  if (s.status === 'untrusted') shown.push(<button key="trust" className="btn sm primary" onClick={() => call('mcpTrust', s.name).catch(fail)} data-testid="mcp-trust">信任并运行</button>);
  if (s.status === 'disabled') shown.push(<button key="enable" className="btn sm" onClick={() => call('mcpSetServerPolicy', s.name, { enabled: true }).catch(fail)}>启用</button>);
  if (s.status === 'stopped') shown.push(<button key="start" className="btn sm" onClick={() => call('mcpStart', s.name).catch(fail)}>{verb.start}</button>);
  if (s.status === 'error') {
    shown.push(<button key="logs" className={`btn sm ${part === 'logs' ? 'on' : ''}`} onClick={() => toggle('logs')}>查看日志</button>);
    shown.push(<button key="restart" className="btn sm" onClick={() => call('mcpRestart', s.name).catch(fail)}>重启</button>);
  }
  if (s.tools.length) shown.push(<button key="tools" className={`btn sm ${part === 'tools' ? 'on' : ''}`} onClick={() => toggle('tools')} data-testid="mcp-tools">工具权限</button>);
  if (s.status === 'ok' && hasRes) shown.push(<button key="res" className={`btn sm ${part === 'res' ? 'on' : ''}`} onClick={() => toggle('res')} data-testid="mcp-res">资源与提示词</button>);
  if (s.status === 'ok' && loggedIn && shown.length < 2) shown.push(<button key="logout" className="btn sm" onClick={logout}>退出登录</button>);
  if (live && shown.length < 2) shown.push(<button key="stop" className="btn sm" onClick={() => call('mcpStop', s.name).catch(fail)}>{verb.stop}</button>);
  if ((s.status === 'needs_auth' || s.status === 'untrusted') && shown.length < 2) shown.push(<button key="rm" className="btn sm" onClick={() => onRemove(s.name)}>移除</button>);
  const has = (k: string) => shown.some((b) => b.key === k);

  const items: { key: string; label: string; icon: string; run: () => void; danger?: boolean }[] = [];
  if (live && !has('stop')) items.push({ key: 'stop', label: verb.stop, icon: 'stop', run: () => void call('mcpStop', s.name).catch(fail) });
  if (s.status !== 'untrusted' && s.status !== 'disabled' && !has('restart')) items.push({ key: 'restart', label: '重启', icon: 'retry', run: () => void call('mcpRestart', s.name).catch(fail) });
  if (loggedIn && !has('logout')) items.push({ key: 'logout', label: '退出登录', icon: 'lock', run: () => void logout() });
  if (s.auth && !loggedIn && s.status !== 'needs_auth') items.push({ key: 'login', label: '登录', icon: 'key', run: () => void login() });
  if (!has('logs')) items.push({ key: 'logs', label: part === 'logs' ? '收起日志' : `查看日志（${s.logs.length}）`, icon: 'list', run: () => toggle('logs') });
  if (s.policy.enabled && s.status !== 'untrusted') items.push({ key: 'disable', label: '停用（官员不可用）', icon: 'pause', run: () => void call('mcpSetServerPolicy', s.name, { enabled: false }).catch(fail) });
  if (!has('rm')) items.push({ key: 'rm', label: '移除…', icon: 'trash', danger: true, run: () => onRemove(s.name) });

  return (
    <div className={`mp-srv ${part === 'tools' || part === 'res' ? 'open' : ''}`} data-testid={`mcp-server-${s.name}`}>
      <div className="h">
        <span className="n ellipsis" title={s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version ?? ''} · 协议 ${s.protocolVersion ?? '?'}` : s.name}>{s.name}</span>
        <span className="ttag" {...tip(TRANSPORT[s.transport][1], undefined, undefined, 'below')}>{TRANSPORT[s.transport][0]}</span>
        <span className={`badge2 ${st.tone} mcp-status ${s.status}`}><i />{st.label}</span>
        <span className="r">
          {shown}
          <More items={items} open={menu} setOpen={setMenu} />
        </span>
      </div>
      <div className="meta">
        {s.status === 'ok' && (
          <>
            <span><b>{s.tools.length}</b> 个工具</span>
            {s.capabilities?.resources && <span><b>{s.resourceCount ?? s.resources?.length ?? 0}</b> 个资源</span>}
            {s.capabilities?.prompts && <span><b>{s.prompts?.length ?? 0}</b> 个提示词</span>}
            {s.tools.length > 0 && <span>{(['direct', 'ask', 'off'] as ToolUse[]).filter((u) => uses[u]).map((u) => `${USE_LABEL[u]} ${uses[u]}`).join(' · ')}</span>}
            {s.policy.agents !== 'all' && <span>授予 {s.policy.agents.length} 位官员</span>}
          </>
        )}
        {s.status === 'starting' && <span>正在连接…</span>}
        {s.status === 'needs_auth' && <span>登录后才能列出工具</span>}
        {s.status === 'error' && <span>连接失败，可查看日志或重启</span>}
        {s.status === 'untrusted' && <span>新的本地命令：核对无误后再信任，它会以你的身份在本机运行</span>}
        {s.status === 'disabled' && <span>已停用：官员看不到它的工具</span>}
        {s.status === 'stopped' && <span>已{verb.stop}{s.tools.length ? ` · 上次 ${s.tools.length} 个工具` : ''}</span>}
      </div>
      <div className="line" title={s.target}>
        {s.target}
        {remote(s) && loggedIn && <span className="note"> · OAuth 已登录{s.auth?.issuer ? `（${hostOf(s.auth.issuer)}）` : ''}</span>}
      </div>
      {s.status === 'needs_auth' && <div className="line note">点「登录」会打开浏览器授权；Edict 在本机 127.0.0.1 临时开一个端口接收回调</div>}
      {s.error && s.status === 'error' && <div className="line err" title={s.error}>{s.error}{explainError(s.error) && <> —— {explainError(s.error)}</>}</div>}
      {part === 'tools' && <ToolsPart s={s} />}
      {part === 'res' && <ResourcesPart s={s} />}
      {part === 'logs' && <pre className="mp-logs">{s.logs.slice(-150).map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level === 'info' ? '·' : l.level === 'error' ? '✖' : '›'} ${l.text}`).join('\n') || '（暂无日志）'}</pre>}
    </div>
  );
}

function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function More({ items, open, setOpen }: { items: { key: string; label: string; icon: string; run: () => void; danger?: boolean }[]; open: boolean; setOpen: (v: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, setOpen]);
  return (
    <span className="mp-more" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(!open)} {...tip('更多操作', undefined, undefined, 'below')} aria-haspopup="menu" aria-expanded={open}>
        <Icon name="dots" size={14} />
      </button>
      {open && (
        <div className="mp-menu" role="menu">
          {items.map((it) => (
            <button key={it.key} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.run(); }}>
              <Icon name={it.icon} size={12} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ───────── 工具权限 ─────────
function ToolsPart({ s }: { s: McpServerState }) {
  const setTool = (t: McpToolInfo, patch: Partial<McpToolInfo['policy']>) => void call('mcpSetToolPolicy', s.name, t.name, patch).catch(fail);
  const setUse = (t: McpToolInfo, u: ToolUse) => {
    if (u === 'off') return setTool(t, { enabled: false });
    if (u === 'direct') return setTool(t, { enabled: true, ...(t.policy.risk === 'write' ? { autoApprove: true } : {}) });
    // 先问我: a read-only tool never asks, so asking means treating it as having side effects
    setTool(t, { enabled: true, autoApprove: false, ...(t.policy.risk === 'read' ? { risk: 'write' as McpRisk } : {}) });
  };
  const agents = s.policy.agents;
  const setAgents = (v: AgentId[] | 'all') => void call('mcpSetServerPolicy', s.name, { agents: v }).catch(fail);
  return (
    <div className="mp-x" data-testid="mcp-tools-part">
      <div className="mp-x-row">
        <span>启用此服务</span>
        <Toggle on={s.policy.enabled} onChange={(v) => void call('mcpSetServerPolicy', s.name, { enabled: v }).catch(fail)} label="启用此服务" />
        <span className="mp-x-gap" />
        <span>授予</span>
        <select className="input sm" value={agents === 'all' ? 'all' : 'some'} onChange={(e) => setAgents(e.target.value === 'all' ? 'all' : DEFAULT_SOME)}>
          <option value="all">全体官员</option>
          <option value="some">指定官员…</option>
        </select>
      </div>
      {agents !== 'all' && (
        <div className="mp-agents">
          {AGENTS.map((a) => (
            <label key={a.id} className={`mp-agent ${agents.includes(a.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={agents.includes(a.id)} onChange={(e) => setAgents(e.target.checked ? [...agents, a.id] : agents.filter((x) => x !== a.id))} /> {a.name}
            </label>
          ))}
        </div>
      )}
      <table className="tbl2 mp-tools">
        <thead>
          <tr><th>工具</th><th>风险</th><th>官员调用时</th></tr>
        </thead>
        <tbody>
          {s.tools.map((t) => {
            const u = toolUse(t);
            return (
              <tr key={t.name} className={u === 'off' ? 'off' : ''}>
                <td className="mp-tool">
                  <b>{t.title || t.name}</b>{t.title && <span className="muted"> {t.name}</span>}
                  {t.annotations?.readOnlyHint && <span className="mp-hint">服务声明只读</span>}
                  {t.annotations?.destructiveHint && <span className="mp-hint bad">服务声明有破坏性</span>}
                  {t.description && <div className="desc ellipsis" title={t.description}>{t.description}</div>}
                  <div className="exp ellipsis" title="官员看到的工具名">{t.exposed}</div>
                </td>
                <td>
                  <select className="input sm" value={t.policy.risk} onChange={(e) => setTool(t, { risk: e.target.value as McpRisk })} aria-label={`${t.name} 风险`}>
                    {(['read', 'write', 'high'] as McpRisk[]).map((r) => <option key={r} value={r}>{RISK[r]}</option>)}
                  </select>
                </td>
                <td>
                  <div className="mp-seg" role="radiogroup" aria-label={`${t.name} 调用方式`}>
                    {(['direct', 'ask', 'off'] as ToolUse[]).map((x) => {
                      const no = x === 'direct' && t.policy.risk === 'high';
                      return (
                        <button key={x} role="radio" aria-checked={u === x} className={`${u === x ? 'on' : ''} ${x}`} disabled={no} onClick={() => setUse(t, x)}
                          {...tip(USE_LABEL[x], no ? '高风险工具每次都要你确认' : x === 'direct' ? (t.policy.risk === 'read' ? '只读工具直接执行' : '不再询问，直接执行') : x === 'ask' ? (t.policy.risk === 'high' ? '每次调用都要你确认' : t.policy.risk === 'read' ? '改按「有副作用」处理，调用前先问你' : '调用前先问你（全自动模式下直接执行）') : '官员看不到这个工具', undefined, 'above')}>
                          {x === 'ask' && t.policy.risk === 'high' ? '每次确认' : USE_LABEL[x]}
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mp-foot muted">「只读」工具直接执行；「有副作用」默认先问你（全自动模式下直接执行）；「高风险」每次都要你确认；只读权限模式下只能用只读工具。规划、审议类官员只拿到只读工具。每次调用都写入审计（只记参数名）。</div>
    </div>
  );
}

// ───────── 资源与提示词 ─────────
function ResourcesPart({ s }: { s: McpServerState }) {
  const [resources, setResources] = useState<McpResourceInfo[] | null>(s.capabilities?.resources ? null : []);
  const [prompts, setPrompts] = useState<McpPromptListItem[] | null>(s.capabilities?.prompts ? null : []);
  const [preview, setPreview] = useState<{ uri: string; r?: McpReadResult; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (s.capabilities?.resources) void call<McpResourceInfo[]>('mcpListResources', s.name).then((r) => live && setResources(r), () => live && setResources(s.resources ?? []));
    if (s.capabilities?.prompts) void call<McpPromptListItem[]>('mcpListPrompts').then((r) => live && setPrompts(r.filter((p) => p.server === s.name)), () => live && setPrompts((s.prompts ?? []).map((p) => ({ ...p, server: s.name }))));
    return () => {
      live = false;
    };
  }, [s.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = async (uri: string) => {
    if (preview?.uri === uri) return setPreview(null);
    setPreview({ uri });
    try {
      setPreview({ uri, r: await call<McpReadResult>('mcpReadResource', s.name, uri) });
    } catch (e) {
      setPreview({ uri, error: (e as Error).message });
    }
  };
  const copyRef = (uri: string) => {
    const tok = mcpRefToken(s.name, uri);
    void navigator.clipboard.writeText(tok).then(() => toast(`已复制 ${tok}，粘贴到下旨框即可引用`, 'success'), () => toast(tok, 'info'));
  };
  const templates = s.resourceTemplates ?? [];
  return (
    <div className="mp-x" data-testid="mcp-res-part">
      {s.capabilities?.resources && (
        <div className="mp-block">
          <div className="mp-block-h"><b>资源</b><span className="muted">{resources ? `${s.resourceCount ?? resources.length} 项` : '读取中…'}</span></div>
          {resources?.length === 0 && <div className="sp-empty">这个服务暂时没有可读的资源。</div>}
          {resources?.slice(0, 200).map((r) => (
            <div key={r.uri} className="mp-item">
              <div className="mp-item-row">
                <Icon name="file" size={13} />
                <span className="mp-item-n ellipsis" title={r.description ?? r.name}>{r.title || r.name}</span>
                <code className="ellipsis" title={r.uri}>{r.uri}</code>
                {r.mimeType && <span className="ttag">{r.mimeType}</span>}
                <span className="mp-sp" />
                <button className="link" onClick={() => copyRef(r.uri)} {...tip('复制引用', `下旨时贴上 ${mcpRefToken(s.name, r.uri)}，内容会附给官员`, undefined, 'above')}>引用</button>
                <button className="btn sm" onClick={() => void view(r.uri)} data-testid="mcp-res-view">{preview?.uri === r.uri ? '收起' : '查看'}</button>
              </div>
              {preview?.uri === r.uri && (
                <pre className={`mp-preview ${preview.error ? 'err' : ''}`}>{preview.error ? `读取失败：${preview.error}` : preview.r ? clip(preview.r.text, 6000) : '读取中…'}</pre>
              )}
            </div>
          ))}
          {templates.length > 0 && (
            <div className="mp-tpls">
              <span className="muted">资源模板：</span>
              {templates.slice(0, 20).map((t) => <code key={t.uriTemplate} title={t.description ?? t.name}>{t.uriTemplate}</code>)}
            </div>
          )}
        </div>
      )}
      {s.capabilities?.prompts && (
        <div className="mp-block">
          <div className="mp-block-h"><b>提示词</b><span className="muted">{prompts ? `${prompts.length} 个` : '读取中…'}</span></div>
          {prompts?.length === 0 && <div className="sp-empty">这个服务暂时没有提示词。</div>}
          {prompts?.map((p) => (
            <div key={p.name} className="mp-item">
              <div className="mp-item-row">
                <span className="mp-slash">/</span>
                <span className="mp-item-n">{p.title || p.name}</span>
                {p.title && <code>{p.name}</code>}
                {p.description && <span className="muted ellipsis" title={p.description}>{p.description}</span>}
              </div>
              {p.arguments.length > 0 && (
                <div className="mp-args">
                  参数：
                  {p.arguments.map((a) => (
                    <span key={a.name} className={`mp-arg ${a.required ? 'req' : ''}`} {...tip(a.title || a.name, `${a.required ? '必填' : '可选'}${a.description ? `：${a.description}` : ''}`, undefined, 'above')}>
                      {a.name}{a.required ? ' *' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mp-foot muted">下旨时在输入框里输入 <kbd>@</kbd> 引用资源（内容会附在旨意后交给官员），在空行开头输入 <kbd>/</kbd> 调出提示词。</div>
    </div>
  );
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n…（仅预览前 ${n} 字符，共 ${t.length} 字符）` : t);
