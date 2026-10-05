import { webSearchView } from '../../../mini_program/utils/codex/web-search.js'
export type NativeToolView = {kind:string;name:string;status:'inProgress'|'completed'|'failed'|'interrupted';input:string;result:string;error:string;unknown:boolean;webSearch?: {label:string;summary:string}}
export function publicToolPayload(value: any): any {
  if (Array.isArray(value)) return value.map(publicToolPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['encryptedContent','encrypted_content','reasoningContent','reasoning_content'].includes(key)
    && !(value.type === 'reasoning' && key === 'content')
    && !(value.type === 'contextCompaction' && !['id','type','status'].includes(key))).map(([key,part]) => [key,publicToolPayload(part)]))
}
function summary(value: any): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(publicToolPayload(value),null,2)
  return text.length > 600 ? text.slice(0,600) + '…（完整内容见详情）' : text
}
export function nativeToolView(item: any, turnStatus?: string): NativeToolView {
  const raw = publicToolPayload(item), type = String(raw.type), error = summary(raw.error)
  const kinds: Record<string,string> = {mcpToolCall:'MCP 工具',dynamicToolCall:'动态工具',webSearch:'网页搜索',collabAgentToolCall:'协作任务',contextCompaction:'上下文整理',enteredReviewMode:'开始审查',exitedReviewMode:'审查结果'}
  const search = type === 'webSearch' ? webSearchView(raw, turnStatus) : undefined
  const status = search ? search.status : raw.success === false || error || ['failed','error','declined'].includes(raw.status) ? 'failed'
    : raw.status === 'interrupted' ? 'interrupted'
    : ['inProgress','in_progress','running','started'].includes(raw.status) || !raw.status && raw.success === undefined && turnStatus === 'inProgress' ? 'inProgress' : 'completed'
  return {kind:kinds[type] || `会话条目（${type}）`,name:[raw.server,raw.tool || raw.toolName || raw.name].filter(v => typeof v === 'string').join(' / '),status,
    input:summary(raw.arguments ?? raw.query ?? raw.action ?? raw.prompt ?? raw.receiverThreadIds),
    result:type === 'contextCompaction' ? '已整理会话上下文；仅显示公开提示。' : summary(raw.result ?? raw.contentItems ?? raw.output ?? raw.text ?? raw.agentsStates),
    error,unknown:!kinds[type],...(search ? {webSearch: {label: search.label, summary: search.summary}} : {})}
}
