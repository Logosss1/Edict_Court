// 连接服务（MCP）: the two add cards (远程服务 / 本地服务). Each builds a standard mcp.json entry, merges it
// into the current config and saves through mcpSave — which asks the native trust dialog for a new local command.
import { useMemo, useState } from 'react';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import type { McpServerEntry } from '../../../shared/types';
import { EMPTY_LOCAL, EMPTY_REMOTE, argLines, argMovesToKeychain, buildLocal, buildRemote, parseEnvLines, parseHeaderLines, splitCommandLine, valueFate, type KV, type LocalDraft, type RemoteDraft } from './mcpForm';

export type AddFn = (name: string, entry: McpServerEntry) => Promise<boolean>;

export function McpAddCards({ existing, onAdd }: { existing: string[]; onAdd: AddFn }) {
  return (
    <div className="mp-add">
      <RemoteCard existing={existing} onAdd={onAdd} />
      <LocalCard existing={existing} onAdd={onAdd} />
    </div>
  );
}

/** Which typed values go to the keychain and which stay readable in mcp.json. */
function Fates({ pairs, extraKeychain = [] }: { pairs: KV[]; extraKeychain?: string[] }) {
  const keychain = [...extraKeychain, ...pairs.filter((p) => valueFate(p.key, p.value) === 'keychain').map((p) => p.key)];
  const plain = pairs.filter((p) => valueFate(p.key, p.value) === 'plain').map((p) => p.key);
  if (!keychain.length && !plain.length) return null;
  return (
    <div className="hint">
      {keychain.length > 0 && <div className="ok-t"><Icon name="lock" size={11} /> {keychain.join('、')}：保存时移入系统钥匙串，文件里只留引用</div>}
      {plain.length > 0 && <div className="warn-t"><Icon name="alert" size={11} /> {plain.join('、')}：会明文写入 mcp.json；若是密钥，请改用 <code>{'${env:变量名}'}</code></div>}
    </div>
  );
}

