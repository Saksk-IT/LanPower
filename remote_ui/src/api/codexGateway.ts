// Only browser-local image preparation is needed by the reused composer.
// All Codex operations go through LanPower's authenticated relay.
import { connection } from '../lanpower/connection'
import { IMAGE_DATA_URL } from '../lanpower/submissionImages'
export type ComposerFileSuggestion = { path: string }
export type ComposerPromptInfo = { name: string; path: string; content: string; description: string }
export async function getComposerPrompts(): Promise<ComposerPromptInfo[]> { return [] }
export async function createComposerPrompt(_name: string, _content: string): Promise<ComposerPromptInfo | null> { throw new Error('请在电脑上管理自定义提示。') }
export async function removeComposerPrompt(_path: string): Promise<boolean> { throw new Error('请在电脑上管理自定义提示。') }
export async function searchComposerFiles(cwd: string, query: string, limit: number): Promise<ComposerFileSuggestion[]> { if (!cwd || !query.trim()) return []; const result = await connection.request('lanpower/files/search', { cwd, query: query.trim() }); return (result.data || []).slice(0,limit).map((file:any) => ({path:file.fsPath})) }
export async function updateThreadFileChanges(_threadId: string, _turnId: string, _cwd: string, _action: 'undo' | 'redo', _patchIds?: string[], _scope?: string): Promise<{ changed: number; errors: string[]; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> { throw new Error('请在原 Codex 窗口撤销文件修改。') }

export async function uploadFile(file: File, cwd?: string): Promise<string> {
  const original = await new Promise<string>((resolve,reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('附件读取失败，请重新选择。')); reader.readAsDataURL(file)
  })
  if (IMAGE_DATA_URL.test(original)) return original
  if (!cwd) throw new Error('请先选择目标电脑上的项目。')
  const result = await connection.request('lanpower/files/upload', {cwd,name:file.name,base64:original.slice(original.indexOf(',') + 1)})
  if (typeof result.path !== 'string' || !result.path) throw new Error('文件上传未完成，请重试。')
  return result.path
}
