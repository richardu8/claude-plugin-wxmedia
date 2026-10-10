/**
 * WeChat iLink Bot API — the JSON endpoints this channel talks to.
 *
 * Wire format follows Tencent's MIT-licensed @tencent-weixin/openclaw-weixin.
 */

import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

export const VERSION: string =
  JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version

// Protocol level we speak, numbered like openclaw-weixin releases. The server
// keys behaviour off it: below 2.1.1 getuploadurl only hands out the legacy
// upload_param instead of upload_full_url.
export const PROTOCOL_VERSION = '2.4.9'
// Who we are, User-Agent style. Observability only on the server side.
const BOT_AGENT = `wxmedia/${VERSION}`

export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

// errcode the server returns once the QR login behind the bot token has lapsed.
export const STALE_TOKEN_ERRCODE = -14

export type Api = {
  token: string
  baseUrl: string
  cdnBaseUrl: string
}

/** CDN media reference as it appears inside image/file/video items. */
export type CdnMedia = {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export type MessageItem = {
  type: number // 1 text, 2 image, 3 voice, 4 file, 5 video
  text_item?: { text?: string }
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number; hd_size?: number }
  voice_item?: { media?: CdnMedia; text?: string }
  file_item?: { media?: CdnMedia; file_name?: string; len?: string }
  video_item?: { media?: CdnMedia; video_size?: number }
}

/** The server answered, but with a non-zero ret/errcode. */
export class IlinkError extends Error {
  constructor(readonly endpoint: string, readonly code: number, errmsg?: string) {
    super(
      code === STALE_TOKEN_ERRCODE
        ? `WeChat login expired (errcode ${code}) — run /wxmedia:configure login, then restart the session`
        : `${endpoint} failed: ret=${code}${errmsg ? ` errmsg=${errmsg}` : ''}`,
    )
  }
}

function checked(endpoint: string, resp: any): any {
  const code = resp?.errcode || resp?.ret
  if (code) throw new IlinkError(endpoint, code, resp?.errmsg)
  return resp
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(api: Api): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${api.token}`,
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

async function apiFetch(
  api: Api,
  endpoint: string,
  body: object,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<any> {
  const url = new URL(endpoint, api.baseUrl.endsWith('/') ? api.baseUrl : `${api.baseUrl}/`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(api),
      body: JSON.stringify({
        ...body,
        base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT },
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`)
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * One long-poll round. A client-side timeout or an abort is the normal quiet
 * case and comes back as an empty batch. ret/errcode are left for the caller.
 */
export async function getUpdates(
  api: Api,
  buf: string,
  timeoutMs = 35000,
  signal?: AbortSignal,
): Promise<any> {
  try {
    return await apiFetch(api, 'ilink/bot/getupdates', { get_updates_buf: buf }, timeoutMs, signal)
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}

/** Send one item. iLink wants exactly one entry in item_list per request. */
export async function sendItem(
  api: Api,
  to: string,
  item: MessageItem,
  contextToken?: string,
): Promise<void> {
  checked('sendmessage', await apiFetch(api, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `claude-wxmedia-${Date.now()}-${randomBytes(4).toString('hex')}`,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [item],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
  }))
}

export type UploadUrlRequest = {
  filekey: string
  media_type: number // 1 image, 2 video, 3 file
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb: boolean
  aeskey: string
}

export async function getUploadUrl(
  api: Api,
  req: UploadUrlRequest,
): Promise<{ upload_full_url?: string; upload_param?: string }> {
  return checked('getuploadurl', await apiFetch(api, 'ilink/bot/getuploadurl', req))
}
