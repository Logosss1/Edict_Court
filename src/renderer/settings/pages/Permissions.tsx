// 权限与审批: default permission mode, write-task confirmation and resume, always-allow rules per workspace,
// release / deploy opt-in, 太子追问 at triage, and the 请旨 timeout used in 全自动.
import { useMemo, useState } from 'react';
import { useStore, openTaskTab, toast } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { agentName, TERMINAL } from '../../../shared/court';
import type { AllowRule, PermissionMode, Settings } from '../../../shared/types';
import { Badge, Page, Row, Sec, Toggle, Warn } from '../ui';
import { NumField, baseName, fmtStamp } from './numField';
import { SandboxSection } from './SandboxSection';
import './permissions.css';

const MODES: { id: PermissionMode; label: string; icon: string; desc: string; warn?: boolean }[] = [
  { id: 'readonly', label: '只读', icon: 'eye', desc: '只看不改：读文件、搜索都行，写文件和执行命令不准；协同旨意的子任务要动手时会弹卡片，你准许了才写。适合让官员先调研、出方案。' },
  { id: 'ask', label: '询问', icon: 'shield', desc: '写文件、执行命令都先问你。最稳妥。' },
  { id: 'auto-edit', label: '自动编辑', icon: 'edit', desc: '写文件自动；命令先问你，安全命令（ls、git status、npm test…）直接放行。' },
  { id: 'auto', label: '全自动', icon: 'zap', desc: '写文件、执行命令都不再询问，写任务开工也不问。高风险、发版与部署仍会问你。', warn: true },
];

const RELEASE_FULL = [
  'git push',
  'npm / pnpm / yarn / bun publish、cargo publish、twine upload、gem push、poetry publish',
  'gh release create / upload / edit / delete、gh pr create / merge',
  'docker push、docker buildx build --push',
  'vercel、netlify deploy、fly deploy、firebase deploy、wrangler deploy、railway up、heroku、serverless / sls deploy、eas submit / update、fastlane、surge',
  'kubectl apply / rollout / set image / delete、helm install / upgrade / uninstall、terraform apply / destroy、pulumi up / destroy',
  'gcloud / aws / az 的 deploy、s3 sync / cp、update-function-code',
  'xcrun altool、notarytool submit',
].join('；');

interface RuleRow {
  id: string;
  key: string;
  label: string;
  scope: 'workspace' | 'task';
  at: number;
  source?: AllowRule['source'];
  revoke: () => Promise<unknown>;
}

/** What a rule key allows, in words (`cmd:npm test` · `tool:write` · `mcp:server/tool`). */
function RuleWhat({ k, label }: { k: string; label: string }) {
  if (k.startsWith('cmd:')) return <><code>{k.slice(4)}</code> 及其参数</>;
  if (k === 'tool:write') return <>写文件（write / edit）</>;
  if (k.startsWith('web:')) return <>抓取网页 <code>{k.slice(4)}</code></>;
  if (k.startsWith('mcp:')) {
    const [server, tool] = k.slice(4).split('/');
    return <>MCP <code>{server} / {tool}</code></>;
  }
  return <>{label}</>;
}

