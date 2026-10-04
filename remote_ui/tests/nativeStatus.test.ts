import { describe, expect, it } from 'vitest'
import { NativeDirectory, NativeUsage, capabilityStatus, quotaSnapshots, tokenUsage } from '../src/lanpower/nativeStatus'
const counts = (totalTokens: number) => ({totalTokens,inputTokens:totalTokens,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0})
describe('native quota, context and capabilities on the selected computer', () => {
  it('keeps missing capability states unknown', () => {
    for (const kind of ['skill','plugin','app','mcp']) expect(capabilityStatus(kind,{}).state).toBe('unknown')
    expect(capabilityStatus('skill',{enabled:true}).state).toBe('installed')
    expect(capabilityStatus('app',{isAccessible:false,isEnabled:true}).state).toBe('needs-auth')
    expect(capabilityStatus('plugin',{installed:true,enabled:false}).state).toBe('disabled')
    expect(capabilityStatus('plugin',{installed:false,enabled:false}).state).toBe('not-installed')
    expect(capabilityStatus('mcp',{authStatus:'unsupported',tools:[{}]}).state).toBe('unknown')
  })
  it('retains native buckets and zero usage without filling missing percentages', () => {
    const payload = {rateLimits:{primary:{usedPercent:0}},rateLimitsByLimitId:{codex:{primary:{usedPercent:10}},other:{secondary:{usedPercent:0}}}}
    expect(quotaSnapshots(payload)).toHaveLength(2)
    expect(quotaSnapshots(payload)[1].secondary?.usedPercent).toBe(0)
    expect(quotaSnapshots({rateLimits:{primary:{}}})).toEqual([])
    expect(quotaSnapshots({rateLimits:{primary:{usedPercent:101}}})).toEqual([])
    expect(() => quotaSnapshots({unavailableReason:'未登录原窗口'})).toThrow('未登录原窗口')
  })
  it('uses actual tokens and window without a fixed baseline', () => {
    const usage = {total:counts(18000),last:counts(12000),modelContextWindow:24000}
    expect(tokenUsage(usage)?.remainingContextPercent).toBe(50)
    expect(tokenUsage({...usage,modelContextWindow:undefined})?.remainingContextPercent).toBe(null)
    expect(tokenUsage({...usage,last:{totalTokens:12000}})).toBe(null)
    expect(tokenUsage({...usage,last:counts(-1)})).toBe(null)
  })
  it('merges duplicate reads, clears quota failures and ignores an old connection', async () => {
    let calls = 0, release: (value:any) => void = () => {}
    const client:any = {request: () => { calls++; return new Promise(resolve => { release = resolve }) }}
    const usage = new NativeUsage(client,() => true,() => {})
    const first = usage.readQuota(), second = usage.readQuota(); expect(calls).toBe(1)
    release({rateLimits:{primary:{usedPercent:20}}}); await Promise.all([first,second]); expect(usage.state.snapshots).toHaveLength(1)
    client.request = async () => { throw new Error('原窗口登录已过期') }
    await usage.readQuota(); expect(usage.state.snapshots).toEqual([]); expect(usage.state.reason).toContain('登录已过期')
    client.request = () => new Promise(resolve => { release = resolve })
    const old = usage.readQuota(); usage.reset(); release({rateLimits:{primary:{usedPercent:0}}}); await old
    expect(usage.state.snapshots).toEqual([])
  })
  it('isolates usage by thread and clears invalid latest data and disconnects', () => {
    const usage = new NativeUsage({},() => true,() => {})
    usage.event('thread/tokenUsage/updated',{threadId:'a',tokenUsage:{total:counts(10),last:counts(5)}})
    expect(usage.context('a').usage?.currentContextTokens).toBe(5)
    expect(usage.context('a').reason).toContain('未提供上下文窗口')
    expect(usage.context('b').usage).toBe(null)
    usage.event('thread/tokenUsage/updated',{threadId:'a',tokenUsage:{last:{}}})
    expect(usage.context('a').usage).toBe(null)
    usage.reset(); expect(usage.context('a').usage).toBe(null)
  })
  it('fetches one 24-item page per navigation and clears failed pages', async () => {
    const calls:any[] = []
    const client:any = {request:async (method:string,params:any) => { calls.push({method,params}); return {data:[{id:params.cursor || 'first'}],nextCursor:params.cursor ? null : 'second'} }}
    const directory = new NativeDirectory(client,() => true,() => {})
    await directory.load('app'); expect(calls).toHaveLength(1); expect(calls[0].params).toEqual({limit:24})
    await directory.next(); expect(calls[1].params).toEqual({limit:24,cursor:'second'}); expect(directory.state.page).toBe(2)
    await directory.previous(); expect(directory.state.page).toBe(1); expect(calls).toHaveLength(3)
    client.request = async () => { throw new Error('目录接口不可用') }
    await directory.load('app'); expect(directory.state.rows).toEqual([]); expect(directory.state.error).toContain('接口不可用')
  })
  it('rejects repeated cursors and ignores old project responses', async () => {
    const client:any = {request:async () => ({data:[],nextCursor:'repeat'})}
    const directory = new NativeDirectory(client,() => true,() => {})
    await directory.load('mcp'); await directory.next(); expect(directory.state.error).toContain('游标未推进')
    let release: (value:any) => void = () => {}
    client.request = () => new Promise(resolve => { release = resolve })
    const old = directory.load('app'); directory.reset(); release({data:[{id:'old'}]}); await old
    expect(directory.state.rows).toEqual([])
  })
})
