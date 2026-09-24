// ⌘P / ⇧⌘P — quick open files and run commands.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, setUI, openPanel, type PanelId } from '../store';
import { call } from '../api';
import { openFile } from './Explorer';

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.ui.palette);
  const ws = useStore((s) => s.workspace);
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    setTimeout(() => input.current?.focus(), 10);
    if (ws) call<string[]>('listFiles').then(setFiles).catch(() => setFiles([]));
  }, [open, ws]);
  const commands: Item[] = useMemo(() => {
    const panels: [PanelId, string][] = [['kanban', '旨意看板'], ['monitor', '省部调度'], ['memorials', '奏折阁'], ['templates', '旨库'], ['officials', '官员总览'], ['news', '天下要闻'], ['models', '模型配置'], ['skills', '技能与 MCP'], ['sessions', '小任务 Sessions'], ['ceremony', '上朝仪式'], ['debate', '朝堂议政'], ['audit', '审计日志'], ['help', '使用说明']];
    return [
      { label: '> 切换 工作台 / 朝堂', hint: '⌘J', run: () => setUI((u) => ({ mode: u.mode === 'court' ? 'workbench' : 'court' })) },
      { label: '> 打开工作区文件夹', hint: '⌘O', run: () => void call('openFolder') },
      { label: '> 显示/隐藏 终端', hint: '⌃`', run: () => setUI((u) => ({ bottomOpen: !u.bottomOpen, bottomTab: 'terminal' })) },
      { label: '> 上朝仪式', run: () => setUI({ ceremony: true }) },
      ...panels.map(([id, l]) => ({ label: `> 军机处：${l}`, run: () => openPanel(id) })),
    ];
  }, []);
  if (!open) return null;
  const isCmd = q.startsWith('>');
  const needle = q.replace(/^>\s*/, '').toLowerCase();
  const items: Item[] = isCmd || !ws
    ? commands.filter((c) => c.label.toLowerCase().includes(needle))
    : files
        .filter((f) => fuzzy(f.toLowerCase(), needle))
        .slice(0, 60)
        .map((f) => ({ label: f.split('/').pop()!, hint: f, run: () => openFile(f, false) }));
  const close = () => setUI({ palette: false });
  return (
    <div className="modal-backdrop top" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder={ws ? '搜索文件；输入 > 执行命令' : '> 输入命令'}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setSel((s) => Math.min(items.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter' && items[sel]) {
              items[sel].run();
              close();
            }
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <div key={i} className={`palette-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => { it.run(); close(); }}>
              <span>{it.label}</span>
              {it.hint && <span className="muted small">{it.hint}</span>}
            </div>
          ))}
          {!items.length && <div className="muted pad small">无匹配</div>}
        </div>
      </div>
    </div>
  );
}

function fuzzy(hay: string, needle: string) {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}
