import { describe, expect, it } from 'vitest'
import { buildLibrary, defaultLibraryPreferences, libraryThread } from '../src/lanpower/library'
import { mergeHistory } from '../src/lanpower/history'
import { RpcFragments } from '../src/lanpower/fragments'

describe('native history and project library',() => {
  it('retains more than 128 turns when native snapshots advance',() => {
    const old = Array.from({length:180},(_,i) => ({id:`t${i}`,text:'old'}))
    const latest = Array.from({length:8},(_,i) => ({id:`t${178+i}`,text:'latest'}))
    const merged = mergeHistory(old,latest)
    expect(merged).toHaveLength(186); expect(merged[0]?.id).toBe('t0'); expect(merged[178]?.text).toBe('latest')
  })
  it('separates chats and equal-named projects by their real paths',() => {
    const prefs = defaultLibraryPreferences()
    const roots = [{name:'Demo',path:'D:/work/Demo'},{name:'Demo',path:'D:/other/Demo'}]
    const rows = [{id:'first',cwd:'D:/work/Demo',name:'A'},{id:'second',cwd:'D:/other/Demo',name:'B'},{id:'chat',cwd:'C:/Users/Test/Documents/Codex/2026-10-04/new',name:'C'}].map(libraryThread)
    const library = buildLibrary(roots,rows,prefs,'')
    expect(library.projects).toHaveLength(2); expect(library.projects[0]?.threads.map(t => t.id)).toEqual(['first']); expect(library.chats.map(t=>t.id)).toEqual(['chat'])
  })
  it('reconstructs long Unicode replies and rejects missing fragments',() => {
    const fragments = new RpcFragments(), text = '中文🎨'.repeat(120000)
    const raw = JSON.stringify({id:'history',result:{text}}), chunks = raw.match(/[\s\S]{1,16000}/g)!
    let result:any
    chunks.forEach((data,index) => { result = fragments.accept({id:'history',index,count:chunks.length,data}) })
    expect(result.result.text).toBe(text)
    expect(() => fragments.accept({id:'lost',index:1,count:3,data:'missing'})).toThrow('invalid_chunk')
    fragments.clear()
  })
})
