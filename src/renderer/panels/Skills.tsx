// 技能配置 · Skills
import { useEffect, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENTS, agentName } from '../../shared/court';
import type { AgentId } from '../../shared/types';

export function Skills() {
  const skills = useStore((s) => s.skills);
  const [sel, setSel] = useState<string | null>(skills[0]?.name ?? null);
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'view' | 'new' | 'remote'>('view');
  useEffect(() => {
    if (sel && mode === 'view') call<string>('skillRead', sel).then(setContent).catch(() => setContent(''));
  }, [sel, mode, skills]);
  const cur = skills.find((s) => s.name === sel);
  return (
    <div className="panel split-panel">
      <div className="split-list">
        <div className="panel-head"><h2><Icon name="sparkles" size={18} /> 技能配置</h2></div>
        {skills.map((s) => (
          <div key={s.name} className={`list-item ${sel === s.name && mode === 'view' ? 'on' : ''}`} onClick={() => { setSel(s.name); setMode('view'); }}>
            <b>{s.name}</b> <span className="chip chip-sm">{s.source}</span>
            <div className="muted small">{s.description}</div>
            <div className="muted small">授予：{s.agents === 'all' ? '全体官员' : s.agents.map(agentName).join('、')}</div>
          </div>
        ))}
        <div className="row-gap pad">
          <button className="btn sm" onClick={() => setMode('new')}><Icon name="plus" size={12} /> 本地技能</button>
          <button className="btn sm" onClick={() => setMode('remote')}><Icon name="external" size={12} /> 远程技能</button>
        </div>
      </div>
      <div className="split-detail">
        {mode === 'view' && cur && (
          <div className="card">
            <div className="row-gap">
              <h3>{cur.name}</h3>
              <span style={{ flex: 1 }} />
              <button className="btn sm danger" onClick={async () => { if (await call<boolean>('confirm', `删除技能 ${cur.name}？`)) { await call('skillRemove', cur.name); setSel(null); } }}>删除</button>
            </div>
            {cur.sourceUrl && <div className="muted small">来源：{cur.sourceUrl}</div>}
            <pre className="skill-content">{content}</pre>
          </div>
        )}
        {mode === 'new' && <SkillForm remote={false} onDone={(n) => { setMode('view'); setSel(n); }} />}
        {mode === 'remote' && <SkillForm remote onDone={(n) => { setMode('view'); setSel(n); }} />}
      </div>
    </div>
  );
}

function SkillForm({ remote, onDone }: { remote: boolean; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [agents, setAgents] = useState<AgentId[] | 'all'>('all');
  const [content, setContent] = useState('# 技能说明\n\n');
  const [url, setUrl] = useState('');
  const toggle = (id: AgentId) => setAgents((a) => (a === 'all' ? [id] : a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const save = async () => {
    if (!name.trim()) return toast('请填写名称', 'warn');
    try {
      if (remote) await call('skillAddRemote', { name, url, description: desc, agents });
      else await call('skillSave', { name, description: desc, agents, content });
      toast('技能已添加', 'success');
      onDone(name.trim().toLowerCase());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card">
      <h3>{remote ? '添加远程技能（SKILL.md 链接）' : '新建本地技能'}</h3>
      <div className="form-grid">
        <label>名称</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 api-design" />
        <label>描述</label><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        {remote && (<><label>链接</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/SKILL.md（仅 https）" /></>)}
        <label>授予官员</label>
        <div className="row-gap wrap">
          <label className="chk small"><input type="checkbox" checked={agents === 'all'} onChange={(e) => setAgents(e.target.checked ? 'all' : [])} /> 全体</label>
          {AGENTS.map((a) => <label key={a.id} className="chk small"><input type="checkbox" checked={agents !== 'all' && agents.includes(a.id)} onChange={() => toggle(a.id)} /> {a.name}</label>)}
        </div>
      </div>
      {!remote && <textarea className="input mono" rows={14} value={content} onChange={(e) => setContent(e.target.value)} />}
      <div className="row-gap"><span style={{ flex: 1 }} /><button className="btn primary" onClick={save}>保存</button></div>
    </div>
  );
}
