// 典章: the workspace's own rule files (AGENTS.md / CLAUDE.md / .edict/rules.md) and the emperor's standing
// canon (禁止 / 规矩 / 偏好 / 教训), injected into planning, review and execution prompts (see main/runtime/canon.ts).
import { useEffect, useMemo, useState } from 'react';
import { useStore, openTaskTab, toast } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import { tip } from '../../common/Tip';
import { askConfirm } from '../../common/Prompt';
import { openFile } from '../../workbench/Explorer';
import type { CanonEntry, CanonKind } from '../../../shared/types';
import { Badge, Page, Sec, Toggle } from '../ui';
import { baseName, fmtStamp } from './numField';
import './canon.css';

const KINDS: { id: CanonKind; label: string; hint: string }[] = [
  { id: 'forbid', label: '禁止', hint: '红线：每道旨意都会带上，官员一条都不能违反（不看关键词）。' },
  { id: 'rule', label: '规矩', hint: '必须照做的做法，例如「回奏列出跑过的命令」。' },
  { id: 'preference', label: '偏好', hint: '你喜欢的做法，官员会尽量照办。' },
  { id: 'lesson', label: '教训', hint: '踩过的坑，提醒官员别再犯。门下或你的封驳意见可以在旨意详情里一键「收入典章」。' },
];
const KIND_ORDER = KINDS.map((k) => k.id);
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<CanonKind, string>;
const RULE_FILES: { file: string; desc: string }[] = [
  { file: 'AGENTS.md', desc: '通用的 AI 代理约定文件' },
  { file: 'CLAUDE.md', desc: 'Claude Code 的项目说明' },
  { file: '.edict/rules.md', desc: 'Edict 专用的项目规约' },
];
const RULES_TEMPLATE = `# 项目规约

写给 Edict 官员看的本项目约定：规划、审议、执行时都会读到。

- 代码风格：
- 测试命令：
- 不要动的目录：
`;

/** Split projectRules().text (〔file〕 blocks) into a preview per file. */
function previews(r: { files: string[]; text: string }): Record<string, string> {
  const marks: { file: string; start: number; end: number }[] = [];
  const re = /〔([^〕\n]+)〕\n/g;
  for (let m = re.exec(r.text); m; m = re.exec(r.text)) if (r.files.includes(m[1])) marks.push({ file: m[1], start: m.index, end: re.lastIndex });
  const out: Record<string, string> = {};
  marks.forEach((mk, i) => (out[mk.file] = r.text.slice(mk.end, marks[i + 1]?.start).trim()));
  return out;
}

type Draft = { kind: CanonKind; text: string; keywords: string; scope: 'ws' | 'all' };
const emptyDraft = (ws: string | null): Draft => ({ kind: 'rule', text: '', keywords: '', scope: ws ? 'ws' : 'all' });
const splitKw = (s: string) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);

function KindPicker({ value, onChange, name }: { value: CanonKind; onChange: (k: CanonKind) => void; name: string }) {
  return (
    <div className="canonp-kinds" role="radiogroup" aria-label={name}>
      {KINDS.map((k) => (
        <button key={k.id} type="button" role="radio" aria-checked={value === k.id} className={`canonp-kpill k-${k.id} ${value === k.id ? 'on' : ''}`} onClick={() => onChange(k.id)} data-testid={`canon-kind-${k.id}`}>
          {k.label}
        </button>
      ))}
    </div>
  );
}

