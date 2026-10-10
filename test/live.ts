#!/usr/bin/env bun
/**
 * Check media transfer against the real WeChat service with this machine's login.
 *
 * Usage: bun test/live.ts [--send] <file>...
 *
 * Without --send nothing reaches anyone: each file is only encrypted and
 * uploaded to the CDN the way reply would do it. With --send each file is then
 * sent to the bot owner's own WeChat (the account that scanned the QR code).
 */

import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'

import { DEFAULT_CDN_BASE_URL, sendItem, type Api } from '../ilink'
import { kindFromPath, uploadMedia } from '../media'

const args = process.argv.slice(2)
const send = args.includes('--send')
const paths = args.filter(a => a !== '--send').map(a => resolve(a))
if (paths.length === 0) {
  console.error('usage: bun test/live.ts [--send] <file>...')
  process.exit(1)
}

const channels = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels')
const readJson = (file: string): any => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
// Before the plugin's first start its own state does not exist yet; the login it would import does.
const stateDir = [join(channels, 'wxmedia'), join(channels, 'weixin')].find(d => readJson(join(d, 'credentials.json'))?.token)
if (!stateDir) {
  console.error('no WeChat login found — run /wxmedia:configure login first')
  process.exit(1)
}
const creds = readJson(join(stateDir, 'credentials.json'))
const owner: string | undefined = creds.userId
if (!owner || !(readJson(join(stateDir, 'access.json'))?.allowFrom ?? []).includes(owner)) {
  console.error('the bot owner is not on the allowlist — refusing to pick another recipient')
  process.exit(1)
}
const api: Api = { token: creds.token, baseUrl: creds.baseUrl, cdnBaseUrl: creds.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL }
const contextToken: string | undefined = readJson(join(stateDir, 'context_tokens.json'))?.[owner]

console.log(`login: ${stateDir}  mode: ${send ? `upload and send to the owner${contextToken ? '' : ' (no stored context_token)'}` : 'upload only'}`)
let failed = 0
for (const p of paths) {
  const mb = (statSync(p).size / 1024 / 1024).toFixed(2)
  const t0 = Date.now()
  try {
    const up = await uploadMedia(api, p, owner, kindFromPath(p))
    const note = up.fellBackFrom ? ` (not accepted as ${up.fellBackFrom})` : ''
    let sent = ''
    if (send) {
      await sendItem(api, owner, up.item, contextToken)
      sent = ', sent'
    }
    console.log(`  ok   ${basename(p)} ${mb}MB → ${up.kind}${note}, ${((Date.now() - t0) / 1000).toFixed(1)}s${sent}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${basename(p)} ${mb}MB → ${err instanceof Error ? err.message : err}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
