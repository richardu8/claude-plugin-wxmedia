#!/usr/bin/env bun
/**
 * Step 1: Fetch QR code and render it in terminal.
 * Outputs JSON as the last line: {"qrcode":"...","url":"..."}
 * so the caller can extract the qrcode token for polling.
 *
 * From m1heng/claude-plugin-weixin (MIT), modified. See NOTICE.md.
 */

const BASE_URL = process.argv[2] || 'https://ilinkai.weixin.qq.com/'
const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`

const res = await fetch(`${base}ilink/bot/get_bot_qrcode?bot_type=3`)
if (!res.ok) {
  console.error(`获取二维码失败: ${res.status}`)
  process.exit(1)
}

const data = await res.json() as any
const qrcodeToken: string = data.qrcode
const url: string = data.qrcode_img_content

// Render QR code in terminal — prints directly to stdout
const qt = (await import('qrcode-terminal')).default
qt.generate(url, { small: true })

console.log(`\n用微信扫描上方二维码，或在微信中打开以下链接：`)
console.log(`\n  ${url}\n`)

// Last line: structured data for the caller to parse
console.log(JSON.stringify({ qrcode: qrcodeToken, url }))
