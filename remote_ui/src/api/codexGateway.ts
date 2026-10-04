// Only browser-local image preparation is needed by the reused composer.
// All Codex operations go through LanPower's authenticated relay.
import { connection } from '../lanpower/connection'
import { compressImageUrl, MAX_IMAGE_URL_LENGTH } from '../lanpower/submissionImages'
export type ComposerFileSuggestion = { path: string }
export type ComposerPromptInfo = { name: string; path: string; content: string; description: string }
export async function getComposerPrompts(): Promise<ComposerPromptInfo[]> { return [] }
export async function createComposerPrompt(_name: string, _content: string): Promise<ComposerPromptInfo | null> { throw new Error('请在电脑上管理自定义提示。') }
export async function removeComposerPrompt(_path: string): Promise<boolean> { throw new Error('请在电脑上管理自定义提示。') }
export async function searchComposerFiles(cwd: string, query: string, limit: number): Promise<ComposerFileSuggestion[]> { if (!cwd || !query.trim()) return []; const result = await connection.request('lanpower/files/search', { cwd, query: query.trim().slice(0,256) }); return (result.data || []).slice(0,limit).map((file:any) => ({path:file.fsPath})) }
export async function updateThreadFileChanges(_threadId: string, _turnId: string, _cwd: string, _action: 'undo' | 'redo', _patchIds?: string[], _scope?: string): Promise<{ changed: number; errors: string[]; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> { throw new Error('请在原 Codex 窗口撤销文件修改。') }

export async function uploadFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请添加不超过 20 MB 的图片，电脑文件请在原窗口添加。')
  const original = await new Promise<string>((resolve,reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败，请重新选择。')); reader.readAsDataURL(file)
  })
  return compressImageUrl(original, MAX_IMAGE_URL_LENGTH)
}
