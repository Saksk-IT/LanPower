import { describe, expect, it } from 'vitest'
import { StateClock } from '../src/lanpower/state'
import { newSettings, observeSettings, effectiveSettings, validEfforts } from '../src/lanpower/settings'
import { readPage, exportHistory, newExport, downloadItem, newDownload, findBeginning, newBeginning } from '../src/lanpower/history'
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
  it('continues Unicode item download after failure without gaps or duplicated bytes', async () => {
    const body = JSON.stringify({text:'中文🎨'.repeat(20000)}), state = newDownload(); let failed = false
    const client = {request:async (_:string,p:any) => {
      if (p.offset > 0 && !failed) { failed = true; throw new Error('offline') }
      let end = Math.min(body.length,p.offset+1024); if (end < body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end--
      return {data:body.slice(p.offset,end),offset:p.offset,nextOffset:end<body.length ? end : null,characters:body.length}
    }} as RemoteConnection
    await expect(downloadItem(client,'thread','ref',state)).rejects.toThrow('offline')
    expect(await (await downloadItem(client,'thread','ref',state)).text()).toBe(body)
  })
  it('exports 180 turns with a large-item substitution and retries an interrupted page', async () => {
    const turns = Array.from({length:180},(_,i)=>({id:'turn-'+i,items:[{id:'item-'+i,type:'agentMessage',text:'内容🎨'+i}]}))
    const whole = JSON.stringify(turns[175]); const pages:number[] = []; let fail = true
    const client = {request:async (method:string,p:any) => {
      if (method === 'lanpower/history/item/read') { if (fail) {fail=false;throw new Error('offline')}; return {data:whole,offset:0,nextOffset:null,characters:whole.length} }
      const offset = Number(p.cursor || 0); pages.push(offset)
      const data:any[] = turns.slice(Math.max(0,180-offset-p.limit),180-offset).reverse().map(turn => turn.id === 'turn-175' ? {...turn,items:[{type:'lanpowerLargeItem',reference:'large',wholeTurn:true}]} : turn)
      return {data,nextCursor:offset+p.limit<180?String(offset+p.limit):null}
    }} as RemoteConnection
    const job = newExport({id:'thread',turns:[],cwd:'target'})
    await expect(exportHistory(client,'thread',job)).rejects.toThrow('offline')
    const result = JSON.parse(await (await exportHistory(client,'thread',job)).text())
    expect(result.turns).toEqual(turns); expect(job.ids.size).toBe(180); expect(pages.slice(0,2)).toEqual([0,8])
  })
  it('locates the beginning while retaining only the last page and cursors', async () => {
    const state = newBeginning()
    const client = {request:async (_:string,p:any) => {const offset = Number(p.cursor || 0);return {data:Array.from({length:8},(_,i)=>({id:String(179-offset-i)})),nextCursor:offset+8<180?String(offset+8):null}}} as RemoteConnection
    const page = await findBeginning(client,'thread',state)
    expect(state.pages).toHaveLength(23); expect(page).toBe(state.lastPage); expect(state.complete).toBe(true)
    expect('turns' in state).toBe(false)
  })
})
