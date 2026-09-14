import { useEffect, useMemo, useState } from 'react';
import { FileCode2, FolderOpen, GitBranch, LoaderCircle, Play, RefreshCw, Square, TestTube2 } from 'lucide-react';
import { api, type TaskWorkspaceData, type WorkspaceTestRun } from '../api';
import { isEdict, useStore, stateLabel } from '../store';

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function runLabel(run: WorkspaceTestRun | null | undefined): string {
  if (!run) return '尚未运行测试';
  if (run.status === 'running') return '测试运行中';
  if (run.status === 'passed') return '测试通过';
  if (run.status === 'timeout') return '测试超时';
  if (run.status === 'cancelled') return '测试已停止';
  return '测试失败';
}

export default function ExecutionInspector() {
  const liveStatus = useStore((state) => state.liveStatus);
  const toast = useStore((state) => state.toast);
  const tasks = useMemo(
    () => (liveStatus?.tasks || []).filter((task) => task.projectPath),
    [liveStatus],
  );
  const [selectedId, setSelectedId] = useState('');
  const [data, setData] = useState<TaskWorkspaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [commandId, setCommandId] = useState('');
  const commands = data?.testCommands?.filter((command) => command.id !== 'no-detected-test') || [];
  const selectedCommand = commands.find((command) => command.id === commandId)?.id || commands[0]?.id;
  const reveal = async (path: string) => {
    try {
      const result = await window.edictDesktop?.revealProjectFile?.(path);
      if (!result?.ok) toast(result?.error || '请在桌面端定位文件', 'err');
    } catch { toast('无法定位文件，请确认文件仍存在', 'err'); }
  };

  useEffect(() => {
    if (selectedId && tasks.some((task) => task.id === selectedId)) return;
    setSelectedId(tasks[0]?.id || '');
  }, [selectedId, tasks]);

  const refresh = async (quiet = false) => {
    if (!selectedId) {
      setData(null);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      setData(await api.taskWorkspace(selectedId));
    } catch (reason) {
      if (!quiet) toast(reason instanceof Error ? reason.message : '执行详情读取失败', 'err');
      setData(null);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    if (!selectedId) return;
    const timer = window.setInterval(() => void refresh(true), 3000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  const runTest = async () => {
    if (!selectedId || running) return;
    setRunning(true);
    try {
      if (!selectedCommand) return;
      const result = await api.runTaskTest(selectedId, selectedCommand);
      if (!result.ok) toast(result.error || '测试未能启动', 'err');
      else toast(result.message || '测试已启动');
      await refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '测试启动失败', 'err');
    } finally {
      setRunning(false);
    }
  };

  const cancelTest = async () => {
    const run = data?.latestTest;
    if (!run || run.status !== 'running') return;
    if (running) return;
    setRunning(true);
    try {
      const result = await api.cancelTaskTest(run.id);
      if (result.ok) toast(result.message || '已请求停止测试');
      else toast(result.error || '停止测试失败', 'err');
      await refresh();
    } catch { toast('停止请求失败，请重试', 'err'); }
    finally { setRunning(false); }
  };

  return (
    <aside className="execution-inspector" aria-label="当前任务执行详情">
      <div className="inspector-heading">
        <span>执行详情</span>
        <button className="inspector-icon-button" type="button" onClick={() => void refresh()} disabled={loading || !selectedId} aria-label="刷新执行详情" title="刷新执行详情">
          {loading ? <LoaderCircle className="guard-spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="execution-inspector-kicker">任务与成果（含历史）</div>
      {tasks.length > 0 ? (
        <div className="execution-task-list">
          {tasks.map((task) => (
            <button key={task.id} type="button" className={selectedId === task.id ? 'selected' : ''} onClick={() => setSelectedId(task.id)}>
              <small>{task.id}</small>
              <strong>{task.title || '(无标题)'}</strong>
              <span>{isEdict(task) ? '旨意' : '小任务'} · {stateLabel(task)}{task.archived ? ' · 已归档' : ''}</span>
            </button>
          ))}
        </div>
      ) : <p className="inspector-empty">暂无绑定项目的任务。先从运行页向太子下达一条指令。</p>}

      {data?.task && <>
        <section className="execution-inspector-section" aria-labelledby="execution-current-title">
          <div className="execution-inspector-section-title" id="execution-current-title">阶段与权限</div>
          <div className="execution-current-state">
            <strong>{data.task.org || data.task.state}</strong>
            <span>{data.task.state} · {data.task.targetAgent || '等待明确 Agent'}</span>
          </div>
          <p className="execution-scope"><span>审批方式</span>{data.permission?.mode === 'ask' ? '执行前询问' : data.permission?.mode === 'auto' ? '自动批准' : '完全访问'} · 当前项目范围</p>
          <p className="execution-scope" title={data.projectPath}><FolderOpen size={13} />{data.projectPath || '未绑定项目'}</p>
          {data.task.now && <p className="execution-now">{data.task.now}</p>}
          {data.task.block && data.task.block !== '无' && <p className="execution-block">{data.task.block}</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-changes-title">
          <div className="execution-inspector-section-title" id="execution-changes-title"><GitBranch size={13} />Git 变更</div>
          {data.git?.available ? <>
            <p className="execution-branch">{data.git.branch || '未命名分支'}</p>
            <p className="execution-summary">{data.git.summary || '工作区干净'}</p>
            {data.git.changedFiles.length > 0 ? <ul className="execution-file-list">{data.git.changedFiles.map((file) => <li key={file}><FileCode2 size={12} />{file}</li>)}</ul> : <p className="inspector-empty">暂无未提交变更</p>}
          </> : <p className="inspector-empty">{data.git?.summary || '当前目录不是 Git 仓库'}</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-output-title">
          <div className="execution-inspector-section-title" id="execution-output-title">产出文件</div>
          <p className="execution-output-path" title={data.outputDir}>{data.outputDir || 'Edict_Output/任务ID'}</p>
          {window.edictDesktop?.revealProjectFile && <button className="btn btn-g" onClick={() => void reveal(data.outputDir)}>定位输出目录</button>}
          {data.artifacts.length > 0 ? <ul className="execution-file-list">{data.artifacts.map((file) => <li key={file.path}><FileCode2 size={12} /><button className="command-link" title={file.path} disabled={!window.edictDesktop?.revealProjectFile} onClick={() => void reveal(`${data.projectPath}/${file.path}`)}>{file.name}</button><small>{formatSize(file.size)}</small></li>)}</ul> : <p className="inspector-empty">Agent 尚未在输出目录产生文件。</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-test-title">
          <div className="execution-inspector-section-title" id="execution-test-title"><TestTube2 size={13} />快速测试</div>
          <div className="execution-test-actions">
            {commands.length ? <select aria-label="选择测试命令" value={selectedCommand} onChange={(event) => setCommandId(event.target.value)}>{commands.map((command) => <option key={command.id} value={command.id}>{command.label}</option>)}</select> : <span>未检测到测试命令，请先在项目配置测试脚本</span>}
            {data.latestTest?.status === 'running' ? <button className="btn btn-danger" type="button" disabled={running} onClick={() => void cancelTest()}><Square size={12} />{running ? '正在停止…' : '停止'}</button> : <button className="btn btn-g" type="button" disabled={running || !selectedCommand} onClick={() => void runTest()}>{running ? <LoaderCircle className="guard-spin" size={12} /> : <Play size={12} />}运行</button>}
          </div>
          {data.latestTest && <div className={`execution-test-result ${data.latestTest.status}`} role="status"><strong>{runLabel(data.latestTest)}</strong>{data.latestTest.exitCode !== null && data.latestTest.exitCode !== undefined && <span>退出码 {data.latestTest.exitCode}</span>}<pre>{data.latestTest.output || '等待测试输出…'}</pre></div>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-activity-title">
          <div className="execution-inspector-section-title" id="execution-activity-title">最近活动</div>
          {data.activity && data.activity.length > 0 ? <ul className="execution-activity-list">{data.activity.slice(-6).map((item, index) => <li key={`${item.at}-${index}`}><span>{item.agent || item.kind}</span><p>{item.text || item.remark || item.output || item.tool || '活动已记录'}</p></li>)}</ul> : <p className="inspector-empty">等待 Agent 写入活动。</p>}
        </section>
      </>}
    </aside>
  );
}