/** The add / edit form (kind, text ≤ 600, keywords, scope). */
function CanonForm({ draft, setDraft, ws, onSubmit, onCancel, submitLabel, busy, testids }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  ws: string | null;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
  busy?: boolean;
  testids?: boolean;
}) {
  const forbid = draft.kind === 'forbid';
  const hint = KINDS.find((k) => k.id === draft.kind)!.hint;
  return (
    <div className="canonp-form">
      <div className="canonp-form-top">
        <KindPicker value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} name="类别" />
        <span className="canonp-hint">{hint}</span>
      </div>
      <textarea
        className="input canonp-ta"
        rows={2}
        maxLength={600}
        value={draft.text}
        placeholder={forbid ? '例如：不要改动 migrations/ 目录里已发布的迁移文件' : '例如：前端组件用函数组件 + hooks，样式写在同目录的 .css 里'}
        aria-label="典章内容"
        data-testid={testids ? 'canon-text' : undefined}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <div className="canonp-form-row">
        <label className="canonp-field grow">
          <span>关键词</span>
          <input
            className="input"
            value={forbid ? '' : draft.keywords}
            disabled={forbid}
            placeholder={forbid ? '「禁止」每道旨意都带上，不看关键词' : '逗号分隔，如：登录, 表单；留空 = 每道旨意都带上'}
            aria-label="关键词"
            data-testid={testids ? 'canon-keywords' : undefined}
            onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
          />
        </label>
        <label className="canonp-field">
          <span>范围</span>
          <select className="input" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as Draft['scope'] })} aria-label="范围" data-testid={testids ? 'canon-scope' : undefined}>
            {ws && <option value="ws">本工作区（{baseName(ws)}）</option>}
            <option value="all">所有工作区</option>
          </select>
        </label>
        <span className={`canonp-count ${draft.text.length >= 560 ? 'near' : ''}`}>{draft.text.length}/600</span>
        {onCancel && <button className="btn sm" onClick={onCancel}>取消</button>}
        <button className="btn primary sm" disabled={!draft.text.trim() || busy} onClick={onSubmit} data-testid={testids ? 'canon-add' : 'canon-save'}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function CanonPage() {
  const canon = useStore((s) => s.settings.canon) ?? [];
  const ws = useStore((s) => s.workspace);
  const tasks = useStore((s) => s.tasks);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const [rules, setRules] = useState<{ files: string[]; text: string } | null>(null);
  const [kindF, setKindF] = useState<CanonKind | 'all'>('all');
  const [scopeF, setScopeF] = useState<'all' | 'ws' | 'global'>('all');
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(ws));
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!ws) return setRules(null);
    call<{ files: string[]; text: string }>('projectRules').then((r) => live && setRules(r)).catch(() => live && setRules({ files: [], text: '' }));
    return () => {
      live = false;
    };
  }, [ws, fsVersion]);
  useEffect(() => setDraft((d) => (ws ? d : { ...d, scope: 'all' })), [ws]);
  const pv = useMemo(() => (rules ? previews(rules) : {}), [rules]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: canon.length };
    for (const e of canon) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [canon]);
  const list = useMemo(
    () =>
      canon
        .filter((e) => kindF === 'all' || e.kind === kindF)
        .filter((e) => scopeF === 'all' || (scopeF === 'ws' ? !!ws && e.root === ws : !e.root))
        .slice()
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.at - a.at),
    [canon, kindF, scopeF, ws],
  );

  const createRules = async () => {
    const f = '.edict/rules.md';
    try {
      await call('createFile', f);
      await call('writeFile', f, RULES_TEMPLATE);
    } catch (e) {
      if (!/已存在/.test((e as Error).message)) return toast((e as Error).message, 'error');
    }
    openFile(f, false);
  };

  const add = async () => {
    if (!draft.text.trim() || busy) return;
    setBusy(true);
    try {
      await call('canonAdd', { kind: draft.kind, text: draft.text, keywords: draft.kind === 'forbid' ? [] : splitKw(draft.keywords), root: draft.scope === 'ws' ? ws : null });
      toast(`已立为典章（${KIND_LABEL[draft.kind]}）`, 'success');
      setDraft({ ...emptyDraft(ws), kind: draft.kind, scope: draft.scope });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (e: CanonEntry) => setEditing({ id: e.id, draft: { kind: e.kind, text: e.text, keywords: e.keywords.join(', '), scope: e.root ? 'ws' : 'all' } });
  const saveEdit = async (e: CanonEntry) => {
    if (!editing) return;
    const d = editing.draft;
    // keep another workspace's scope as it was unless the emperor switched it to 所有工作区
    const root = d.scope === 'all' ? null : e.root && e.root !== ws ? e.root : ws;
    try {
      await call('canonUpdate', e.id, { kind: d.kind, text: d.text, keywords: d.kind === 'forbid' ? [] : splitKw(d.keywords), root });
      setEditing(null);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async (e: CanonEntry) => {
    if (!(await askConfirm('删除这条典章？', `「${e.text.length > 60 ? `${e.text.slice(0, 60)}…` : e.text}」删除后，之后的旨意不再带上它。`, { ok: '删除', danger: true }))) return;
    try {
      await call('canonRemove', e.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const toggle = (e: CanonEntry, on: boolean) => call('canonUpdate', e.id, { enabled: on }).catch((err) => toast((err as Error).message, 'error'));

  const scopeLabel = (e: CanonEntry) => (!e.root ? '通用' : e.root === ws ? '本工作区' : baseName(e.root));
  const hasRules = !!rules?.files.length;

  return (
    <Page
      icon="rules"
      title="典章"
      lead="你立下的长期规矩。中书规划、门下审议、六部执行时，都会把相关的典章和项目规约一并交给官员。「禁止」每道旨意都带上；其余条目写了关键词的，旨意里提到才带上，没写就每道都带。"
      testid="settings-canon"
    >
      <div className="canonp">
        <Sec
          title="项目规约"
          note={ws ? `· ${baseName(ws)} 里的规约文件，每道旨意都会读到（合计约 4000 字）` : '· 工作区里的规约文件'}
          right={hasRules ? <Badge tone="ok">已生效 {rules!.files.length} 个</Badge> : ws ? <Badge tone="off">未找到规约文件</Badge> : undefined}
        >
          {!ws ? (
            <div className="sp-empty">打开工作区后，这里会列出项目里的 AGENTS.md、CLAUDE.md 和 .edict/rules.md。</div>
          ) : (
            <div className="canonp-files">
              {RULE_FILES.map(({ file, desc }) => {
                const on = !!rules?.files.includes(file);
                const text = pv[file] ?? '';
                return (
                  <div key={file} className={`canonp-file ${on ? 'on' : ''}`} data-testid={`rules-file-${file}`}>
                    <div className="canonp-file-h">
                      <Icon name="file" size={13} />
                      <code>{file}</code>
                      {on ? <Badge tone="ok">生效中</Badge> : <span className="canonp-none">未创建</span>}
                    </div>
                    {on ? <div className="canonp-pv">{text.replace(/\n\s*\n+/g, '\n').slice(0, 220)}</div> : <div className="canonp-pv empty">{desc}</div>}
                    <div className="canonp-file-a">
                      {on ? (
                        <button className="btn sm" onClick={() => openFile(file, false)} data-testid={`rules-open-${file}`}><Icon name="external" size={12} /> 在编辑器打开</button>
                      ) : file === '.edict/rules.md' ? (
                        <button className="btn sm" onClick={() => void createRules()} data-testid="canon-create-rules"><Icon name="plus" size={12} /> 新建</button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Sec>

        <Sec title="立新规" note="· 一条一件事，最多 600 字">
          <CanonForm draft={draft} setDraft={setDraft} ws={ws} onSubmit={() => void add()} submitLabel="立为典章" busy={busy} testids />
        </Sec>

        <Sec title={<>典章 <span className="canonp-n">{canon.length}</span></>} note="· 关掉的条目保留，但不再交给官员">
          <div className="canonp-filters">
            <div className="canonp-fg" role="group" aria-label="按类别筛选">
              <span className="canonp-fl">类别</span>
              {(['all', ...KINDS.map((k) => k.id)] as const).map((k) => (
                <button key={k} className={`pill ${kindF === k ? 'on' : ''}`} onClick={() => setKindF(k)} data-testid={`canon-filter-${k}`}>
                  {k === 'all' ? '全部' : KIND_LABEL[k]} <span className="canonp-pc">{counts[k] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="canonp-fg" role="group" aria-label="按范围筛选">
              <span className="canonp-fl">范围</span>
              {([['all', '全部'], ['ws', '本工作区'], ['global', '通用']] as const).map(([k, l]) => (
                <button key={k} className={`pill ${scopeF === k ? 'on' : ''}`} onClick={() => setScopeF(k)} disabled={k === 'ws' && !ws} data-testid={`canon-scope-${k}`}>{l}</button>
              ))}
            </div>
          </div>
          {list.length === 0 ? (
            <div className="sp-empty" data-testid="canon-empty">
              {canon.length === 0 ? '还没有典章。在上面立一条，或在旨意详情的审议记录里把封驳意见「收入典章」。' : '没有符合筛选条件的典章。'}
            </div>
          ) : (
            <div className="canonp-list">
              {list.map((e) =>
                editing?.id === e.id ? (
                  <div key={e.id} className="canonp-row editing" data-testid={`canon-row-${e.id}`}>
                    <CanonForm draft={editing.draft} setDraft={(d) => setEditing({ id: e.id, draft: d })} ws={ws} onSubmit={() => void saveEdit(e)} onCancel={() => setEditing(null)} submitLabel="保存" />
                  </div>
                ) : (
                  <div key={e.id} className={`canonp-row ${e.enabled ? '' : 'off'}`} data-testid={`canon-row-${e.id}`}>
                    <span className={`canonp-kind k-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                    <div className="canonp-body">
                      <div className="canonp-text">{e.text}</div>
                      <div className="canonp-meta">
                        {e.kind === 'forbid' || !e.keywords.length ? (
                          <span className="canonp-kw every">每道旨意</span>
                        ) : (
                          e.keywords.map((k) => <span key={k} className="canonp-kw">{k}</span>)
                        )}
                        <span className="canonp-sep" />
                        <span className="canonp-scope" {...(e.root ? tip(e.root) : {})}>
                          <Icon name={e.root ? 'folder' : 'globe'} size={11} /> {scopeLabel(e)}
                        </span>
                        {e.source && (
                          <>
                            <span className="canonp-sep" />
                            {tasks.some((t) => t.id === e.source!.taskId) ? (
                              <button className="canonp-srclink" onClick={() => openTaskTab(e.source!.taskId)} {...tip('打开这道旨意')}>
                                <Icon name="scroll" size={11} /> {e.source.label}
                              </button>
                            ) : (
                              <span className="canonp-src"><Icon name="scroll" size={11} /> {e.source.label}</span>
                            )}
                          </>
                        )}
                        <span className="canonp-sep" />
                        <span className="canonp-at">{fmtStamp(e.at)}</span>
                      </div>
                    </div>
                    <div className="canonp-ctl">
                      <Toggle on={e.enabled} onChange={(v) => void toggle(e, v)} label={e.enabled ? '停用这条典章' : '启用这条典章'} testid={`canon-toggle-${e.id}`} />
                      <button className="icon-btn" onClick={() => startEdit(e)} {...tip('修改')} data-testid={`canon-edit-${e.id}`}><Icon name="edit" size={13} /></button>
                      <button className="icon-btn danger" onClick={() => void remove(e)} {...tip('删除')} data-testid={`canon-del-${e.id}`}><Icon name="trash" size={13} /></button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </Sec>
      </div>
    </Page>
  );
}
