import { RemoteError } from './connection'

export type SubmissionInput = {text:string;imageUrls:string[];skills:Array<{name:string;path:string}>;fileAttachments:Array<{label:string;fsPath:string}>}
export function unicodeLength(value: string): number {
  let length = 0
  for (const point of value) {
    if (point.length === 1 && /[\uD800-\uDFFF]/u.test(point)) throw new RemoteError('not_sent','输入包含无效字符，未发送，请修改后重试。')
    length++
  }
  return length
}
export function prepareSubmissionInput(payload: SubmissionInput): any[] {
  const text = payload.fileAttachments.length ? `# Files mentioned by the user:\n${payload.fileAttachments.map(file => `## ${file.label}: ${file.fsPath}`).join('\n')}\n\n## My request for Codex:\n${payload.text.trim()}` : payload.text.trim()
  const reject = (message: string): never => { throw new RemoteError('not_sent',`${message}未发送，草稿保留。`) }
  if (unicodeLength(text) > 16000) reject('文字与文件引用合计最多 16000 字符。')
  if (payload.imageUrls.length > 4 || payload.imageUrls.reduce((sum,url) => sum + url.length,0) > 850000 || payload.imageUrls.some(url => url.length > 700000 || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u.test(url))) reject('最多 4 张图片，每张最多 700000 字符，合计最多 850000 字符。')
  if (payload.skills.length > 8 || payload.skills.some(skill => !skill.name || unicodeLength(skill.name) > 120 || !skill.path || unicodeLength(skill.path) > 1000)) reject('最多 8 个技能，技能名称或路径无效。')
  const input = [...(text ? [{type:'text',text}] : []),...payload.imageUrls.map(url => ({type:'image',url})),...payload.skills.map(skill => ({type:'skill',...skill}))]
  if (!input.length) reject('请先输入内容或添加附件。')
  return input
}
