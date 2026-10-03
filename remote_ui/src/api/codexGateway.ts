// Only browser-local image preparation is needed by the reused composer.
// All Codex operations go through LanPower's authenticated relay.
export type ComposerFileSuggestion = { path: string }
export type ComposerPromptInfo = { name: string; path: string; content: string; description: string }
export async function getComposerPrompts(): Promise<ComposerPromptInfo[]> { return [] }
export async function createComposerPrompt(_name: string, _content: string): Promise<ComposerPromptInfo | null> { throw new Error('请在电脑上管理自定义提示。') }
export async function removeComposerPrompt(_path: string): Promise<boolean> { throw new Error('请在电脑上管理自定义提示。') }
export async function searchComposerFiles(_cwd: string, _query: string, _limit: number): Promise<ComposerFileSuggestion[]> { return [] }
export async function updateThreadFileChanges(_threadId: string, _turnId: string, _cwd: string, _action: 'undo' | 'redo', _patchIds?: string[], _scope?: string): Promise<{ changed: number; errors: string[]; revertedPatchIds?: string[]; appliedPatchIds?: string[] }> { throw new Error('请在原 Codex 窗口撤销文件修改。') }

export async function uploadFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请添加不超过 20 MB 的图片，电脑文件请在原窗口添加。')
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', .8)
    if (data.length > 700000) throw new Error('图片过大，请缩小后重试。')
    return data
  } finally { bitmap.close() }
}
