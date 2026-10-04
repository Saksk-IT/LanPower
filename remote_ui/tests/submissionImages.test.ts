import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareSubmissionImages, compressImageUrl, MAX_IMAGE_URL_LENGTH, MAX_IMAGE_URLS_LENGTH } from '../src/lanpower/submissionImages'
import { prepareSubmissionInput } from '../src/lanpower/input'

const image = (size: number, type = 'png') => `data:image/${type};base64,${'A'.repeat(size)}`
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mockEncoding(encode: (type: string, quality?: number, width?: number) => string) {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 2000, height: 1400, close})))
  const canvas = {width: 0, height: 0, getContext: () => ({drawImage: vi.fn()}), toDataURL: vi.fn((type, quality) => encode(type, quality, canvas.width))}
  vi.stubGlobal('document', {createElement: () => canvas})
  return {canvas, close}
}

describe('image submission preparation', () => {
  it('keeps small screenshots and animations byte-identical without decoding', async () => {
    const urls = [image(100, 'png'), image(100, 'gif'), image(100, 'webp')]
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    expect(await prepareSubmissionImages(urls)).toEqual(urls)
    expect(decode).not.toHaveBeenCalled()
  })

  it('compresses the combined screenshots even when each is individually allowed', async () => {
    const urls = [image(500000), image(500000)]
    const {close} = mockEncoding(type => image(type === 'png' ? 500000 : 300000, type.split('/')[1]))
    const prepared = await prepareSubmissionImages(urls)
    expect(prepared.reduce((sum, url) => sum + url.length, 0)).toBeLessThanOrEqual(MAX_IMAGE_URLS_LENGTH)
    expect(prepared.every(url => url.length <= MAX_IMAGE_URL_LENGTH)).toBe(true)
    expect(prepareSubmissionInput({text: '', imageUrls: prepared, skills: [], fileAttachments: []})).toHaveLength(2)
    expect(urls).toEqual([image(500000), image(500000)])
    // The first compression leaves enough room to keep the second original.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reserves original animation bytes and leaves small pictures unchanged', async () => {
    const urls = [image(500000, 'gif'), image(100), image(500000)]
    const {close} = mockEncoding(type => image(type === 'png' ? 500000 : 300000, type.split('/')[1]))
    const prepared = await prepareSubmissionImages(urls)
    expect(prepared[0]).toBe(urls[0]); expect(prepared[1]).toBe(urls[1])
    expect(prepared.reduce((sum, url) => sum + url.length, 0)).toBeLessThanOrEqual(MAX_IMAGE_URLS_LENGTH)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('tries smaller dimensions when changing encoding is not sufficient', async () => {
    const {canvas, close} = mockEncoding((type, _quality, width) => image(width! <= 1600 && type === 'image/webp' ? 200000 : 900000, type.split('/')[1]))
    const prepared = await compressImageUrl(image(1000000), MAX_IMAGE_URL_LENGTH)
    expect(prepared.length).toBeLessThanOrEqual(MAX_IMAGE_URL_LENGTH)
    expect(canvas.toDataURL).toHaveBeenCalledTimes(6)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('releases resources and preserves the source when compression cannot fit', async () => {
    const {close, canvas} = mockEncoding(type => image(900000, type.split('/')[1]))
    const urls = [image(500000), image(500000)]
    await expect(prepareSubmissionImages(urls)).rejects.toThrow('请减少图片')
    expect(urls[0]).toBe(image(500000)); expect(close).toHaveBeenCalledTimes(1)
    expect(canvas.width).toBe(1); expect(canvas.height).toBe(1)
  })

  it('rejects excessive or malformed images before decoding', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    await expect(prepareSubmissionImages(Array(5).fill(image(1)))).rejects.toThrow('4 张图片')
    await expect(prepareSubmissionImages(['https://example.com/image.png'])).rejects.toThrow('图片格式无效')
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not flatten an animated WebP to satisfy the combined budget', async () => {
    const header = 'RIFF' + '\0'.repeat(4) + 'WEBPVP8X' + '\0'.repeat(4) + '\x02' + '\0'.repeat(27)
    const animation = `data:image/webp;base64,${btoa(header)}${'A'.repeat(500000)}`
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    await expect(prepareSubmissionImages([animation, animation])).rejects.toThrow('保留动画及原图')
    expect(decode).not.toHaveBeenCalled()
  })
})
