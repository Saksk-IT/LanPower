import { describe, expect, it } from 'vitest'
import { StateClock } from '../src/lanpower/state'
import { newSettings, observeSettings, effectiveSettings, validEfforts } from '../src/lanpower/settings'
import { readPage, HistoryContentReader, refreshHistoryTurn, findBeginning, newBeginning } from '../src/lanpower/history'
import { RemoteError, type RemoteConnection } from '../src/lanpower/connection'

describe('P0 state and parameter recovery', () => {
  it('rejects snapshots begun before an event, including events on another thread', () => {
    const clock = new StateClock(), global = clock.capture(), one = clock.capture('one')
    clock.event('two',2); expect(clock.unchanged(global)).toBe(false); expect(clock.unchanged(one,'one')).toBe(true)
    clock.event('one',5); expect(clock.unchanged(one,'one')).toBe(false)
    expect(clock.snapshot('one',4)).toBe(false); expect(clock.event('one',3)).toBe(false)
    expect(clock.snapshot('one',5)).toBe(true)
  })
  it('keeps next-send overrides through native refresh and isolates another thread', () => {
    const one = newSettings(), two = newSettings()
    observeSettings(one,{model:'old',reasoningEffort:'high',collaborationMode:{mode:'plan'}},'default')
    one.overrides.model = 'chosen'; one.overrides.effort = 'low'; one.overrides.mode = 'default'
    observeSettings(one,{model:'desktop-new',reasoningEffort:'medium',collaborationMode:'plan'},'default')
    expect(effectiveSettings(one)).toEqual({model:'chosen',effort:'low',mode:'default'})
    expect(one.native.model).toBe('desktop-new')
    observeSettings(two,{model:'other',collaborationMode:'default'},'default'); expect(two.overrides).toEqual({})
    one.overrides = {}; expect(effectiveSettings(one).model).toBe('desktop-new')
    expect(validEfforts({supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}]})).toEqual(['low','ultra'])
  })
})

describe('P0 complete bounded history reads', () => {
  it('automatically shrinks an oversized page down to one turn', async () => {
    const limits:number[] = []
    const client = {request:async (_:string,p:any) => { limits.push(p.limit); if (p.limit > 1) throw new RemoteError('result_too_large','large'); return {data:[{id:'only'}]} }} as RemoteConnection
    expect((await readPage(client,'thread')).data[0].id).toBe('only'); expect(limits).toEqual([8,4,2,1])
  })
  it('restores complete Unicode content in place after interruption without gaps or duplicates', async () => {
    const original = {id:'reply',type:'agentMessage',text:'中文🎨'.repeat(20000)}
    const body = JSON.stringify(original), reader = new HistoryContentReader('thread'); let failed = false
    const item = {id:'reply',type:'lanpowerLargeItem',originalType:'agentMessage',reference:'ref',characters:body.length}
    const client = {request:async (_:string,p:any) => {
      if (p.offset > 0 && !failed) { failed = true; throw new Error('offline') }
      let end = Math.min(body.length,p.offset+1024); if (end < body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end--
      return {data:body.slice(p.offset,end),offset:p.offset,nextOffset:end<body.length ? end : null,characters:body.length}
    }} as RemoteConnection
    await expect(reader.read(client,item)).rejects.toThrow('offline')
    await reader.read(client,item)
    const turns = reader.apply([{id:'turn',items:[item,{id:'next',type:'agentMessage',text:'后续回复'}]}])
    expect(turns[0].items[0]).toEqual({...original,lanpowerContentReference:'ref'})
    expect(turns[0].items[1].text).toBe('后续回复')
    await reader.read(client,item); expect(reader.apply(turns)).toBe(turns)
  })
  it('restores an entire turn at its original position while retaining newer status', async () => {
    const turns = Array.from({length:180},(_,i)=>({id:'turn-'+i,items:[{id:'item-'+i,type:'agentMessage',text:'内容🎨'+i}]}))
    const whole = JSON.stringify(turns[175]); let fail = true
    const client = {request:async (method:string,p:any) => {
      if (method === 'lanpower/history/item/read') { if (fail) {fail=false;throw new Error('offline')}; return {data:whole,offset:0,nextOffset:null,characters:whole.length} }
      throw new Error('unexpected request')
    }} as RemoteConnection
    const reader = new HistoryContentReader('thread')
    const item = {id:'turn-175',type:'lanpowerLargeItem',reference:'large',wholeTurn:true,characters:whole.length}
    const packed = turns.map(turn => turn.id === 'turn-175' ? {...turn,status:'completed',items:[item]} : turn)
    await expect(reader.read(client,item)).rejects.toThrow('offline')
    await reader.read(client,item)
    const result = reader.apply(packed)
    expect(result).toHaveLength(180); expect(result[175].items).toEqual(turns[175]!.items)
    expect(result[175].status).toBe('completed'); expect(result[174]).toBe(turns[174]); expect(result[176]).toBe(turns[176])
  })
  it('cancels a late chunk and rejects content from another item', async () => {
    const body = JSON.stringify({id:'other',type:'agentMessage',text:'wrong'}), controller = new AbortController()
    const reader = new HistoryContentReader('thread'), item = {id:'reply',originalType:'agentMessage',reference:'ref',characters:body.length}
    const client = {request:async () => {controller.abort();return {offset:0,data:body,nextOffset:null,characters:body.length}}} as RemoteConnection
    await expect(reader.read(client,item,controller.signal)).rejects.toThrow()
    const other = {request:async () => ({offset:0,data:body,nextOffset:null,characters:body.length})} as RemoteConnection
    await expect(reader.read(other,item)).rejects.toThrow('会话内容不匹配')
    expect(reader.apply([{id:'turn',items:[item]}])[0].items[0]).toBe(item)
  })
  it('renews an expired older-turn reference through native pagination', async () => {
    const calls:string[] = []
    const client = {request:async (_:string,p:any) => {calls.push(p.cursor || 'latest');return p.cursor ? {data:[{id:'older',items:[]}],nextCursor:null} : {data:[{id:'newer'}],nextCursor:'page-2'}}} as RemoteConnection
    expect((await refreshHistoryTurn(client,'thread','older')).id).toBe('older')
    expect(calls).toEqual(['latest','page-2'])
  })
  it('locates the beginning while retaining only the last page and cursors', async () => {
    const state = newBeginning()
    const client = {request:async (_:string,p:any) => {const offset = Number(p.cursor || 0);return {data:Array.from({length:8},(_,i)=>({id:String(179-offset-i)})),nextCursor:offset+8<180?String(offset+8):null}}} as RemoteConnection
    const page = await findBeginning(client,'thread',state)
    expect(state.pages).toHaveLength(23); expect(page).toBe(state.lastPage); expect(state.complete).toBe(true)
    expect('turns' in state).toBe(false)
  })
})
