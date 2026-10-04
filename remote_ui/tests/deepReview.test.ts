import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { createRenderer, nextTick, ssrContextKey } from 'vue'
import { readFileSync } from 'node:fs'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { transformWithEsbuild } from 'vite'
import { connection } from '../src/lanpower/connection'
import { prepareSubmissionInput, unicodeLength } from '../src/lanpower/input'
import { normalizeThreadMessagesV2 } from '../src/api/normalizers/v2'
import { resolveRemoteImage, resetRemoteImages, retainRemoteImage } from '../src/lanpower/images'
import RemoteMessageImage from '../src/components/content/RemoteMessageImage.vue'
import { uploadFile } from '../src/api/codexGateway'

const payload = (text:string) => ({text,imageUrls:[],skills:[],fileAttachments:[]})
afterEach(() => { resetRemoteImages(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('deep review input and public tool contracts',() => {
  it.each(['x','中','🎨'])('validates the final input at the Unicode boundary (%s)',character => {
    expect(unicodeLength(character.repeat(16000))).toBe(16000)
    expect(prepareSubmissionInput(payload(character.repeat(16000)))[0].text).toBe(character.repeat(16000))
    expect(() => prepareSubmissionInput(payload(character.repeat(16001)))).toThrow('未发送')
  })
  it('includes file references and rejects combined images and too many skills before dispatch',() => {
    expect(() => prepareSubmissionInput({...payload('x'.repeat(15990)),fileAttachments:[{label:'资料',fsPath:'D:/Work/data.txt'}]})).toThrow('未发送')
    expect(() => prepareSubmissionInput({...payload(''),imageUrls:Array(4).fill('data:image/png;base64,'+'A'.repeat(220000))})).toThrow('可发送大小')
    expect(() => prepareSubmissionInput({...payload(''),skills:Array(9).fill({name:'Skill',path:'D:/Skill'})})).toThrow('8 个技能')
    expect(() => prepareSubmissionInput(payload('\ud800'))).toThrow('无效字符')
  })
  it.each(['mcpToolCall','webSearch','dynamicToolCall','collabAgentToolCall','contextCompaction','enteredReviewMode','exitedReviewMode'])('presents public states for %s in live and restored history',type => {
    for (const status of ['inProgress','completed','failed']) {
      const item = {id:'tool',type,status,server:'server',tool:'search',arguments:{query:'公开查询'},result:{text:'公开结果'},...(status === 'failed' ? {error:{message:'公开错误'}} : {}),encryptedContent:'secret'}
      const messages = normalizeThreadMessagesV2({thread:{id:'chat',turns:[{id:'turn',status,items:[item]}]}} as any)
      const message = messages.find(message => message.id === 'tool')!
      expect(message.toolResult?.status).toBe(status)
      expect(message.toolResult?.unknown).toBe(false)
      expect(message.rawPayload).not.toContain('secret')
      if (type === 'contextCompaction') expect(message.rawPayload).not.toContain('公开查询')
      else { expect(message.toolResult?.name).toBe('server / search'); expect(message.toolResult?.input).toContain('公开查询') }
    }
  })
  it('keeps unknown public details and removes nested hidden reasoning',() => {
    const item = {id:'new',type:'futureTool',result:{type:'reasoning',summary:['公开摘要'],content:'private',encryptedContent:'secret'}}
    const messages = normalizeThreadMessagesV2({thread:{id:'chat',turns:[{id:'turn',status:'completed',items:[item]}]}} as any)
    expect(messages[0]?.toolResult?.unknown).toBe(true); expect(messages[0]?.rawPayload).toContain('公开摘要')
    expect(messages[0]?.rawPayload).not.toMatch(/private|secret/)
  })
})

describe('actual image component and bounded cache lifecycle',() => {
  it('evicts by the 64 MiB byte budget before reaching 32 pictures',async () => {
    vi.stubGlobal('location',{origin:'https://local.example'})
    const bytes = Buffer.alloc(7 * 1024 * 1024)
    vi.spyOn(connection,'request').mockResolvedValue({contentType:'image/png',base64:bytes.toString('base64'),size:bytes.length})
    let index = 0
    vi.spyOn(URL,'createObjectURL').mockImplementation(() => `blob:large-${++index}`)
    const revoke = vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {})
    for (let i = 0; i < 10; i++) await resolveRemoteImage(`D:/Images/large-${i}.png`,'chat','')
    expect(revoke).toHaveBeenCalledWith('blob:large-1')
    expect(revoke).not.toHaveBeenCalledWith('blob:large-10')
  })
  it.each(['image/png','image/gif','image/webp'])('keeps the original small %s bytes without rasterizing',async type => {
    const expected = `data:${type};base64,YW5pbWF0ZWQ=`
    vi.stubGlobal('FileReader',class {result=expected;onload?:()=>void;readAsDataURL() {this.onload?.()} })
    const rasterize = vi.fn(); vi.stubGlobal('createImageBitmap',rasterize)
    expect(await uploadFile(new File(['animated'],'image',{type}))).toBe(expected)
    expect(rasterize).not.toHaveBeenCalled()
  })
  it.each(['image/gif','image/webp'])('rejects oversize %s without silently flattening animation',async type => {
    vi.stubGlobal('FileReader',class {result=`data:${type};base64,${'a'.repeat(700000)}`;onload?:()=>void;readAsDataURL() {this.onload?.()} })
    const rasterize = vi.fn(); vi.stubGlobal('createImageBitmap',rasterize)
    await expect(uploadFile(new File(['animation'],'image',{type}))).rejects.toThrow('保留动画及原图')
    expect(rasterize).not.toHaveBeenCalled()
  })
  it('re-resolves an evicted thumbnail on click and pins the open original until release',async () => {
    vi.stubGlobal('location',{origin:'https://local.example'})
    vi.stubGlobal('IntersectionObserver',class { constructor(private callback:Function) {} observe() { this.callback([{isIntersecting:true}]) } disconnect() {} })
    const read = vi.spyOn(connection,'request').mockResolvedValue({contentType:'image/png',base64:'YQ==',size:1})
    let sequence = 0
    const create = vi.spyOn(URL,'createObjectURL').mockImplementation(() => `blob:image-${++sequence}`)
    const revoke = vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {})
    type Element = {tag:string;props:any;children:Element[];parent?:Element;text?:string}
    const renderer = createRenderer<Element,Element>({
      createElement:tag => ({tag,props:{},children:[]}),createText:text => ({tag:'text',props:{},children:[],text}),createComment:text => ({tag:'comment',props:{},children:[],text}),
      setText:(node,text) => {node.text=text},setElementText:(node,text) => {node.text=text;node.children=[]},
      patchProp:(node,key,_old,value) => {node.props[key]=value},insert:(node,parent,anchor) => {node.parent=parent; const index=anchor ? parent.children.indexOf(anchor) : -1; if(index>=0) parent.children.splice(index,0,node);else parent.children.push(node)},
      remove:node => {if(node.parent) node.parent.children=node.parent.children.filter(child => child !== node)},parentNode:node => node.parent || null,nextSibling:() => null,
    })
    const root:Element = {tag:'root',props:{},children:[]}, opened:string[] = []
    // Vitest loads SFC setup in SSR mode; mount its real setup with the exact
    // template compiled for a client renderer, without substituting click logic.
    const source = readFileSync(new URL('../src/components/content/RemoteMessageImage.vue',import.meta.url),'utf8')
    const descriptor = parse(source).descriptor, script = compileScript(descriptor,{id:'image-regression'})
    const template = compileTemplate({source:descriptor.template!.content,filename:'RemoteMessageImage.vue',id:'image-regression',compilerOptions:{bindingMetadata:script.bindings}})
    const output = {exports:{} as any}
    const compiled = await transformWithEsbuild(template.code,'ImageComponent.js',{format:'cjs',loader:'js'})
    new Function('require','module','exports',compiled.code)(() => Vue,output,output.exports)
    const app = renderer.createApp({...RemoteMessageImage,render:output.exports.render},{source:'D:/Images/first.png',threadId:'chat',cwd:'D:/Images',onOpen:(url:string) => opened.push(url)})
    app.provide(ssrContextKey,{modules:new Set()})
    app.mount(root)
    try {
      await vi.waitFor(() => expect(root.children[0]?.children.some(child => child.tag === 'img')).toBe(true))
      const old = root.children[0]!.children.find(child => child.tag === 'img')!.props.src
      for(let i=0;i<32;i++) await resolveRemoteImage(`D:/Images/${i}.png`,'chat','')
      expect(revoke).toHaveBeenCalledWith(old)
      await root.children[0]!.props.onClick(); await nextTick()
      expect(opened).toHaveLength(1); expect(opened[0]).not.toBe(old); expect(read).toHaveBeenCalledTimes(34)
      const release = retainRemoteImage(opened[0]!)
      for(let i=0;i<40;i++) await resolveRemoteImage(`D:/Images/more-${i}.png`,'chat','')
      expect(revoke).not.toHaveBeenCalledWith(opened[0]); release()
      resetRemoteImages(); await root.children[0]!.props.onClick(); await nextTick()
      expect(opened).toHaveLength(2); expect(opened[1]).not.toBe(opened[0]); expect(create).toHaveBeenCalled()
    } finally { app.unmount() }
  })
})