function RemoteCard({ existing, onAdd }: { existing: string[]; onAdd: AddFn }) {
  const [d, setD] = useState<RemoteDraft>(EMPTY_REMOTE);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const up = (p: Partial<RemoteDraft>) => setD((x) => ({ ...x, ...p }));
  const built = useMemo(() => buildRemote(d, existing), [d, existing]);
  const headers = useMemo(() => parseHeaderLines(d.headers).pairs, [d.headers]);
  const err = tried ? built.errors : { headers: built.errors.headers };
  const tokenFate = d.auth === 'bearer' && d.token.trim() ? valueFate('Authorization', d.token.trim()) : null;
  const add = async () => {
    setTried(true);
    if (!built.entry || busy) return;
    setBusy(true);
    const okd = await onAdd(d.name.trim(), built.entry);
    setBusy(false);
    if (okd) {
      setD(EMPTY_REMOTE);
      setTried(false);
    }
  };
  return (
    <div className="mp-addcard" data-testid="mcp-add-remote">
      <div className="h"><Icon name="globe" size={15} /> 添加远程服务 <span className="muted">HTTP / SSE · 支持 OAuth 登录</span></div>
      <div className="mp-fgrid">
        <label htmlFor="mcp-r-name">名称</label>
        <input id="mcp-r-name" className={`input ${err.name ? 'bad' : ''}`} value={d.name} onChange={(e) => up({ name: e.target.value })} placeholder="my-server" spellCheck={false} data-testid="mcp-r-name" />
        {err.name && <div className="err">{err.name}</div>}
        <label htmlFor="mcp-r-url">地址</label>
        <div className="mp-inline">
          <input id="mcp-r-url" className={`input ${err.url ? 'bad' : ''}`} value={d.url} onChange={(e) => up({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} data-testid="mcp-r-url" />
          <select className="input" value={d.transport} onChange={(e) => up({ transport: e.target.value as RemoteDraft['transport'] })} {...tip('传输方式', '自动：先试 Streamable HTTP，不行再退回旧版 SSE', undefined, 'above')}>
            <option value="auto">自动</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </select>
        </div>
        {err.url ? <div className="err">{err.url}</div> : built.warn && d.url.trim() && <div className="hint warn-t">{built.warn}</div>}
        <label htmlFor="mcp-r-auth">认证</label>
        <select id="mcp-r-auth" className="input" value={d.auth} onChange={(e) => up({ auth: e.target.value as RemoteDraft['auth'] })} data-testid="mcp-r-auth">
          <option value="auto">自动（需要时用 OAuth 登录）</option>
          <option value="oauth">OAuth 登录</option>
          <option value="bearer">请求头 Bearer token</option>
          <option value="none">无</option>
        </select>
        {d.auth === 'bearer' && (
          <>
            <label htmlFor="mcp-r-token">令牌</label>
            <input id="mcp-r-token" type="password" autoComplete="off" className={`input ${err.token ? 'bad' : ''}`} value={d.token} onChange={(e) => up({ token: e.target.value })} placeholder="粘贴令牌，或填 ${env:LINEAR_TOKEN}" spellCheck={false} data-testid="mcp-r-token" />
            {err.token ? <div className="err">{err.token}</div> : (
              <div className="hint">
                {tokenFate === 'reference' ? '保存为 Authorization: Bearer …，运行时从环境变量读取。' : <span className="ok-t"><Icon name="lock" size={11} /> 以 Authorization: Bearer … 发送；保存时移入系统钥匙串，不写进 mcp.json。</span>}
              </div>
            )}
          </>
        )}
        {d.auth === 'oauth' && (
          <>
            <label htmlFor="mcp-r-client">Client ID</label>
            <input id="mcp-r-client" className="input" value={d.clientId} onChange={(e) => up({ clientId: e.target.value })} placeholder="可选：服务不支持自动注册时才需要" spellCheck={false} />
          </>
        )}
        {d.auth === 'oauth' || (d.auth === 'auto' && !headers.some((p) => p.key.toLowerCase() === 'authorization'))
          ? <div className="hint">首次连接若要求登录，卡片上会出现「登录」：在浏览器授权后自动连上，令牌存入系统钥匙串。</div>
          : d.auth === 'auto' && <div className="hint">已填 Authorization 请求头：按它认证，不再走 OAuth 登录。</div>}
        <label htmlFor="mcp-r-headers" className="top">请求头</label>
        <textarea id="mcp-r-headers" className={`input ${err.headers ? 'bad' : ''}`} value={d.headers} onChange={(e) => up({ headers: e.target.value })} placeholder="名称: 值，每行一个，如 X-Api-Version: 2" spellCheck={false} data-testid="mcp-r-headers" />
        {err.headers ? <div className="err">{err.headers}</div> : <Fates pairs={headers} />}
      </div>
      <div className="foot">
        <button className="btn sm primary" onClick={add} disabled={busy} data-testid="mcp-r-add"><Icon name="plus" size={12} /> {busy ? '添加中…' : '添加'}</button>
      </div>
    </div>
  );
}

function LocalCard({ existing, onAdd }: { existing: string[]; onAdd: AddFn }) {
  const [d, setD] = useState<LocalDraft>(EMPTY_LOCAL);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const up = (p: Partial<LocalDraft>) => setD((x) => ({ ...x, ...p }));
  const built = useMemo(() => buildLocal(d, existing), [d, existing]);
  const env = useMemo(() => parseEnvLines(d.env).pairs, [d.env]);
  const err = tried ? built.errors : { env: built.errors.env };
  // a whole command line pasted into 命令 (no separate arguments) is split like a shell would
  const split = !argLines(d.args).length && /\s/.test(d.command.trim()) ? splitCommandLine(d.command.trim()) : null;
  const secretArgs = (split ? split.slice(1) : argLines(d.args)).filter(argMovesToKeychain).map((a) => a.split('=')[0]);
  const add = async () => {
    setTried(true);
    if (!built.entry || busy) return;
    setBusy(true);
    const okd = await onAdd(d.name.trim(), built.entry);
    setBusy(false);
    if (okd) {
      setD(EMPTY_LOCAL);
      setTried(false);
    }
  };
  return (
    <div className="mp-addcard" data-testid="mcp-add-local">
      <div className="h"><Icon name="terminal" size={15} /> 添加本地服务 <span className="muted">stdio · 首次运行需要你信任</span></div>
      <div className="mp-fgrid">
        <label htmlFor="mcp-l-name">名称</label>
        <input id="mcp-l-name" className={`input ${err.name ? 'bad' : ''}`} value={d.name} onChange={(e) => up({ name: e.target.value })} placeholder="filesystem" spellCheck={false} data-testid="mcp-l-name" />
        {err.name && <div className="err">{err.name}</div>}
        <label htmlFor="mcp-l-cmd">命令</label>
        <input id="mcp-l-cmd" className={`input mono ${err.command ? 'bad' : ''}`} value={d.command} onChange={(e) => up({ command: e.target.value })} placeholder="npx（也可以粘贴整行命令）" spellCheck={false} data-testid="mcp-l-cmd" />
        {err.command ? <div className="err">{err.command}</div> : split && split.length > 1 && <div className="hint">将拆成命令 <code>{split[0]}</code> + {split.length - 1} 个参数</div>}
        <label htmlFor="mcp-l-args" className="top">参数</label>
        <textarea id="mcp-l-args" className="input" value={d.args} onChange={(e) => up({ args: e.target.value })} placeholder={'每行一个，例如 -y\n@modelcontextprotocol/server-memory'} spellCheck={false} data-testid="mcp-l-args" />
        <label htmlFor="mcp-l-env" className="top">环境变量</label>
        <textarea id="mcp-l-env" className={`input ${err.env ? 'bad' : ''}`} value={d.env} onChange={(e) => up({ env: e.target.value })} placeholder="KEY=VALUE，每行一个" spellCheck={false} data-testid="mcp-l-env" />
        {err.env ? <div className="err">{err.env}</div> : <Fates pairs={env} extraKeychain={secretArgs} />}
        <div className="hint">可用 <code>{'${workspaceFolder}'}</code> <code>{'${userHome}'}</code> <code>{'${env:名称}'}</code>。添加后会弹出系统确认框，核对命令无误再「信任并运行」。</div>
      </div>
      <div className="foot">
        <button className="btn sm primary" onClick={add} disabled={busy} data-testid="mcp-l-add"><Icon name="plus" size={12} /> {busy ? '添加中…' : '添加'}</button>
      </div>
    </div>
  );
}
