// Keep the relay's bounded frame contract out of the user-facing composer.
export const MAX_SUBMISSION_IMAGES = 4
export const MAX_IMAGE_URL_LENGTH = 700000
export const MAX_IMAGE_URLS_LENGTH = 850000
export const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u
const MAX_SOURCE_URL_LENGTH = Math.ceil(20 * 1024 * 1024 / 3) * 4 + 32
const ANIMATION_HINT = '为保留动画及原图，请减少图片、选择较小的图片，或在原窗口添加。'

function canCompress(url: string): boolean {
  if (url.startsWith('data:image/png;') || url.startsWith('data:image/jpeg;')) return true
  if (!url.startsWith('data:image/webp;')) return false
  // An unknown WebP or one with the animation flag must keep its original bytes.
  const prefix = url.slice(url.indexOf(',') + 1, url.indexOf(',') + 65)
  const header = atob(prefix.slice(0, Math.floor(prefix.length / 4) * 4))
  if (header.slice(0, 4) !== 'RIFF' || header.slice(8, 12) !== 'WEBP') return false
  const chunk = header.slice(12, 16)
  return chunk === 'VP8 ' || chunk === 'VP8L' || (chunk === 'VP8X' && header.length >= 21 && (header.charCodeAt(20) & 2) === 0)
}

export async function compressImageUrl(url: string, budget: number): Promise<string> {
  if (url.length <= budget) return url
  if (!canCompress(url)) throw new Error(ANIMATION_HINT)
  const separator = url.indexOf(',')
  const bytes = Uint8Array.from(atob(url.slice(separator + 1)), character => character.charCodeAt(0))
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(new Blob([bytes], {type: url.slice(5, separator).split(';')[0]})) }
  catch { throw new Error('图片无法读取，请重新添加图片。') }
  const canvas = document.createElement('canvas')
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32 * 1024 * 1024) throw new Error('图片尺寸过大，请选择较小的图片。')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片，请更换浏览器或选择较小的图片。')
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height), Math.sqrt(16 * 1024 * 1024 / (bitmap.width * bitmap.height)))
    const minimumScale = Math.min(scale, 640 / Math.max(bitmap.width, bitmap.height))
    for (let attempt = 0; attempt < 9; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      // Prefer lossless PNG for screenshots, then high-quality WebP before resizing.
      if (url.startsWith('data:image/png;')) {
        const lossless = canvas.toDataURL('image/png')
        if (lossless.length <= budget) return lossless
      }
      for (const quality of [.92, .84, .76]) {
        const encoded = canvas.toDataURL('image/webp', quality)
        if (encoded.length <= budget) return encoded
        // JPEG is a fallback only for JPEG input, so transparency is never lost.
        if (url.startsWith('data:image/jpeg;')) {
          const jpeg = canvas.toDataURL('image/jpeg', quality)
          if (jpeg.length <= budget) return jpeg
        }
      }
      if (scale <= minimumScale) break
      scale = Math.max(minimumScale, scale * .8)
    }
    throw new Error('图片未能压缩到可发送大小，请减少图片或选择较小的图片。')
  } finally {
    bitmap.close()
    canvas.width = canvas.height = 1
  }
}

export async function prepareSubmissionImages(urls: string[]): Promise<string[]> {
  if (urls.length > MAX_SUBMISSION_IMAGES) throw new Error(`一次最多添加 ${MAX_SUBMISSION_IMAGES} 张图片，请移除多余图片。`)
  if (urls.some(url => url.length > MAX_SOURCE_URL_LENGTH || !IMAGE_DATA_URL.test(url))) throw new Error('图片格式无效或原图过大，请重新添加不超过 20 MB 的图片。')
  if (urls.every(url => url.length <= MAX_IMAGE_URL_LENGTH) && urls.reduce((sum, url) => sum + url.length, 0) <= MAX_IMAGE_URLS_LENGTH) return [...urls]
  const result = [...urls]
  const candidates = urls.map((url, index) => ({url, index})).filter(image => canCompress(image.url)).sort((a, b) => a.url.length - b.url.length)
  const fixed = urls.filter(url => !canCompress(url))
  let remaining = MAX_IMAGE_URLS_LENGTH - fixed.reduce((sum, url) => sum + url.length, 0)
  if (remaining <= 0 || fixed.some(url => url.length > MAX_IMAGE_URL_LENGTH)) throw new Error(ANIMATION_HINT)
  // Small images keep their original bytes; large images share the remaining budget.
  for (let index = 0; index < candidates.length; index++) {
    const image = candidates[index]!
    const budget = Math.min(MAX_IMAGE_URL_LENGTH, Math.floor(remaining / (candidates.length - index)))
    result[image.index] = await compressImageUrl(image.url, budget)
    remaining -= result[image.index]!.length
  }
  return result
}
