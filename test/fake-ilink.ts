/**
 * In-process stand-in for the iLink Bot API and the WeChat CDN, for test/e2e.ts.
 *
 * It mirrors what was observed against the real service on 2026-10-08:
 * - getuploadurl returns upload_full_url, or only upload_param when
 *   base_info.channel_version is a version below 2.1.1
 * - the CDN answers 500 to an image/video upload whose bytes are not that
 *   kind of media, and accepts anything as a file
 * - a successful upload returns its reference in the x-encrypted-param header
 */

import { createCipheriv, createDecipheriv, createHash } from 'crypto'

export type Upload = { mediaType: number; plain: Buffer; aesKeyHex: string; cipherSize: number }

export function encrypt(plain: Buffer, key: Buffer): Buffer {
  const c = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([c.update(plain), c.final()])
}

function looksLike(mediaType: number, b: Buffer): boolean {
  if (mediaType === 3) return true
  const head = b.toString('latin1', 0, 12)
  if (mediaType === 1) return head.startsWith('\x89PNG') || head.startsWith('\xff\xd8\xff') || head.startsWith('GIF8')
  return head.slice(4, 8) === 'ftyp'
}

export function startFake() {
  const state = {
    inbound: [] as any[],                    // queued for the next getupdates
    sent: [] as any[],                       // every sendmessage msg, in order
    polls: [] as string[],                   // get_updates_buf of every getupdates
    uploads: new Map<string, Upload>(),      // x-encrypted-param → what was uploaded
    uploadAttempts: [] as number[],          // media_type of every CDN upload attempt
    downloads: new Map<string, Buffer>(),    // encrypt_query_param → ciphertext to serve
    downloadHits: 0,
    refuseTokens: new Set<string>(),         // context_tokens sendmessage answers ret=-2 to
    expired: false,                          // every API call answers errcode -14
    baseInfos: [] as any[],
    authFailures: 0,
  }
  const pending = new Map<string, any>()     // filekey → getuploadurl request
  let seq = 0

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)
      const json = (o: object) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } })

      if (url.pathname.startsWith('/ilink/bot/')) {
        if (req.headers.get('authorization') !== 'Bearer test-token' ||
            req.headers.get('authorizationtype') !== 'ilink_bot_token' ||
            !req.headers.get('x-wechat-uin')) {
          state.authFailures++
          return new Response('unauthorized', { status: 401 })
        }
        const body: any = await req.json()
        state.baseInfos.push(body.base_info)
        if (state.expired) return json({ ret: -14, errcode: -14, errmsg: 'session timeout' })

        if (url.pathname === '/ilink/bot/getupdates') {
          state.polls.push(body.get_updates_buf)
          const deadline = Date.now() + 1500
          while (state.inbound.length === 0 && Date.now() < deadline && !req.signal.aborted) {
            await Bun.sleep(50)
          }
          if (req.signal.aborted) return json({ ret: 0, msgs: [] })
          const msgs = state.inbound.splice(0)
          return json({ ret: 0, msgs, get_updates_buf: `cursor-${++seq}`, longpolling_timeout_ms: 5000 })
        }

        if (url.pathname === '/ilink/bot/sendmessage') {
          const msg = body.msg
          if (msg?.item_list?.length !== 1) return json({ ret: -1, errmsg: 'item_list must hold exactly one item' })
          if (state.refuseTokens.has(msg.context_token)) return json({ ret: -2, errmsg: 'invalid context_token' })
          state.sent.push(msg)
          return json({ ret: 0 })
        }

        if (url.pathname === '/ilink/bot/getuploadurl') {
          const padded = Math.ceil((body.rawsize + 1) / 16) * 16
          const ok = /^[0-9a-f]{32}$/.test(body.filekey) && [1, 2, 3].includes(body.media_type) &&
            body.to_user_id && body.rawsize > 0 && /^[0-9a-f]{32}$/.test(body.rawfilemd5) &&
            body.filesize === padded && body.no_need_thumb === true && /^[0-9a-f]{32}$/.test(body.aeskey)
          if (!ok) return json({ ret: -1, errmsg: 'bad getuploadurl request' })
          pending.set(body.filekey, body)
          const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(body.base_info?.channel_version ?? '')
          const legacy = v !== null && (Number(v[1]) * 1e6 + Number(v[2]) * 1e3 + Number(v[3]) < 2001001)
          const param = `UP-${body.filekey}`
          return json(legacy
            ? { upload_param: param }
            : { upload_full_url: `${server.url.origin}/c2c/upload?encrypted_query_param=${param}&filekey=${body.filekey}&taskid=t${++seq}` })
        }
        return new Response('not found', { status: 404 })
      }

      if (url.pathname === '/c2c/upload' && req.method === 'POST') {
        const filekey = url.searchParams.get('filekey') ?? ''
        const want = pending.get(filekey)
        const cipher = Buffer.from(await req.arrayBuffer())
        if (!want || url.searchParams.get('encrypted_query_param') !== `UP-${filekey}`) {
          return new Response(null, { status: 400, headers: { 'x-error-message': 'unknown upload' } })
        }
        state.uploadAttempts.push(want.media_type)
        let plain: Buffer
        try {
          const d = createDecipheriv('aes-128-ecb', Buffer.from(want.aeskey, 'hex'), null)
          plain = Buffer.concat([d.update(cipher), d.final()])
        } catch {
          return new Response(null, { status: 400, headers: { 'x-error-message': 'cannot decrypt' } })
        }
        if (cipher.length !== want.filesize || plain.length !== want.rawsize ||
            createHash('md5').update(plain).digest('hex') !== want.rawfilemd5) {
          return new Response(null, { status: 400, headers: { 'x-error-message': 'size or md5 mismatch' } })
        }
        if (!looksLike(want.media_type, plain)) return new Response(null, { status: 500 })
        const ref = `DL-${filekey}`
        state.uploads.set(ref, { mediaType: want.media_type, plain, aesKeyHex: want.aeskey, cipherSize: cipher.length })
        return new Response(null, { status: 200, headers: { 'x-encrypted-param': ref } })
      }

      if (url.pathname === '/c2c/download') {
        state.downloadHits++
        const data = state.downloads.get(url.searchParams.get('encrypted_query_param') ?? '')
        if (!data) return new Response(null, { status: 400, headers: { 'x-error-message': 'invalid encrypted_param' } })
        return new Response(new Uint8Array(data))
      }

      return new Response('not found', { status: 404 })
    },
  })

  return { state, origin: server.url.origin, stop: () => server.stop(true) }
}
