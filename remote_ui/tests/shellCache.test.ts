import {afterEach, describe, expect, it, vi} from 'vitest'
import {readShellSnapshot, writeShellSnapshot} from '../src/lanpower/shellCache'

afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers()})

describe('网页首屏外壳缓存', () => {
  it('仅保存摘要并隔离电脑，浏览器刷新能读回选中聊天，过期后舍弃', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value)})
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    writeShellSnapshot({deviceId: 'pc', threadId: 'chat', archived: false, threads: [{id: 'chat', name: '示例',
      turns: [{body: '正文'}], diff: '代码', credentials: 'secret', status: {type: 'idle', body: '内部数据'}}],
      library: {revision: 1, preferences: {pinned: ['chat'], content: '正文'}}})
    const snapshot = readShellSnapshot('pc')!
    expect(snapshot.threadId).toBe('chat'); expect(snapshot.threads[0]!.status).toEqual({type: 'idle'})
    for (const forbidden of ['正文', '代码', 'secret', 'credentials', 'turns', 'diff']) expect([...storage.values()].join('')).not.toContain(forbidden)
    expect(readShellSnapshot('another-pc')).toBeNull()
    vi.advanceTimersByTime(31 * 60 * 1000); expect(readShellSnapshot('pc')).toBeNull()
  })
  it('禁用本地存储时直接回退到远程读取', () => {
    vi.stubGlobal('sessionStorage', {getItem: () => {throw new Error('disabled')}, setItem: () => {throw new Error('full')}})
    expect(() => writeShellSnapshot({deviceId: 'pc', threadId: '', archived: false, threads: []})).not.toThrow()
    expect(readShellSnapshot('pc')).toBeNull()
  })
})