export function PermissionsPage() {
  const s = useStore((st) => st.settings);
  const ws = useStore((st) => st.workspace);
  const tasks = useStore((st) => st.tasks);
  const up = (p: Partial<Settings>) => call('updateSettings', p);

  // workspaces that have (or could have) rules: the open one, every root with saved permissions, roots of live edicts with rules
  const liveTasks = useMemo(() => tasks.filter((t) => !TERMINAL.includes(t.state)), [tasks]);
  const roots = useMemo(() => {
    const out: string[] = [];
    const add = (r?: string | null) => r && !out.includes(r) && out.push(r);
    add(ws);
    Object.keys(s.workspacePerms ?? {}).forEach(add);
    liveTasks.forEach((t) => t.allowRules?.length && add(t.repoRoot ?? t.workspace ?? ws));
    return out;
  }, [ws, s.workspacePerms, liveTasks]);
  const [picked, setPicked] = useState<string | null>(null);
  const root = picked && roots.includes(picked) ? picked : (roots[0] ?? null);
  const rootName = root ? baseName(root) : '';
  const perms = root ? s.workspacePerms?.[root] : undefined;

  const rows = useMemo<RuleRow[]>(() => {
    if (!root) return [];
    const out: RuleRow[] = (perms?.rules ?? []).map((r) => ({
      id: `w:${r.key}`, key: r.key, label: r.label, scope: 'workspace', at: r.at, source: r.source,
      revoke: () => call('removeAllowRule', root, r.key),
    }));
    for (const t of liveTasks) {
      if ((t.repoRoot ?? t.workspace ?? ws) !== root) continue;
      for (const r of t.allowRules ?? [])
        out.push({
          id: `t:${t.id}:${r.key}`, key: r.key, label: r.label, scope: 'task', at: r.at, source: r.source ?? { taskId: t.id, title: t.title },
          revoke: () => call('removeTaskAllowRule', t.id, r.key),
        });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [root, perms, liveTasks, ws]);

  const revoke = async (r: RuleRow) => {
    try {
      await r.revoke();
      toast(`已撤销：${r.label}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const setRelease = async (on: boolean) => {
    if (!root) return;
    if (on) {
      const ok = await call<boolean>(
        'confirm',
        `在「${rootName}」中永久允许发版与部署？`,
        `之后官员在这个工作区执行 git push、npm publish、各类部署命令时不再弹卡片询问，每次执行都会记入审计日志。\n\n只对这个工作区生效，别的项目仍逐次确认；高风险命令（删除、提权等）不受影响。随时可以在这里关掉。`,
      );
      if (!ok) return;
    }
    try {
      await call('setReleaseAlways', root, on);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const mode = s.permissionMode;
  const taskExists = (id: string) => tasks.some((t) => t.id === id);

  return (
    <Page icon="shield" title="权限与审批" lead="官员动手前要不要先问你。高风险操作（rm -rf、提权、改系统目录、读密钥文件…）无论怎么设都会问你。" testid="settings-permissions">
      <div className="permp">
        <Sec title="默认权限" note="· 立即生效，进行中的旨意下一步就按新权限办">
          <div className="permp-mc">
          <div className="mode-cards" role="radiogroup" aria-label="默认权限">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={mode === m.id}
                className={`mode-card ${mode === m.id ? 'on' : ''} ${m.warn ? 'warnm' : ''}`}
                onClick={() => mode !== m.id && void up({ permissionMode: m.id })}
                data-testid={`perm-mode-${m.id}`}
              >
                <span className="t"><Icon name={m.icon} size={14} /> {m.label}</span>
                <span className="d">{m.desc}</span>
              </button>
            ))}
          </div>
          </div>
          <div className="permp-always">
            <Icon name="lock" size={12} />
            <span>任何模式下都会先问你：删除文件、读写 .env / 密钥等敏感文件、高风险命令（rm -rf、sudo、git reset --hard、curl | sh、安装依赖、网络外发…），以及发版与部署。</span>
          </div>
        </Sec>

        <Sec title="写任务与续跑">
          <Row label="每个写任务开工前问一次" desc={<>准许 / 本子任务内免询问 / 改为只读 / 驳回，可附批示。{mode === 'auto' && <span className="permp-dim">（全自动模式下不问）</span>}</>}>
            <Toggle on={s.confirmWriteTasks !== false} onChange={(v) => void up({ confirmWriteTasks: v })} label="每个写任务开工前问一次" testid="confirm-write-tasks" />
          </Row>
          <Row label="应用重启后，自动续跑没改过文件的步骤" desc="改过文件的步骤会停下来，等你核对后再重试">
            <Toggle on={s.autoResumeSafe !== false} onChange={(v) => void up({ autoResumeSafe: v })} label="应用重启后自动续跑没改过文件的步骤" testid="auto-resume-safe" />
          </Row>
          <Row label="单个子任务时限" desc="超时就停下、可局部重试；等你审批、回答请旨的时间不计入。0 = 不限">
            <NumField value={s.nodeTimeoutMin} min={0} max={1440} unit="分钟" label="单个子任务时限（分钟）" testid="node-timeout" onCommit={(v) => void up({ nodeTimeoutMin: v })} />
          </Row>
        </Sec>

        <Sec
          title="已允许的操作"
          note="· 你在审批卡上选「本旨意内」或「本工作区永久」后记在这里"
          right={roots.length > 0 && (
            <label className="permp-ws" {...tip(root ?? '', '切换要查看的工作区')}>
              <Icon name="folder" size={13} />
              <select value={root ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="工作区" data-testid="perm-workspace">
                {roots.map((r) => (
                  <option key={r} value={r}>{baseName(r)}{r === ws ? '（当前）' : ''}</option>
                ))}
              </select>
              <Icon name="chevronDown" size={12} />
            </label>
          )}
        >
          {!root ? (
            <div className="sp-empty">还没有打开工作区。打开一个项目后，在审批卡上选「本工作区永久允许」的操作会列在这里。</div>
          ) : rows.length === 0 ? (
            <div className="sp-empty" data-testid="rules-empty">「{rootName}」还没有免询问的操作。审批卡上选「准许，本旨意内不再询问」或「准许，本工作区永久允许」后，会记在这里，随时可以撤销。</div>
          ) : (
            <div className="permp-tw">
            <table className="tbl2 permp-rules" data-testid="rules-table">
              <thead>
                <tr><th>操作</th><th>范围</th><th>来源</th><th>允许于</th><th aria-label="撤销" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="permp-what"><RuleWhat k={r.key} label={r.label} /></td>
                    <td>{r.scope === 'workspace' ? <span className="scope-tag">本工作区永久</span> : <span className="scope-tag task">本旨意内</span>}</td>
                    <td className="permp-src">
                      {r.source ? (
                        <>
                          {taskExists(r.source.taskId) ? (
                            <button className="permp-tlink" onClick={() => openTaskTab(r.source!.taskId)} {...tip('打开这道旨意')}>{r.source.title}</button>
                          ) : <span>{r.source.title}</span>}
                          {r.source.agentId && <span className="muted"> · {agentName(r.source.agentId)}</span>}
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="permp-at">{fmtStamp(r.at)}</td>
                    <td className="permp-act">
                      <button className="link" onClick={() => void revoke(r)} data-testid={r.scope === 'workspace' ? `rule-revoke-${r.key}` : `rule-revoke-task-${r.key}`}>撤销</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Sec>

        <SandboxSection root={root} />

        <Sec
          title="发版与部署"
          note={<>· git push、npm publish、gh release / pr merge、docker push、kubectl / terraform、各类 deploy 命令 <span className="permp-more" tabIndex={0} {...tip('都算发版与部署', RELEASE_FULL)}><Icon name="help" size={12} /></span></>}
        >
          <Row label={root ? `在 ${rootName} 中永久允许发版与部署` : '在当前工作区中永久允许发版与部署'} desc="默认关闭：每次都会弹卡片让你确认。打开后本工作区的发版命令不再询问，会记入审计日志。">
            <Toggle on={!!perms?.releaseAlways} onChange={(v) => void setRelease(v)} disabled={!root} tone="red" label="永久允许发版与部署" testid="release-always" />
          </Row>
          <Warn>只对当前工作区生效；切到别的项目仍会逐次确认。高风险命令不受这个开关影响。</Warn>
        </Sec>

        <Sec title="太子追问" note="· 旨意不清楚时，太子先问一句再办">
          <Row label="分拣时允许太子先问一句" desc="只在缺少会改变做法的关键信息时问（指的是哪个项目、两种理解差别很大、要求互相矛盾），每道旨意至多一次；也可以直接回「不必问，照办」。勾选「直接下旨」时不问。">
            <Toggle on={s.taiziAsk !== false} onChange={(v) => void up({ taiziAsk: v })} label="太子追问" testid="taizi-ask" />
          </Row>
        </Sec>

        <Sec title="请旨" note="· 官员拿不准时会停下来问你（ask_emperor）" right={mode === 'auto' ? <Badge tone="ok">全自动 · 生效中</Badge> : <Badge tone="off">仅在全自动模式下生效</Badge>}>
          <Row label="无人答复时自动继续" desc="全自动模式下，请旨过这么多分钟没人回答，就按官员说的默认做法继续（没说就自行判断，并在结论里写明；太子追问则照太子所拟）；0 = 一直等。其他模式总是等你回答。">
            <NumField value={s.askTimeoutMin} min={0} max={1440} unit="分钟" label="请旨无人答复多少分钟后按默认继续" testid="ask-timeout" onCommit={(v) => void up({ askTimeoutMin: v })} />
          </Row>
        </Sec>
      </div>
    </Page>
  );
}
