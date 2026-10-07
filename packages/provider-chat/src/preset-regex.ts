import type { TextRule } from './preset.ts'
export interface TextJob { text: string; stage: TextRule['stage']; target: 'speech' | 'narration'; rules: readonly TextRule[]; inspect?: boolean }
/** Static worker program shared by Node and browser preview. Data is never evaluated as code. */
export const REGEX_WORKER_PROGRAM = String.raw`
const run = jobs => jobs.map(job => {
  let text = job.text;
  if (typeof text !== 'string' || text.length > 64000) throw new Error('待处理文本最多 64000 字符');
  const trace = [];
  for (const rule of job.rules) {
    if (!rule.enabled || rule.stage !== job.stage || (rule.target !== 'both' && rule.target !== job.target)) continue;
    text = text.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
    if (text.length > 64000) throw new Error('文本规则输出超过 64000 字符：' + rule.name);
    if (job.inspect) trace.push({id:rule.id, name:rule.name, text});
  }
  return {text, trace};
});
`
export interface TextResult { text: string; trace: { id: string; name: string; text: string }[] }
