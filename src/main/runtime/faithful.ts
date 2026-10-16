// 忠于旨意: rules every stage reads (plan, review, the ministries, 对照检查) so the work stays on what the emperor
// asked for. A story edict once drifted: the planner swapped the asked-for focus for its own defaults, turned
// 「1万字」 into a hard ≥10000 count and added a re-verification report as a requirement, and the make-up rounds
// went on until the step timed out. A word count in the edict is a target, not a floor, unless the edict says so;
// paperwork is never a deliverable unless asked for; a writing edict is written by one ministry, chapter by chapter.
import type { Task } from '../../shared/types';

export interface Quantity {
  /** as written in the edict, e.g. 「1万字」 */
  text: string;
  n: number;
  unit: string;
  /** 「至少 / 不少于 / 以上」: a real lower bound */
  floor: boolean;
}

const CN_DIGIT: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
const QTY = /(至少|不少于|不低于|最少|起码|不能少于)?\s*(?:约|大约|大概|差不多)?\s*(\d+(?:\.\d+)?|[一两二三四五六七八九十半])\s*(万|千|百)?\s*(字|词|单词)(以上|左右|上下)?/g;

/** Word counts the edict asks for (「1万字」「约3000字」「不少于五千字」). */
export function quantities(edict: string): Quantity[] {
  const out: Quantity[] = [];
  // 「一万五千字」「1万5千字」 → one number
  const num = (x: string) => (/\d/.test(x) ? Number(x) : CN_DIGIT[x]);
  const text = edict.replace(/(\d+|[一两二三四五六七八九十])万([一两二三四五六七八九]|\d)千/g, (_, w: string, k: string) => String(num(w) * 10000 + num(k) * 1000));
  for (const m of text.matchAll(QTY)) {
    const base = num(m[2]);
    const n = Math.round(base * (m[3] === '万' ? 10000 : m[3] === '千' ? 1000 : m[3] === '百' ? 100 : 1));
    if (!Number.isFinite(n) || n < 50) continue; // 「三个字」「一词」 are not a length target
    out.push({ text: m[0].trim(), n, unit: m[4], floor: !!m[1] || m[5] === '以上' });
  }
  return out;
}

/** The accepted range for a count that is a target, not a floor (±15%). */
export const approxRange = (n: number): [number, number] => [Math.round(n * 0.85), Math.round(n * 1.15)];

const WRITING = /小说|故事|网文|同人|短篇|长篇|散文|诗歌|写诗|剧本|文案|黄文|爽文|续写|仿写|写一篇|写篇|写一部|写一章|创作/;
const TECH = /代码|函数|接口|报错|bug|仓库|测试用例|README|API|脚本|组件|页面|编译|部署/i;

/** A creative-writing edict (a story, an article, a script) rather than code or technical docs. */
export const isWriting = (edict: string) => WRITING.test(edict) && !TECH.test(edict);

const INVITE = /(可以|可|请|欢迎|尽管|直接)?(先)?(问我|问清楚?|问一下|问问|向我(确认|询问|请教|问))|先(问|确认)[^。！？\n]{0,8}再|有(疑问|不清楚|不明白)[^。！？\n]{0,8}(问|说)/;

/** The emperor said to ask first when unsure (「不清楚可以问我」「先问清楚再写」). */
export const invitesQuestions = (edict: string) => INVITE.test(edict);

/** 【忠于旨意】 for every prompt that plans, reviews, does or checks the work. */
export function faithBlock(t: Pick<Task, 'edict'>): string {
  const lines = [
    '【忠于旨意】',
    '- 旨意的重点以皇上原话为准。方案、默认设定、验收标准都不能改变或冲淡它。',
    '- 硬要求只有这些：旨意原话里的核心内容；写明「必须」「不要」「至少」的要求；问答纪要里皇上定下的决定。其余细节可以合理发挥，只要服务于重点。',
    '- 和旨意字面不一样、但没有违背硬要求的地方，在结论的 deviations（与旨意的出入）里写明理由，不算违旨，也不因此返工。',
    '- 验收只看成品是否满足硬要求。验收报告、复验记录、需求说明文件这类流程文书，旨意没要就不是交付物，不能写成验收标准，也不能因为它没写好而返工。',
  ];
  for (const q of quantities(t.edict)) {
    if (q.floor) lines.push(`- 旨意要求「${q.text}」：这是下限，${q.n} ${q.unit}以上即达标，不必远超。`);
    else {
      const [lo, hi] = approxRange(q.n);
      lines.push(`- 旨意里的「${q.text}」是约数：${lo}~${hi} ${q.unit}都算达标。不要改成硬下限，不要为凑数注水，也不要为差几百${q.unit}返工。`);
    }
  }
  if (isWriting(t.edict))
    lines.push(
      '【写作类旨意】',
      '- 交一个部（礼部）直接写成品，不另设验收子任务；对照检查就是验收。',
      '- 皇上点名要写的内容就是正文主体，占大部分篇幅；背景、人物、故事线为它服务，不要喧宾夺主。',
      '- 长文按章分次写：一次写一章，写完追加到同一个文件，再写下一章；不要整篇写完后再反复 edit_file 修改。',
      '- 不要重复已经写过的段落、对话或句子。',
      '- 返工只改对照检查指出的问题，不推翻重写。',
    );
  return lines.join('\n');
}
