// 编辑器接入（ACP）: editors such as Zed drive Edict through a local socket (Agent Client Protocol).
// Off by default; each editor is approved on first connect; high-risk approvals can stay inside Edict.
import { useEffect, useState } from 'react';
import { openTaskTab, toast, useStore } from '../../store';
import { call, isMac } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { fmtAgo } from '../../common/format';
import { TIER_SHORT } from '../../../shared/court';
import type { Settings, Tier } from '../../../shared/types';
import { Badge, Page, Row, Sec, Toggle } from '../ui';
import './acp.css';

// mirrors acpStatus() in src/main/main.ts (one summary per RuntimeAcpHost session, newest first)
interface AcpSession { id: string; cwd: string; modeId: Tier; client: string; createdAt: number; updatedAt: number; turns: number; lastUser?: string; taskIds: string[]; running: boolean }
interface AcpStatus { enabled: boolean; listening: boolean; socketPath: string; connections: number; approvedClients: string[]; sessions: AcpSession[] }

const POLL_MS = 3000;
const SHOW_SESSIONS = 12;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function AcpPage() {
  const settings = useStore((s) => s.settings);
  const taskIds = useStore((s) => s.tasks.map((t) => t.id));
  const [st, setSt] = useState<AcpStatus | null>(null);
  const [cfg, setCfg] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const up = (p: Partial<Settings>) => call('updateSettings', p).catch((e: Error) => toast(e.message, 'error'));

  useEffect(() => {
    let alive = true;
    const load = () => void call<AcpStatus>('acpStatus').then((r) => alive && setSt(r)).catch(() => undefined);
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [settings.acpEnabled]);
  useEffect(() => {
    void call<unknown>('acpEditorConfig').then((c) => setCfg(c ? JSON.stringify(c, null, 2) : null)).catch(() => setCfg(null));
  }, []);

  const enabled = !!settings.acpEnabled;
  const highOnly = settings.acpHighRiskInEdictOnly !== false;
  const copyCfg = async () => {
    if (!cfg) return;
    try {
      await navigator.clipboard.writeText(cfg);
      toast('已复制 Zed 配置，粘贴进 Zed 的 settings.json 即可', 'success');
    } catch {
      toast('复制失败，请手动选中复制', 'warn');
    }
  };
  const sessions = st?.sessions ?? [];
  const shown = all ? sessions : sessions.slice(0, SHOW_SESSIONS);

  return (
    <Page icon="link" title="编辑器接入（ACP）" lead="让 Zed 等编辑器直接给 Edict 下旨（Agent Client Protocol）：编辑器里说的话变成旨意，由各部执行，进度、改动和权限请求回到编辑器里。只走本机通道，不开网络端口。" testid="settings-acp">
      <Sec>
        <Row label="允许编辑器通过 ACP 接入" desc="只在本机 socket 上监听（仅你的账户可读写）；每个编辑器第一次连上都要你点头，本次运行内有效。">
          <Toggle on={enabled} onChange={(v) => void up({ acpEnabled: v })} label="允许编辑器通过 ACP 接入" testid="acp-enabled" />
        </Row>
        <div className="acp-status" data-testid="acp-status">
          {!enabled ? (
            <><Badge tone="off">未启用</Badge><span className="muted">打开上面的开关后才会监听，编辑器连不进来。</span></>
          ) : st?.listening ? (
            <>
              <Badge tone="ok">监听中</Badge>
              <code className="sock ellipsis" title={st.socketPath}>{st.socketPath}</code>
              <span className="muted nowrap">· {st.connections ? `${st.connections} 个连接` : '暂无连接'}</span>
            </>
          ) : (
            <><Badge tone="auth">未在监听</Badge><span className="muted">正在启动；若一直如此，关掉再打开试试（启动失败会弹出提示）。</span></>
          )}
        </div>
      </Sec>

      <Sec title={<span className="acp-t"><Icon name="code" size={14} /> 接入 Zed</span>} note="· 其他支持 ACP 的编辑器用法相同：启动同一个命令即可" testid="acp-zed">
        <ol className="acp-steps">
          <li>打开上面的「允许编辑器通过 ACP 接入」。</li>
          <li>在 Zed 里打开 settings.json（<kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd> <kbd>,</kbd>），把下面这段并进去；已有 <code>agent_servers</code> 时合并到里面。</li>
          <li>打开 Zed 的 Agent 面板，新建会话时选「Edict」。第一次连接时 Edict 会弹窗请你允许。</li>
        </ol>
        <div className="acp-code">
          <div className="acp-code-h">
            <span className="muted small">Zed settings.json</span>
            <span className="grow" />
            <button className="btn sm" onClick={() => void copyCfg()} disabled={!cfg} data-testid="acp-copy-zed"><Icon name="copy" size={12} /> 复制 Zed 配置</button>
          </div>
          <pre data-testid="acp-zed-config">{cfg ?? '（读取配置失败）'}</pre>
        </div>
        <div className="muted small acp-tip">配置里写的是这台机器上 Edict 程序的位置；Edict 换了位置或升级后连不上，重新复制一次即可。编辑器里可选三种模式：Solo（默认）、Court Lite、Full Court；三省模式回奏后仍在 Edict 里御批结案。</div>
      </Sec>

      <Sec title={<span className="acp-t"><Icon name="shield" size={14} /> 安全</span>}>
        <Row label="高风险操作只在 Edict 里确认" desc="开启时，推送、发布、部署、删除等高风险操作不会交给编辑器批准，只能回到 Edict 里由你确认；普通的写文件、执行命令仍可在编辑器里直接批。建议保持开启。">
          <Toggle on={highOnly} onChange={(v) => void up({ acpHighRiskInEdictOnly: v })} label="高风险操作只在 Edict 里确认" testid="acp-high-risk" />
        </Row>
      </Sec>

      <Sec title="已允许的编辑器" note="· 只在本次运行内有效；关闭上面的接入开关会断开所有编辑器并清空授权，下次连接重新询问" testid="acp-clients">
        {st?.approvedClients.length ? (
          <div className="acp-clients">
            {st.approvedClients.map((c) => (
              <span key={c} className="acp-client"><Icon name="code" size={12} /> {c} <Badge tone="ok" dot={false}>已允许</Badge></span>
            ))}
          </div>
        ) : (
          <div className="sp-empty">{enabled ? '本次运行还没有编辑器连上来。' : '接入未启用。'}</div>
        )}
      </Sec>

      <Sec title={`编辑器会话${sessions.length ? ` · ${sessions.length}` : ''}`} note="· 编辑器里开的会话，最近的在前；记录会保留，编辑器可以载入接着聊" testid="acp-sessions">
        {sessions.length ? (
          <>
            <table className="tbl2 acp-tbl">
              <thead>
                <tr><th>编辑器</th><th>工作区</th><th>模式</th><th>最近一句</th><th className="r">轮次</th><th className="r">最近</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const task = s.taskIds.find((id) => taskIds.includes(id));
                  return (
                    <tr key={s.id} className={s.running ? 'running' : ''}>
                      <td className="nowrap"><span className="ellipsis" title={s.client}>{s.client || '未知编辑器'}</span></td>
                      <td><span className="ellipsis acp-cwd" title={s.cwd}>{base(s.cwd)}</span></td>
                      <td className="nowrap">{TIER_SHORT[s.modeId] ?? s.modeId}</td>
                      <td><span className="ellipsis acp-last" title={s.lastUser}>{s.lastUser || <span className="muted">（还没说话）</span>}</span></td>
                      <td className="r">{s.turns}</td>
                      <td className="r nowrap">{s.running ? <Badge tone="ok">进行中</Badge> : <span className="muted">{fmtAgo(s.updatedAt)}</span>}</td>
                      <td className="r">{task && <button className="link" onClick={() => openTaskTab(task)} {...tip('打开旨意', '这个会话最近一道旨意的详情')}>旨意</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {sessions.length > SHOW_SESSIONS && <button className="link acp-more" onClick={() => setAll(!all)}>{all ? '收起' : `显示全部 ${sessions.length} 个`}</button>}
          </>
        ) : (
          <div className="sp-empty">还没有编辑器会话。</div>
        )}
      </Sec>
    </Page>
  );
}
