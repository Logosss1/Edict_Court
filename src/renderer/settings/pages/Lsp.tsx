// 语言服务（LSP）: language servers already installed on this machine are found automatically; missing ones
// get an install hint to copy. Edict itself never installs anything.
import { useEffect, useRef, useState } from 'react';
import { toast, useStore } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { fmtTime } from '../../common/format';
import { Badge, Page, Row, Sec, Toggle, Warn } from '../ui';
import './lsp.css';

// mirrors LspStatus in src/main/lsp/manager.ts
type InstanceState = 'starting' | 'running' | 'stopped' | 'crashed' | 'failed';
interface LspInstance { root: string; state: InstanceState; pid?: number; openDocs: number; startedAt?: number; serverInfo?: { name: string; version?: string }; lastError?: string; crashes: number; busy: boolean }
interface LspServer {
  id: string; name: string; languages: string[]; extensions: string[];
  enabled: boolean; installed: boolean; path?: string; args?: string[]; version?: string; note?: string;
  running: boolean; instances: LspInstance[]; lastError?: string; installHint: string; homepage: string;
  custom?: { path: string; args?: string[] };
}
interface LspStatus { enabled: boolean; servers: LspServer[] }
interface LogEntry { at: number; level: 'error' | 'warn' | 'info' | 'log' | 'stderr'; text: string }

type Tone = 'ok' | 'auth' | 'err' | 'off' | 'trust';
function stateOf(s: LspServer): { tone: Tone; label: string; error?: string } {
  if (!s.enabled) return { tone: 'off', label: '已停用' };
  const failed = s.instances.find((i) => i.state === 'failed');
  if (failed) return { tone: 'err', label: '出错', error: failed.lastError ?? s.lastError ?? '多次崩溃，已停止自动重启' };
  if (s.running) return { tone: 'ok', label: '运行中' };
  if (s.instances.some((i) => i.state === 'starting')) return { tone: 'auth', label: '启动中' };
  if (s.instances.some((i) => i.state === 'crashed')) return { tone: 'auth', label: '重启中', error: s.lastError };
  if (s.installed) return { tone: 'ok', label: '已安装' };
  if (s.custom) return { tone: 'err', label: '找不到', error: `指定的程序不存在或不可执行：${s.custom.path}` };
  return { tone: 'off', label: '未安装' };
}

