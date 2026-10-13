// 命令沙箱 (2.1), on 权限与审批: on / off, network, extra writable folders (all workspaces and this one),
// package caches and folders commands may not read.
import { useEffect, useState } from 'react';
import { useStore, toast } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import type { SandboxSettings } from '../../../shared/types';
import { Badge, Row, Sec, Toggle, Warn } from '../ui';
import { baseName } from './numField';
import { DEFAULT_SANDBOX_CACHES, DEFAULT_SANDBOX_DENY_READ } from '../../../shared/sandboxDefaults';

type Status = { available: boolean; platform: string; settings: SandboxSettings };

/** One path per line, edited in place; saved on blur. */
export function PathList({ value, onSave, testid, placeholder }: { value: string[]; onSave: (v: string[]) => void; testid: string; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value.join('\n')]);
  return (
    <textarea
      className="input sbx-list"
      rows={Math.min(10, Math.max(3, value.length + 1))}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const next = text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (next.join('\n') !== value.join('\n')) onSave(next);
      }}
      spellCheck={false}
      data-testid={testid}
    />
  );
}

export function SandboxSection({ root }: { root: string | null }) {
  const sandbox = useStore((s) => s.settings.sandbox) as SandboxSettings | undefined;
  const perWs = useStore((s) => (root ? s.settings.workspacePerms?.[root]?.sandboxWritable : undefined)) ?? [];
  const [st, setSt] = useState<Status | null>(null);
  useEffect(() => void call<Status>('sandboxStatus').then(setSt), [sandbox]);
  const s = st?.settings ?? sandbox;
  if (!s) return null;
  const save = async (patch: Partial<SandboxSettings>) => {
    try {
      setSt(await call<Status>('saveSandboxSettings', patch));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const setEnabled = async (on: boolean) => {
    if (!on) {
      const ok = await call<boolean>('confirm', '关闭命令沙箱？', '关掉后，官员执行的命令可以写你电脑上任何你本人能写的地方，也能读密钥目录，只靠审批把关。\n\n建议保持打开；某个命令需要更多权限时，沙箱会弹卡片问你。');
      if (!ok) return;
    }
    await save({ enabled: on });
  };
  const addWs = async () => {
    if (!root) return;
    const dir = await call<string | null>('pickFolder', `允许「${baseName(root)}」里的命令写入的文件夹`);
    if (dir) await call('addSandboxWritable', root, dir);
  };
  return (
    <Sec
      title="命令沙箱"
      note="· 官员执行的命令只能写工作区、临时目录和包管理缓存，读不到密钥目录"
      right={!st ? null : !st.available ? <Badge tone="off">{st.platform === 'darwin' ? '系统不支持' : '仅 macOS'}</Badge> : s.enabled ? <Badge tone="ok">生效中</Badge> : <Badge tone="err">已关闭</Badge>}
      testid="sandbox-section"
    >
      <Row label="打开命令沙箱" desc="用 macOS 自带的沙箱运行官员的命令。被拦下时会弹卡片：本次不受限制重跑、允许写某个文件夹，或按失败处理。发版与部署命令每次都要你确认，确认后在沙箱外执行。你自己在终端里敲的命令不受影响。">
        <Toggle on={s.enabled} onChange={(v) => void setEnabled(v)} tone="red" label="命令沙箱" testid="sandbox-enabled" />
      </Row>
      <Row label="允许联网" desc="默认允许（npm install、git fetch 等都要联网）。关掉后命令只能连本机。">
        <Toggle on={s.network} onChange={(v) => void save({ network: v })} disabled={!s.enabled} label="沙箱允许联网" testid="sandbox-network" />
      </Row>
      <Row label={root ? `「${baseName(root)}」额外可写的文件夹` : '当前工作区额外可写的文件夹'} desc={perWs.length ? '在沙箱卡片上选「允许本工作区写…」也会记在这里' : '还没有。沙箱卡片上选「允许本工作区写…」的文件夹会记在这里。'} testid="sandbox-ws-writable">
        <div className="sbx-chips">
          {perWs.map((d) => (
            <span key={d} className="scope-tag" title={d}>{d.replace(/^\/Users\/[^/]+/, '~')} <button className="icon-btn" onClick={() => root && void call('removeSandboxWritable', root, d)} aria-label={`移除 ${d}`}><Icon name="x" size={10} /></button></span>
          ))}
          <button className="btn sm" disabled={!root} onClick={() => void addWs()} data-testid="sandbox-ws-add"><Icon name="plus" size={12} /> 添加</button>
        </div>
      </Row>
      <details className="sbx-more">
        <summary>更多：所有工作区都可写的文件夹、包管理缓存、禁止读取的目录</summary>
        <div className="sbx-grid">
          <label>
            <span>所有工作区都可写的文件夹</span>
            <PathList value={s.writable} onSave={(v) => void save({ writable: v })} testid="sandbox-writable" placeholder="每行一个，如 ~/scratch" />
          </label>
          <label>
            <span>包管理缓存（可写）</span>
            <PathList value={s.caches} onSave={(v) => void save({ caches: v })} testid="sandbox-caches" />
          </label>
          <label>
            <span>禁止读取</span>
            <PathList value={s.denyRead} onSave={(v) => void save({ denyRead: v })} testid="sandbox-deny-read" />
          </label>
        </div>
        <div className="sbx-reset"><button className="link small" onClick={() => void save({ caches: DEFAULTS.caches, denyRead: DEFAULTS.denyRead })} data-testid="sandbox-reset">恢复默认的缓存和禁读目录</button></div>
      </details>
      <Warn>Edict 自己的数据目录（模型 Key、数据库、其他旨意的工作树）对命令始终不可读。</Warn>
    </Sec>
  );
}

const DEFAULTS = { caches: DEFAULT_SANDBOX_CACHES, denyRead: DEFAULT_SANDBOX_DENY_READ };
