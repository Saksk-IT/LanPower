// Native image inputs keep their original encoded bytes, including animation.
export const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u

export async function prepareSubmissionImages(urls: string[]): Promise<string[]> {
  if (urls.some(url => !IMAGE_DATA_URL.test(url))) throw new Error('图片格式无效，请重新添加图片。')
  return [...urls]
}
