// 「查看原因」: why an edict is blocked, in plain words, with what to do about each cause.
import type { RunNode, Task } from './types';

export type FixAction = 'retry' | 'unblock' | 'open' | 'settings:permissions' | 'settings:providers' | 'settings:runtime';

export interface BlockCause {
  title: string;
  detail?: string;
  fixes: string[];
  /** a button that helps with this cause (besides 局部重试 / 打开旨意, which the dialog always offers) */
  action?: { id: FixAction; label: string };
  nodeId?: string;
}

const MODEL_ERR: Record<string, { title: string; fixes: string[]; action?: BlockCause['action'] }> = {
  auth: { title: 'API Key 无效或没有权限', fixes: ['到「设置 › 模型服务」检查这个服务的 API Key', '或在旨意详情里「换模型重试」'], action: { id: 'settings:providers', label: '打开模型服务' } },
  config: { title: '模型或接入方式不被支持', fixes: ['到「设置 › 模型服务」核对模型 id、协议和 base_url', '或在旨意详情里「换模型重试」'], action: { id: 'settings:providers', label: '打开模型服务' } },
  param: { title: '模型不接受发过去的参数（多半是思考档位）', fixes: ['在「设置 › 模型服务」里对这个模型点「检测思考档位」', '或把这道旨意的思考程度调低后重试'], action: { id: 'settings:providers', label: '打开模型服务' } },
  billing: { title: '模型服务的余额或额度不足', fixes: ['充值后点「局部重试」', '或在旨意详情里「换模型重试」'] },
  rate: { title: '模型服务限流', fixes: ['稍等一会儿再点「局部重试」', '同时跑的官员太多时，可在「设置 › 运行策略」调低并行数'], action: { id: 'settings:runtime', label: '打开运行策略' } },
  server: { title: '模型服务出错', fixes: ['点「局部重试」再试一次', '确认模型服务正在运行'] },
  network: { title: '连不上模型服务', fixes: ['检查网络和 base_url', '确认模型服务正在运行，然后「局部重试」'], action: { id: 'settings:providers', label: '打开模型服务' } },
  timeout: { title: '模型太久没有输出，请求超时', fixes: ['点「局部重试」', '模型第一次加载或上下文很长时会慢，多试一次通常就好'] },
  context: { title: '内容超出模型的上下文长度', fixes: ['换一个上下文更大的模型重试', '在「设置 › 模型服务」核对这个模型的上下文窗口', '或把旨意拆小一些'], action: { id: 'settings:providers', label: '打开模型服务' } },
};

function nodeCause(n: RunNode): BlockCause {
  const err = n.error ?? '';
  const tm = /超过单节点时限\s*(\d+)\s*分钟/.exec(err);
  if (tm)
    return {
      nodeId: n.id,
      title: `「${n.label}」超过单个子任务时限（${tm[1]} 分钟），被停下`,
      fixes: ['点「局部重试」，从这一步接着做', '这一步本来就要跑很久（比如写长文）时，到「设置 › 权限与审核 › 单个子任务时限」调大，0 = 不限'],
      action: { id: 'settings:permissions', label: '打开时限设置' },
    };
  if (n.exitStatus === 'rejected')
    return { nodeId: n.id, title: `「${n.label}」被皇上驳回`, fixes: ['点「局部重试」让这一步重做', '想换个做法，可以先在旨意里补充说明再重试'] };
  if (n.errorInfo) {
    const m = MODEL_ERR[n.errorInfo.kind];
    const where = [n.errorInfo.model ?? n.model, n.errorInfo.status ? `HTTP ${n.errorInfo.status}` : ''].filter(Boolean).join(' · ');
    return {
      nodeId: n.id,
      title: `「${n.label}」调用模型失败：${m?.title ?? '模型调用失败'}`,
      detail: [where, n.errorInfo.hint].filter(Boolean).join('。'),
      fixes: m?.fixes ?? ['点「局部重试」再试一次', '或在旨意详情里「换模型重试」'],
      action: m?.action,
    };
  }
  if (n.exitStatus === 'interrupted' || /应用重启|中断/.test(err))
    return { nodeId: n.id, title: `「${n.label}」被中断（应用重启或手动停止时它正在跑）`, detail: err || undefined, fixes: ['点「局部重试」，从这一步接着做'] };
  return { nodeId: n.id, title: `「${n.label}」执行失败`, detail: err || undefined, fixes: ['点「局部重试」再试一次', '反复失败时，打开旨意看这一步的详细记录'] };
}

/** Everything the 查看原因 window says about a blocked edict. */
export function explainBlock(t: Task): { reason: string; causes: BlockCause[]; failed: RunNode[] } {
  const reason = t.blockedReason ?? '旨意阻塞，等待处理';
  const failed = t.nodes.filter((n) => n.status === 'failed');
  const causes = failed.map(nodeCause);
  const waiting = /(\d+)\s*个子任务因依赖未完成而未启动/.exec(reason);
  if (waiting)
    causes.push({ title: `${waiting[1]} 个子任务在等前面失败的那一步`, fixes: ['不用单独处理：失败的那步重试成功后，它们会接着开工'] });
  if (!causes.length)
    causes.push({ title: reason, fixes: ['点「继续」让旨意接着推进', '还是卡住的话，打开旨意看详细记录'], action: { id: 'unblock', label: '继续' } });
  return { reason, causes, failed };
}
