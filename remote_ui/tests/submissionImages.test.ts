import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareSubmissionImages } from '../src/lanpower/submissionImages'
import { prepareSubmissionInput } from '../src/lanpower/input'
import { requestFrames } from '../src/lanpower/requestFrames'
import { RpcFragments } from '../src/lanpower/fragments'

const image = (size: number, type = 'png') => `data:image/${type};base64,${'A'.repeat(size)}`
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('original inputs without project size/count ceilings', () => {
  it('preserves 12 large screenshots and animated images without decoding or compression', async () => {
    const urls = Array.from({length:12}, (_, i) => image(1500000, ['png','gif','webp'][i % 3]))
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    const result = await prepareSubmissionImages(urls)
    expect(result.every((url,i) => url === urls[i])).toBe(true)
    expect(result).not.toBe(urls); expect(decode).not.toHaveBeenCalled()
    expect(prepareSubmissionInput({text:'中🎨'.repeat(20000),imageUrls:result,skills:Array(20).fill({name:'Skill',path:'D:/Skill'}),fileAttachments:[]})).toHaveLength(33)
  })
  it('continues to reject invalid image input', async () => {
    await expect(prepareSubmissionImages(['https://example.com/image.png'])).rejects.toThrow('图片格式无效')
  })
  it('restores a >20 MB original request and preserves Unicode across chunk boundaries', () => {
    const raw = JSON.stringify({type:'rpc',payload:{id:'large',method:'turn/start',params:{threadId:'chat',input:[{type:'text',text:'🎨中'.repeat(30000)},{type:'image',url:image(28 * 1024 * 1024)}]}}})
    const frames = [...requestFrames(raw,'large')].map(part => JSON.parse(part))
    expect(frames.length).toBeGreaterThan(400)
    expect(frames.every((frame,i) => frame.type === 'rpc_upload' && frame.index === i && frame.count === frames.length && frame.data.length <= 65536)).toBe(true)
    expect(frames.map(frame => frame.data).join('') === raw).toBe(true)
    expect(frames.every(frame => !/[\uD800-\uDBFF]$/u.test(frame.data) && !/^[\uDC00-\uDFFF]/u.test(frame.data))).toBe(true)
  })
  it('restores responses beyond the former 16 MB and 512-piece ceilings', () => {
    const raw = JSON.stringify({id:'wire',result:{text:'中🎨'.repeat(3 * 1024 * 1024)}})
    const size = 16000, count = Math.ceil(raw.length / size), fragments = new RpcFragments()
    let payload: any
    for (let i=0;i<count;i++) payload=fragments.accept({type:'rpc_chunk',id:'client',rpcId:'wire',index:i,count,data:raw.slice(i*size,(i+1)*size)})
    expect(count).toBeGreaterThan(512)
    expect(payload.id).toBe('client'); expect(payload.result.text.length).toBe(9 * 1024 * 1024)
  })
})
