/**
 * Media transfer over the WeChat CDN: AES-128-ECB encrypted upload and download.
 *
 * Outbound: encrypt → getuploadurl → POST ciphertext → reference it in a message item.
 * Inbound: GET ciphertext by the item's CDN reference → decrypt.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { basename, extname } from 'path'

import { getUploadUrl, IlinkError, type Api, type CdnMedia, type MessageItem } from './ilink'

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export type MediaKind = 'image' | 'video' | 'file'

// Inline kinds are limited to formats WeChat is sure to render. Everything else
// (tiff, heic, bmp, svg, mkv, ...) travels as a file so the original arrives intact.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif'])
const VIDEO_EXTS = new Set(['.mp4', '.mov'])

// media_type for getuploadurl. Not the same numbering as message item types.
const UPLOAD_MEDIA_TYPE: Record<MediaKind, number> = { image: 1, video: 2, file: 3 }

const UPLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 180_000

export function kindFromPath(path: string): MediaKind {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

// --- AES-128-ECB (PKCS7 padding is the cipher default) ---

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function paddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * CDNMedia.aes_key comes in two encodings: base64 of the raw 16 bytes (images)
 * or base64 of the 32-char hex string (file / voice / video).
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`unexpected aes_key length: ${decoded.length} bytes`)
}

// --- Upload ---

/** The CDN answered the upload with a non-200 status. */
class CdnError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`CDN upload ${status}${detail ? `: ${detail}` : ''}`)
  }
}

type Uploaded = {
  downloadParam: string
  aesKeyHex: string
  rawSize: number
  cipherSize: number
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function uploadOnce(api: Api, plaintext: Buffer, toUserId: string, kind: MediaKind): Promise<Uploaded> {
  const aesKey = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const cipherSize = paddedSize(plaintext.length)

  const resp = await getUploadUrl(api, {
    filekey,
    media_type: UPLOAD_MEDIA_TYPE[kind],
    to_user_id: toUserId,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: cipherSize,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
  })
  const url = resp.upload_full_url?.trim() ||
    (resp.upload_param
      ? `${api.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : '')
  if (!url) throw new Error('getuploadurl returned no upload URL')

  // No AbortSignal on this request. wechat-cc found that Bun, given a signal,
  // sends the body in a form the CDN stores but the WeChat client cannot
  // decrypt. The timeout races the request instead of aborting it.
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(encryptAesEcb(plaintext, aesKey)),
    }),
    Math.min(15 * 60_000, 60_000 + plaintext.length / 50),
    'CDN upload',
  )
  if (res.status !== 200) {
    throw new CdnError(res.status, res.headers.get('x-error-message') ?? '')
  }
  const downloadParam = res.headers.get('x-encrypted-param')
  if (!downloadParam) throw new Error('CDN upload response missing x-encrypted-param header')

  return { downloadParam, aesKeyHex: aesKey.toString('hex'), rawSize: plaintext.length, cipherSize }
}

// A fresh upload URL per attempt. CDN 4xx and API-level refusals are final;
// CDN 5xx and network errors are retried.
async function uploadWithRetry(
  api: Api,
  plaintext: Buffer,
  toUserId: string,
  kind: MediaKind,
  attempts: number,
): Promise<Uploaded> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadOnce(api, plaintext, toUserId, kind)
    } catch (err) {
      const final = attempt >= attempts ||
        (err instanceof CdnError ? err.status < 500 : err instanceof IlinkError)
      if (final) throw err
      process.stderr.write(`wxmedia channel: ${kind} upload attempt ${attempt} failed, retrying: ${err}\n`)
      await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }
}

function buildItem(kind: MediaKind, up: Uploaded, fileName: string): MessageItem {
  const media: CdnMedia = {
    encrypt_query_param: up.downloadParam,
    // base64 of the hex text, not of the raw key bytes
    aes_key: Buffer.from(up.aesKeyHex).toString('base64'),
    encrypt_type: 1,
  }
  if (kind === 'image') return { type: 2, image_item: { media, mid_size: up.cipherSize } }
  if (kind === 'video') return { type: 5, video_item: { media, video_size: up.cipherSize } }
  return { type: 4, file_item: { media, file_name: fileName, len: String(up.rawSize) } }
}

/**
 * Upload a local file and build the message item that references it.
 *
 * The CDN inspects image and video uploads and answers 500 when the bytes are
 * not what the media type claims (a .png that is not a PNG, an odd codec). In
 * that case the same bytes are sent as a plain file instead, which it takes
 * unconditionally.
 */
export async function uploadMedia(
  api: Api,
  filePath: string,
  toUserId: string,
  kind: MediaKind,
): Promise<{ item: MessageItem; kind: MediaKind; fellBackFrom?: MediaKind }> {
  const plaintext = readFileSync(filePath)
  const fileName = basename(filePath)
  if (kind !== 'file') {
    try {
      return { item: buildItem(kind, await uploadWithRetry(api, plaintext, toUserId, kind, 2), fileName), kind }
    } catch (err) {
      if (!(err instanceof CdnError)) throw err
      process.stderr.write(`wxmedia channel: CDN rejected ${fileName} as ${kind} (${err.message}), sending as file\n`)
    }
  }
  const up = await uploadWithRetry(api, plaintext, toUserId, 'file', UPLOAD_ATTEMPTS)
  return { item: buildItem('file', up, fileName), kind: 'file', ...(kind !== 'file' ? { fellBackFrom: kind } : {}) }
}

// --- Download ---

/**
 * Fetch and decrypt one inbound media object. `aesKeyHex` is the image item's
 * own hex key, which takes precedence over media.aes_key. Without any key the
 * bytes are stored unencrypted and returned as they are.
 */
export async function downloadMedia(
  api: Api,
  media: CdnMedia,
  aesKeyHex?: string,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<Buffer> {
  const url = media.full_url ||
    (media.encrypt_query_param
      ? `${api.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      : '')
  if (!url) throw new Error('message carries no CDN reference')

  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) {
    const detail = res.headers.get('x-error-message')
    throw new Error(`CDN download ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes + 16) {
    throw new Error(`larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit`)
  }
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length > maxBytes + 16) {
    throw new Error(`larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit`)
  }

  const key = aesKeyHex && /^[0-9a-fA-F]{32}$/.test(aesKeyHex)
    ? Buffer.from(aesKeyHex, 'hex')
    : media.aes_key ? parseAesKey(media.aes_key) : null
  return key ? decryptAesEcb(data, key) : data
}

/** File extension for a decrypted image, from its magic bytes. */
export function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 12) {
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png'
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
    if (buf.toString('latin1', 0, 4) === 'GIF8') return '.gif'
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp'
    if (buf.toString('latin1', 0, 2) === 'BM') return '.bmp'
    if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1)$/.test(buf.toString('latin1', 8, 12))) return '.heic'
  }
  return '.jpg'
}