/** "Pyright：brew install pyright（或 npm i -g pyright）" → command to copy + the rest as a note; prose hints have no command. */
function splitHint(s: LspServer): { cmd?: string; rest?: string } {
  const h = s.installHint.startsWith(`${s.name}：`) ? s.installHint.slice(s.name.length + 1) : s.installHint;
  const i = h.search(/（|，/);
  const head = (i >= 0 ? h.slice(0, i) : h).trim();
  const rest = i >= 0 ? h.slice(i).replace(/^，\s*/, '').trim() : undefined;
  if (/[一-龥]/.test(head)) return { rest: h };
  return { cmd: head, rest: rest?.replace(/^（(.*)）$/, '$1') };
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dir = (p: string) => p.slice(0, Math.max(0, p.length - base(p).length - 1)) || '/';

const MISSING_SHOWN = 8;

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`, 'success');
  } catch {
    toast('复制失败，请手动选中复制', 'warn');
  }
}

export function LspPage() {
  const ver = useStore((s) => s.ui.lspVersion ?? 0);
  const [st, setSt] = useState<LspStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [allMissing, setAllMissing] = useState(false);
  const seq = useRef(0);
  const load = async (refresh = false) => {
    const n = ++seq.current;
    try {
      const r = await call<LspStatus>('lspStatus', refresh);
      if (n === seq.current) setSt(r);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => {
    void load();
  }, [ver]);
  const redetect = async () => {
    setBusy(true);
    await load(true);
    setBusy(false);
    toast('已重新检测本机的语言服务', 'success');
  };
  const servers = st?.servers ?? [];
  const found = servers.filter((s) => s.installed || s.custom).sort((a, b) => Number(b.running) - Number(a.running));
  // languages an enabled, installed server already covers: other servers for them are only alternatives
  const covered = new Map<string, string>();
  for (const s of found) if (s.enabled && s.installed) for (const l of s.languages) if (!covered.has(l)) covered.set(l, s.name);
  const altOf = (s: LspServer) => (s.languages.every((l) => covered.has(l)) ? [...new Set(s.languages.map((l) => covered.get(l)!))].join('、') : undefined);
  const missingAll = servers.filter((s) => !s.installed && !s.custom);
  const missing = [...missingAll.filter((s) => !altOf(s)), ...missingAll.filter((s) => altOf(s))];
  const shownMissing = allMissing ? missing : missing.slice(0, MISSING_SHOWN);
  const on = st?.enabled ?? true;
  const setOn = (v: boolean) => void call('lspSetEnabled', v).then(() => load()).catch((e: Error) => toast(e.message, 'error'));
  return (
    <Page
      icon="code"
      title="语言服务（LSP）"
      lead="编辑器里的红线、跳转定义、悬停说明，以及官员的 lsp 工具都靠它。Edict 只使用本机已经装好的语言服务，自己从不安装任何东西；缺的会给出安装命令，装不装由你决定。"
      testid="settings-lsp"
    >
      <Sec>
        <Row label="启用语言服务" desc="打开后，编辑器显示诊断（红线），官员可以用 lsp 工具跳转定义、查引用、看悬停说明。">
          <button className="btn sm" onClick={redetect} disabled={busy} {...tip('重新检测', '重新在 PATH 和常见安装目录里查找；刚装好的服务点这里就能用上')} data-testid="lsp-redetect">
            <Icon name="refresh" size={12} /> {busy ? '检测中…' : '重新检测'}
          </button>
          <Toggle on={on} onChange={setOn} label="启用语言服务" testid="lsp-enabled" />
        </Row>
      </Sec>
      {!on && <Warn>语言服务已关闭：编辑器不显示诊断，官员的 lsp 工具也不可用。下面的设置会保留。</Warn>}
      {!st ? (
        <div className="sp-empty">正在检测本机的语言服务…</div>
      ) : (
        <div className={`lsp-wrap ${on ? '' : 'dim'}`}>
          <Sec title={`已检测 · ${found.length}`} note="· 打开对应文件时自动启动，闲置 10 分钟自动关闭" testid="lsp-found">
            {found.length ? found.map((s) => <ServerRow key={s.id} s={s} reload={load} />) : <div className="sp-empty">本机还没有找到任何语言服务。按下面的命令装一个，再点「重新检测」。</div>}
            {found.length > 0 && <div className="lsp-foot muted">同一种语言找到多个时，用排在前面且已启用的那个；想换用另一个，把前面的关掉即可。</div>}
          </Sec>
          {missing.length > 0 && (
            <Sec title={`未安装 · ${missing.length}`} note="· 复制命令到终端里自己装；装好后点「重新检测」" testid="lsp-missing">
              {shownMissing.map((s) => <ServerRow key={s.id} s={s} reload={load} alt={altOf(s)} />)}
              {missing.length > MISSING_SHOWN && (
                <div className="lsp-more">
                  <button className="link" onClick={() => setAllMissing(!allMissing)} data-testid="lsp-more">
                    {allMissing ? '收起' : `显示其余 ${missing.length - MISSING_SHOWN} 个`}
                  </button>
                  {!allMissing && <span className="muted ellipsis">{[...new Set(missing.slice(MISSING_SHOWN).flatMap((s) => s.languages))].join('、')}</span>}
                </div>
              )}
            </Sec>
          )}
        </div>
      )}
    </Page>
  );
}

/** alt: the installed server(s) that already cover this one's languages (it would only be an alternative). */
function ServerRow({ s, reload, alt }: { s: LspServer; reload: () => Promise<void>; alt?: string }) {
  const [panel, setPanel] = useState<'logs' | 'path' | null>(null);
  const state = stateOf(s);
  const hint = splitHint(s);
  const found = s.installed;
  const docs = s.instances.reduce((n, i) => n + i.openDocs, 0);
  const roots = s.instances.filter((i) => i.state === 'running').length;
  const toggle = (p: 'logs' | 'path') => setPanel(panel === p ? null : p);
  return (
    <div className={`lsp-row ${s.enabled ? '' : 'off'}`} data-testid={`lsp-row-${s.id}`}>
      <div className="lsp-main">
        <div className="nm">
          <b className="ellipsis" title={s.name}>{s.name}</b>
          <span className="muted ellipsis" title={s.extensions.join(' ')}>{s.languages.join(' / ')} · {s.extensions.slice(0, 4).join(' ')}{s.extensions.length > 4 ? ' …' : ''}</span>
          {alt && <span className="lsp-alt ellipsis" {...tip('可选替代', `${s.languages.join(' / ')} 已经由 ${alt} 提供；只有想换用它时才需要装`)}>可替代 {alt}</span>}
        </div>
        <div className="st">
          <Badge tone={state.tone}>{state.label}</Badge>
          {found && s.path ? (
            <code className="path ellipsis" title={`${s.path}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`}>
              {base(s.path)}{s.version ? ` ${s.version}` : ''} · {s.custom ? '你指定的路径' : dir(s.path)}
            </code>
          ) : s.custom ? (
            <code className="path ellipsis" title={s.custom.path}>{s.custom.path}</code>
          ) : hint.cmd ? (
            <span className="hint-cmd ellipsis" title={hint.cmd}>{hint.cmd}</span>
          ) : (
            <span className="muted small ellipsis" title={hint.rest}>{hint.rest}</span>
          )}
          {!found && !s.custom && hint.cmd && hint.rest && <span className="muted small ellipsis alt" title={hint.rest}>{hint.rest}</span>}
          {s.running && <span className="muted small nowrap">· {roots} 个项目 · {docs} 个文件</span>}
        </div>
        <div className="acts">
          {found && <button className={`btn sm ${panel === 'logs' ? 'on' : ''}`} onClick={() => toggle('logs')} data-testid={`lsp-logs-${s.id}`}>日志</button>}
          {found && s.instances.length > 0 && (
            <button className="btn sm" onClick={() => void call('lspRestart', s.id).then(() => { toast(`已重启 ${s.name}，下次用到时重新启动`, 'success'); return reload(); }).catch((e: Error) => toast(e.message, 'error'))} {...tip('重启', '停掉当前进程并清除崩溃记录；下次打开对应文件时自动启动')} data-testid={`lsp-restart-${s.id}`}>
              重启
            </button>
          )}
          {!found && hint.cmd && <button className="btn sm" onClick={() => void copy(hint.cmd!, '安装命令')} data-testid={`lsp-copy-${s.id}`}><Icon name="copy" size={12} /> 复制命令</button>}
          {!found && !hint.cmd && s.homepage && <button className="btn sm" onClick={() => void call('openExternal', s.homepage)}><Icon name="external" size={12} /> 安装说明</button>}
          <button className={`btn sm ${panel === 'path' ? 'on' : ''}`} onClick={() => toggle('path')} {...tip('指定路径', '不用自动检测，改用你指定的可执行文件')} data-testid={`lsp-path-${s.id}`}>
            {s.custom ? '自定义路径' : '指定路径…'}
          </button>
          <Toggle on={s.enabled} onChange={(v) => void call('lspSetServerEnabled', s.id, v).then(() => reload()).catch((e: Error) => toast(e.message, 'error'))} label={`启用 ${s.name}`} testid={`lsp-toggle-${s.id}`} />
        </div>
      </div>
      {state.error && <div className="lsp-err" title={state.error}><Icon name="alert" size={12} /> {state.error}</div>}
      {s.note && !found && <div className="lsp-note muted">找到了程序，但不能用：{s.note}</div>}
      {panel === 'path' && <PathEditor s={s} onDone={() => { setPanel(null); void reload(); }} />}
      {panel === 'logs' && <Logs s={s} />}
    </div>
  );
}

function PathEditor({ s, onDone }: { s: LspServer; onDone: () => void }) {
  const [exe, setExe] = useState(s.custom?.path ?? '');
  const [args, setArgs] = useState((s.custom?.args ?? []).join(' '));
  const save = async (clear = false) => {
    if (!clear && !exe.trim()) return toast('请填写可执行文件路径或命令名', 'warn');
    try {
      const a = args.trim() ? args.trim().split(/\s+/) : undefined;
      await call('lspSetServerPath', s.id, clear ? null : exe.trim(), clear ? undefined : a);
      toast(clear ? `${s.name} 改回自动检测` : `已为 ${s.name} 指定路径`, 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="lsp-panel lsp-pathed" data-testid={`lsp-pathed-${s.id}`}>
      <input className="input sm mono exe" value={exe} onChange={(e) => setExe(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder={`可执行文件的绝对路径或命令名，如 /opt/homebrew/bin/${s.path ? base(s.path) : s.id}`} autoFocus data-testid={`lsp-exe-${s.id}`} />
      <input className="input sm mono args" value={args} onChange={(e) => setArgs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder={s.args?.length ? `参数（默认 ${s.args.join(' ')}）` : '参数（空格分隔，可留空）'} />
      <button className="btn sm primary" onClick={() => void save()}>保存</button>
      {s.custom && <button className="btn sm" onClick={() => void save(true)} data-testid={`lsp-clear-${s.id}`}>清除，改回自动检测</button>}
      <span className="muted small">只会运行你填写的这个程序；参数留空则用默认参数。</span>
    </div>
  );
}

function Logs({ s }: { s: LspServer }) {
  const ver = useStore((st) => st.ui.lspVersion ?? 0);
  const [lines, setLines] = useState<LogEntry[] | null>(null);
  const load = () => void call<LogEntry[]>('lspLogs', s.id).then(setLines).catch(() => setLines([]));
  useEffect(load, [s.id, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  const text = (lines ?? []).slice(-200).map((l) => `${fmtTime(l.at)} ${l.level === 'error' || l.level === 'stderr' ? '✖' : l.level === 'warn' ? '!' : '·'} ${l.text}`).join('\n');
  return (
    <div className="lsp-panel lsp-logs">
      <div className="row-gap small">
        <span className="muted">最近的日志（服务器消息与 stderr）</span>
        <span className="grow" />
        <button className="link" onClick={load}>刷新</button>
        {text && <button className="link" onClick={() => void copy(text, '日志')}>复制</button>}
      </div>
      <pre ref={ref} data-testid={`lsp-logtext-${s.id}`}>{lines === null ? '加载中…' : text || '（还没有日志：打开一个对应语言的文件后才会启动）'}</pre>
    </div>
  );
}
