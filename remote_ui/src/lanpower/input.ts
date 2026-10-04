import { RemoteError } from './connection'
import { IMAGE_DATA_URL } from './submissionImages'

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
  unicodeLength(text)
  if (payload.imageUrls.some(url => !IMAGE_DATA_URL.test(url))) reject('图片格式无效，请重新添加图片。')
  if (payload.skills.some(skill => !skill.name || !skill.path)) reject('技能名称或路径无效。')
  payload.skills.forEach(skill => { unicodeLength(skill.name); unicodeLength(skill.path) })
  const input = [...(text ? [{type:'text',text}] : []),...payload.imageUrls.map(url => ({type:'image',url})),...payload.skills.map(skill => ({type:'skill',...skill}))]
  if (!input.length) reject('请先输入内容或添加附件。')
  return input
}
