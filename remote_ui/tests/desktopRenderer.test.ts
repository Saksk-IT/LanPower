import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../windows/LanPower.CodexHost/DesktopRenderer.js', import.meta.url), 'utf8')
function fixture() {
  const events: any[] = [], replies: any[] = [], listeners = new Map<string, Set<Function>>()
  const conversation = { id: 'chat', requests: [] as any[] }
  const subscribe = (kind: string, fn: Function) => { if (!listeners.has(kind)) listeners.set(kind, new Set()); listeners.get(kind)!.add(fn); return () => listeners.get(kind)!.delete(fn) }
  const emit = (kind: string, payload: any) => { for (const fn of listeners.get(kind) || []) fn(payload) }
  const manager = {
    getHostId: () => 'local', getConversation: () => conversation, getRecentConversations: () => [{ id: 'chat' }],
    sendRequest: async (method: string, params: any) => { replies.push({ method, params }); return { turn: { id: 'turn' } } },
    addApprovalRequestListener: (fn: Function) => subscribe('approval', fn),
    addUserInputRequestListener: (fn: Function) => subscribe('question', fn),
    addNotificationCallback: (_methods: string[], fn: Function) => subscribe('notification', fn),
    addTurnCompletedListener: (fn: Function) => subscribe('turn', fn),
    addStreamRoleStateCallback: (fn: Function) => subscribe('role', fn),
    replyWithUserInputResponse: (conversationId: string, id: number, result: any) => { replies.push({ conversationId, id, result }); conversation.requests = []; emit('notification', { method: 'serverRequest/resolved', params: { requestId: id } }) },
  }
  const context = createContext({ TextEncoder, __codexRoot: { _internalRoot: { current: { memoizedState: { memoizedState: manager } } } },
    eventA: (raw: string) => events.push(JSON.parse(raw)), eventB: (raw: string) => events.push(JSON.parse(raw)),
    electronBridge: { sendMessageFromView: async (reply: any) => { replies.push(reply); conversation.requests = [] } },
  })
  const attach = async (name: string, binding: string) => { await runInContext(source.replaceAll('__LANPOWER_GLOBAL__', name).replaceAll('__LANPOWER_BINDING__', binding), context); return context[name] as any }
  return { context, manager, conversation, events, replies, listeners, emit, attach }
}
describe('original desktop renderer integration', () => {
  it('reads native content above 16 MiB without hiding other items or relaying private reasoning', async () => {
    const f = fixture(), expected = '开始🎨' + 'x'.repeat(17 * 1024 * 1024) + '结尾'
    ;(f.manager as any).sendRequest = async () => ({data:[{id:'huge-turn',items:[{id:'large',type:'agentMessage',text:expected},{id:'private',type:'reasoning',content:['secret'],encryptedContent:'secret',summary:['public']}]}],nextCursor:null})
    const a = await f.attach('adapterA','eventA')
    const page = await a.rpc('codex-web/local/history/page',{threadId:'chat',limit:1})
    expect(JSON.stringify(page).length).toBeLessThan(1024)
    const item = page.data[0].items[0], chunks:string[] = []; let offset: number | null = 0
    do { const result = await a.rpc('codex-web/local/history/item/read',{threadId:'chat',reference:item.reference,offset});chunks.push(result.data);offset=result.nextOffset } while (offset !== null)
    const original = JSON.parse(chunks.join(''))
    expect(original.text).toBe(expected); expect(page.data[0].items[1]).toEqual({id:'private',type:'reasoning',summary:['public']})
    expect(item.wholeTurn).toBe(false)
    const repeated = await a.rpc('codex-web/local/history/page',{threadId:'chat',limit:1})
    expect(repeated.data[0].items[0].reference).toBe(item.reference)
    await expect(a.rpc('codex-web/local/history/item/read',{threadId:'other',reference:item.reference,offset:0})).rejects.toThrow('history_reference_expired')
    a.dispose()
  })
  it('keeps a short final reply visible when three generated images exceed the turn threshold', async () => {
    const f = fixture(), images = Array.from({length:3},(_,i) => ({id:'image-'+i,type:'imageGeneration',result:'x'.repeat(1500000)}))
    const final = {id:'answer',type:'agentMessage',text:'我建议采用 A 的主界面',phase:'final_answer'}
    ;(f.manager as any).sendRequest = async () => ({data:[{id:'design',items:[...images,final]}],nextCursor:null})
    const a = await f.attach('adapterA','eventA'), page = await a.rpc('codex-web/local/history/page',{threadId:'chat',limit:1})
    expect(page.data[0].items.at(-1)).toEqual(final)
    expect(page.data[0].items.filter((item:any) => item.type === 'lanpowerLargeItem')).toHaveLength(3)
    expect(page.data[0].items.every((item:any) => !item.wholeTurn)).toBe(true)
    a.dispose()
  })
  it('retains referenced images when many small items require whole-turn chunking', async () => {
    const f = fixture(), items = Array.from({length:50},(_,i) => ({id:'part-'+i,type:'agentMessage',text:'x'.repeat(48000)}))
    items.push({id:'final',type:'agentMessage',text:'![图片](<D:/Images/from-original.png>)'})
    ;(f.manager as any).sendRequest = async () => ({data:[{id:'many',items}],nextCursor:null})
    const a = await f.attach('adapterA','eventA'), page = await a.rpc('codex-web/local/history/page',{threadId:'chat',limit:1})
    expect(page.data[0].items[0]).toMatchObject({wholeTurn:true,imageReferences:[{path:'D:/Images/from-original.png'}]})
    a.dispose()
  })
  it('removes an approval resolved in the native cache without a notification', async () => {
    const f = fixture();f.conversation.requests.push({id:22,method:'item/commandExecution/requestApproval',params:{threadId:'chat'}})
    const a = await f.attach('adapterA','eventA'); f.conversation.requests = []
    expect(await a.rpc('codex-web/local/server-requests/pending')).toEqual([])
    await expect(a.rpc('codex-web/local/server-requests/respond',{id:22,result:{decision:'accept'}})).rejects.toThrow('No pending')
    expect(f.replies).toHaveLength(0); a.dispose()
  })
  it('keeps another connection alive when disposing and resumes before starting a turn', async () => {
    const f = fixture(), a = await f.attach('adapterA', 'eventA'), b = await f.attach('adapterB', 'eventB')
    await a.rpc('turn/start', { threadId: 'chat', input: [{ type: 'text', text: 'safe' }] })
    expect(f.replies.map(r => r.method)).toEqual(['thread/resume', 'turn/start'])
    a.dispose(); f.emit('notification', { method: 'thread/queue/changed', params: { threadId: 'chat' } })
    expect(f.events.filter(e => e.payload?.method === 'thread/queue/changed')).toHaveLength(1)
    expect(f.listeners.get('notification')?.size).toBe(1)
    b.dispose(); expect(f.listeners.get('notification')?.size).toBe(0)
  })
  it('restores a native pending approval and replies through the desktop bridge', async () => {
    const f = fixture()
    f.conversation.requests.push({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'chat', turnId: 'turn' } })
    const a = await f.attach('adapterA', 'eventA')
    expect(f.events.find(e => e.payload?.method === 'server/request')?.payload.params.id).toBe(42)
    await a.rpc('codex-web/local/server-requests/respond', { id: 42, result: { decision: 'accept' } })
    expect(f.replies.at(-1)).toMatchObject({ type: 'reply-with-command-execution-approval-decision', conversationId: 'chat', requestId: 42, decision: 'accept' })
    expect(await a.rpc('codex-web/local/server-requests/pending')).toEqual([])
    a.dispose()
  })
  it('answers native questions and removes requests answered on the desktop', async () => {
    const f = fixture(), a = await f.attach('adapterA', 'eventA')
    f.conversation.requests.push({ id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'chat', questions: [] } })
    f.emit('question', { conversationId: 'chat', requestId: 7 })
    await a.rpc('codex-web/local/server-requests/respond', { id: 7, result: { answers: { choice: { answers: ['yes'] } } } })
    expect(f.replies.at(-1)).toMatchObject({ conversationId: 'chat', id: 7, result: { answers: { choice: { answers: ['yes'] } } } })
    expect(await a.rpc('codex-web/local/server-requests/pending')).toEqual([])
    f.conversation.requests.push({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 'chat' } })
    f.emit('approval', { conversationId: 'chat', requestId: 9, kind: 'fileChange' })
    f.emit('notification', { method: 'serverRequest/resolved', params: { requestId: 9 } })
    expect(await a.rpc('codex-web/local/server-requests/pending')).toEqual([])
    a.dispose()
  })
  it('replies through the original app-server when a native chat view is not open', async () => {
    const f = fixture()
    ;(f.manager as any).sendAppServerResponse = (method: string, response: any) => f.replies.push({ nativeMethod: method, response })
    f.conversation.requests.push({ id: 21, method: 'item/commandExecution/requestApproval', params: { threadId: 'chat' } })
    const a = await f.attach('adapterA', 'eventA')
    await a.rpc('codex-web/local/server-requests/respond', { id: 21, result: { decision: 'accept' } })
    expect(f.replies).toEqual([{ nativeMethod: 'item/commandExecution/requestApproval', response: { id: 21, result: { decision: 'accept' } } }])
    expect(await a.rpc('codex-web/local/server-requests/pending')).toEqual([])
    a.dispose()
  })
})
