// 外部智能体（客卿, 2.1）: other coding agents already installed on this machine can do a ministry's subtask,
// driven over ACP. Edict only finds them; installing and logging in stay with the emperor.
import { useEffect, useRef, useState } from 'react';
import { toast } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { AGENT_MAP, MINISTRIES } from '../../../shared/court';
import type { GuestSettings, GuestStatus, GuestTestResult, MinistryId } from '../../../shared/types';
import { Badge, Page, Row, Sec, Toggle } from '../ui';
import './guests.css';

interface Status { guests: GuestStatus[]; settings: GuestSettings }

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`, 'success');
  } catch {
    toast('复制失败，请手动选中复制', 'warn');
  }
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const cmdLine = (g: GuestStatus) => [g.path ?? '', ...(g.args ?? [])].map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ').trim();

function stateOf(g: GuestStatus): { tone: 'ok' | 'err' | 'off'; label: string } {
  if (!g.enabled) return { tone: 'off', label: '已停用' };
  if (g.found) return { tone: 'ok', label: '已找到' };
  if (g.note) return { tone: 'err', label: '找不到' };
  return { tone: 'off', label: '未安装' };
}

export function GuestsPage() {
  const [st, setSt] = useState<Status | null>(null);
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    try {
      const r = await call<Status>('guestStatuses');
      if (n === seq.current) setSt(r);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const guests = st?.guests ?? [];
  const usable = guests.filter((g) => g.enabled && g.found);
  const defaults = st?.settings.deptDefault ?? {};
  const setDefault = (m: MinistryId, id: string) => void call('setGuestDefaults', { deptDefault: { [m]: id || null } }).then(load).catch((e: Error) => toast(e.message, 'error'));
  return (
    <Page
      icon="users"
      title="外部智能体（客卿）"
      lead="本机装好的其他编程智能体可以请来当客卿，替六部办子任务。它们只在旨意自己的工作树里干活，读写文件、执行命令都走 Edict 的权限和沙箱，自带工具改的文件也会记进改动列表、可以撤回。费用记在它们自己的账号上。Edict 只用已经装好并登录过的，从不替你安装或登录。"
      testid="settings-guests"
      actions={
        <button className="btn sm" onClick={() => void load().then(() => toast('已重新检测本机的智能体', 'success'))} {...tip('重新检测', '刚装好的智能体点这里就能用上')} data-testid="guest-redetect">
          <Icon name="refresh" size={12} /> 重新检测
        </button>
      }
    >
      {!st ? (
        <div className="sp-empty">正在检测本机的智能体…</div>
      ) : (
        <>
          <Sec title="客卿名册" note="· 需要支持 ACP（Agent Client Protocol）" testid="guest-list">
            {guests.map((g) => <GuestRow key={g.id} g={g} reload={load} />)}
          </Sec>
          <AddGuest reload={load} />
          <Sec title="六部默认由谁办" note="· 中书省的方案里也可以逐个子任务改；客卿没法接手时自动退回本部官员" testid="guest-defaults">
            {MINISTRIES.map((m) => {
              const cur = defaults[m] ?? '';
              const gone = cur && !guests.some((g) => g.id === cur);
              return (
                <Row key={m} label={<>{AGENT_MAP[m].emoji} {AGENT_MAP[m].name}</>} desc={AGENT_MAP[m].duty}>
                  <select className="input sm guest-sel" value={cur} onChange={(e) => setDefault(m, e.target.value)} aria-label={`${AGENT_MAP[m].name}默认由谁办`} data-testid={`guest-dept-${m}`}>
                    <option value="">本部官员自己办</option>
                    {guests.filter((g) => g.enabled || g.id === cur).map((g) => (
                      <option key={g.id} value={g.id}>客卿 {g.name}{g.found ? '' : '（本机没找到）'}</option>
                    ))}
                    {gone && <option value={cur}>{cur}（已删除）</option>}
                  </select>
                </Row>
              );
            })}
            {!usable.length && <div className="guest-foot muted">本机还没有可用的客卿：先按上面的命令装一个并登录，再点「重新检测」。</div>}
          </Sec>
          <Sec title="排班（多次尝试）" note="· 一个写入类子任务让两三路人马各在自己的工作树里同时办，门下省评分后你选一路合入" testid="guest-attempts">
            <Row label="Court Lite 也可以排班" desc="Full Court 的方案里总有「排班」按钮；打开后 Court Lite 也有。Solo 不排班。每多一路就多一份费用，客卿的费用记在它们自己的账号上。">
              <Toggle on={!!st.settings.attemptsInLite} onChange={(on) => void call('setGuestDefaults', { attemptsInLite: on }).then(load).catch((e: Error) => toast(e.message, 'error'))} label="Court Lite 也可以排班" testid="guest-attempts-lite" />
            </Row>
          </Sec>
        </>
      )}
    </Page>
  );
}

function GuestRow({ g, reload }: { g: GuestStatus; reload: () => Promise<void> }) {
  const [panel, setPanel] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<GuestTestResult | null>(null);
  const state = stateOf(g);
  const custom = !g.builtIn;
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await call<GuestTestResult>('testGuest', g.id));
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message, ms: 0 });
    }
    setTesting(false);
  };
  const toggle = (on: boolean) => void call('saveGuest', { id: g.id, enabled: on, ...(custom ? { name: g.name } : {}) }).then(reload).catch((e: Error) => toast(e.message, 'error'));
  const remove = () => void call('removeGuest', g.id).then(() => { toast(custom ? `已删除客卿 ${g.name}` : `${g.name} 改回自动检测`, 'success'); return reload(); }).catch((e: Error) => toast(e.message, 'error'));
  return (
    <div className={`guest-row ${g.enabled ? '' : 'off'}`} data-testid={`guest-row-${g.id}`}>
      <div className="guest-main">
        <div className="nm">
          <b className="ellipsis" title={g.name}>{g.name}</b>
          <span className="muted ellipsis">{custom ? '自定义' : '内置'}</span>
        </div>
        <div className="st">
          <Badge tone={state.tone}>{state.label}</Badge>
          {g.found && g.path ? (
            <code className="path ellipsis" title={cmdLine(g)}>{base(g.path)}{g.args?.length ? ` ${g.args.join(' ')}` : ''}</code>
          ) : g.note ? (
            <span className="err ellipsis" title={g.note}>{g.note}</span>
          ) : g.installHint ? (
            <span className="hint-cmd ellipsis" title={g.installHint}>{g.installHint}</span>
          ) : null}
        </div>
        <div className="acts">
          {!g.found && g.installHint && !g.note && <button className="btn sm" onClick={() => void copy(g.installHint!, '安装命令')} data-testid={`guest-copy-${g.id}`}><Icon name="copy" size={12} /> 复制命令</button>}
          {g.found && g.enabled && (
            <button className="btn sm" onClick={() => void test()} disabled={testing} {...tip('测试连接', '在一个空的临时文件夹里启动它、握手、开一个会话再关掉，不会让它干活')} data-testid={`guest-test-${g.id}`}>
              {testing ? '测试中…' : '测试连接'}
            </button>
          )}
          <button className={`btn sm ${panel ? 'on' : ''}`} onClick={() => setPanel(!panel)} {...tip(custom ? '启动命令' : '指定命令', custom ? '改这位客卿的启动命令' : '不用自动检测，改用你指定的程序和参数')} data-testid={`guest-cmd-${g.id}`}>
            {custom ? '启动命令' : g.overridden ? '自定义命令' : '指定命令…'}
          </button>
          {custom && <button className="btn sm" onClick={remove} {...tip('删除', '从名册里删掉；六部默认用它的会改回本部官员')} data-testid={`guest-remove-${g.id}`}><Icon name="trash" size={12} /></button>}
          <Toggle on={g.enabled} onChange={toggle} label={`启用 ${g.name}`} testid={`guest-toggle-${g.id}`} />
        </div>
      </div>
      {result && (
        <div className={`guest-result ${result.ok ? 'ok' : 'bad'}`} data-testid={`guest-result-${g.id}`}>
          <Icon name={result.ok ? 'check' : 'alert'} size={12} /> {result.message}
          {result.ok && <span className="muted"> · {result.ms} ms</span>}
          {!result.ok && result.needsLogin && g.loginHint && <span className="muted"> · {g.loginHint}</span>}
        </div>
      )}
      {!result && g.found && g.loginHint && <div className="guest-note muted">第一次用前：{g.loginHint}</div>}
      {panel && <CommandEditor g={g} onDone={() => { setPanel(false); void reload(); }} onReset={g.builtIn ? remove : undefined} />}
    </div>
  );
}

function CommandEditor({ g, onDone, onReset }: { g: GuestStatus; onDone: () => void; onReset?: () => void }) {
  const [line, setLine] = useState(!g.builtIn || g.overridden ? cmdLine(g) : '');
  const save = async () => {
    if (!line.trim()) return toast('请填写启动命令', 'warn');
    try {
      await call('saveGuest', { id: g.id, commandLine: line.trim(), ...(g.builtIn ? {} : { name: g.name }) });
      toast(`已更新 ${g.name} 的启动命令`, 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="guest-panel" data-testid={`guest-cmded-${g.id}`}>
      <input className="input sm mono" value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} placeholder={g.builtIn ? `以 ACP 模式启动的完整命令，如 /opt/homebrew/bin/${g.path ? base(g.path) : g.id}${g.args?.length ? ` ${g.args.join(' ')}` : ''}` : '以 ACP 模式启动的完整命令'} autoFocus data-testid={`guest-cmdline-${g.id}`} />
      <button className="btn sm primary" onClick={() => void save()}>保存</button>
      {onReset && g.overridden && <button className="btn sm" onClick={() => { onReset(); onDone(); }}>清除，改回自动检测</button>}
      <span className="muted small">只会运行你填写的这个程序。路径里有空格时用引号括起来。</span>
    </div>
  );
}

function AddGuest({ reload }: { reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [line, setLine] = useState('');
  const add = async () => {
    try {
      const g = await call<GuestStatus>('saveGuest', { name: name.trim(), commandLine: line.trim() });
      toast(g.found ? `已添加客卿 ${g.name}，可以点「测试连接」试试` : `已添加客卿 ${g.name}，但${g.note ?? '本机没找到这个程序'}`, g.found ? 'success' : 'warn');
      setName('');
      setLine('');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Sec title="添加其他智能体" note="· 任何支持 ACP 的智能体都可以：填它的名字和以 ACP 模式启动的命令" testid="guest-add">
      <div className="guest-add">
        <input className="input sm name" value={name} onChange={(e) => setName(e.target.value)} placeholder="名字，如 我的智能体" data-testid="guest-add-name" />
        <input className="input sm mono cmd" value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="启动命令，如 my-agent --acp" data-testid="guest-add-cmd" />
        <button className="btn sm primary" onClick={() => void add()} disabled={!name.trim() || !line.trim()} data-testid="guest-add-btn"><Icon name="plus" size={12} /> 添加</button>
      </div>
    </Sec>
  );
}
