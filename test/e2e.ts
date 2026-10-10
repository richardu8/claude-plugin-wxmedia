#!/usr/bin/env bun
/**
 * End-to-end test of server.ts against the fake iLink/CDN in fake-ilink.ts.
 *
 * Starts the real server as an MCP subprocess, plays WeChat on one side and
 * Claude Code on the other, and checks both directions. Touches neither the
 * real WeChat account nor ~/.claude — state lives in a temp CLAUDE_CONFIG_DIR.
 *
 * Usage: bun test/e2e.ts   (from the plugin root, after `bun install`)
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

import { encrypt, startFake } from './fake-ilink'

const PLUGIN = join(import.meta.dir, '..')
const TMP = mkdtempSync(join(tmpdir(), 'wxmedia-e2e-'))
const OWNER = 'owner@im.wechat'
const fake = startFake()

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await Bun.sleep(50)
  }
  return cond()
}

function makeConfig(name: string): string {
  const dir = join(TMP, name)
  mkdirSync(join(dir, 'channels', 'wxmedia'), { recursive: true })
  writeFileSync(join(dir, 'channels', 'wxmedia', 'credentials.json'), JSON.stringify({
    token: 'test-token', baseUrl: fake.origin, cdnBaseUrl: `${fake.origin}/c2c`, userId: OWNER,
  }))
  writeFileSync(join(dir, 'channels', 'wxmedia', 'access.json'), JSON.stringify({
    dmPolicy: 'pairing', allowFrom: [OWNER], pending: {},
  }))
  return dir
}

type StartOpts = { poll?: 'always' | 'auto'; channelFlag?: boolean; sessionId?: string; installedAs?: string }

// For poll: 'auto' the server looks for its claude ancestor. Give it one: a
// shell that goes by the name `claude`, with or without the channel flag.
const fakeClaude = join(TMP, 'bin', 'claude')
mkdirSync(dirname(fakeClaude))
symlinkSync('/bin/sh', fakeClaude)

async function start(configDir: string, opts: StartOpts = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
  env.CLAUDE_CONFIG_DIR = configDir
  delete env.WXMEDIA_POLL
  // The server looks its session's transcript up by this id. Without one the
  // origin of the latest input is simply unknown to it.
  delete env.CLAUDE_CODE_SESSION_ID
  if (opts.sessionId) env.CLAUDE_CODE_SESSION_ID = opts.sessionId
  // Claude Code names this directory after the installed plugin id.
  delete env.CLAUDE_PLUGIN_DATA
  if (opts.installedAs) env.CLAUDE_PLUGIN_DATA = join(configDir, 'plugins', 'data', opts.installedAs)
  if ((opts.poll ?? 'always') === 'always') env.WXMEDIA_POLL = 'always'
  const flag = opts.channelFlag ? ['--dangerously-load-development-channels', 'plugin:wxmedia@test-marketplace'] : []
  const transport = opts.poll === 'auto'
    ? new StdioClientTransport({
        command: fakeClaude,
        args: ['-c', 'bun server.ts; true', 'claude', ...flag, '--resume'],
        cwd: PLUGIN, env, stderr: 'pipe',
      })
    : new StdioClientTransport({ command: 'bun', args: ['server.ts'], cwd: PLUGIN, env, stderr: 'pipe' })
  const logs: string[] = []
  transport.stderr?.on('data', d => logs.push(String(d)))
  const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
  const events: any[] = []
  const verdicts: any[] = []
  client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') events.push(n.params)
    if (n.method === 'notifications/claude/channel/permission') verdicts.push(n.params)
  }
  await client.connect(transport)
  // What Claude Code sends a channel when a tool-approval dialog opens.
  const askPermission = (request_id: string, tool_name = 'Bash') => client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id, tool_name, description: 'List files', input_preview: '{"command":"ls -la"}' },
  } as any)
  const reply = async (args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name: 'reply', arguments: args })
    return { text: r.content[0].text as string, isError: Boolean(r.isError) }
  }
  return { client, events, verdicts, logs, reply, askPermission, pid: transport.pid!, log: () => logs.join(''), close: () => client.close() }
}

// Transcript lines the way Claude Code writes them, as far as the relay reads them.
const fromWechat = (user = OWNER) => ({
  type: 'user', isMeta: true, origin: { kind: 'channel', server: 'plugin:wxmedia:wxmedia' }, promptSource: 'system',
  message: { role: 'user', content: `<channel source="plugin:wxmedia:wxmedia" user_id="${user}" context_token="t" ts="2026-10-10T00:00:00.000Z">\n帮我选一个\n</channel>` },
})
const fromTerminal = () => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '终端里布置的任务' } })
const askCall = (id: string, questions: any[]) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
})
const toolResult = (id: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] } })
function writeTranscript(file: string, entries: object[]): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return file
}

let ctxSeq = 0
function inbound(from: string, items: any[]): any {
  const msg = { message_type: 1, from_user_id: from, context_token: `ctx-${++ctxSeq}`, create_time_ms: 1760000000000, item_list: items }
  fake.state.inbound.push(msg)
  return msg
}

// Sample payloads. The fake CDN only looks at magic bytes, like the real one seems to.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(5000)])
const MP4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), randomBytes(9000)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(70000)])
const BMP = Buffer.concat([Buffer.from('BM'), randomBytes(3000)])
const DOCX = Buffer.concat([Buffer.from('504b0304', 'hex'), randomBytes(20000)])
const files = join(TMP, 'files')
mkdirSync(files)
const path = (name: string, data: Buffer) => { writeFileSync(join(files, name), data); return join(files, name) }
const pngPath = path('figure.png', PNG)
const mp4Path = path('clip.mp4', MP4)
const pdfPath = path('paper.pdf', PDF)
const bmpPath = path('scan.bmp', BMP)
const notPngPath = path('renamed.png', BMP) // image extension, but not image bytes
const docxPath = path('修回稿 v2.docx', DOCX)
const b64hex = (key: Buffer) => Buffer.from(key.toString('hex')).toString('base64')

function checkMedia(label: string, msg: any, type: number, plain: Buffer, fileName?: string): void {
  const item = msg?.item_list?.[0] ?? {}
  const body = item.image_item ?? item.video_item ?? item.file_item ?? {}
  const up = fake.state.uploads.get(body.media?.encrypt_query_param)
  const sizeOk = type === 2 ? body.mid_size === up?.cipherSize
    : type === 5 ? body.video_size === up?.cipherSize
    : body.len === String(plain.length) && body.file_name === fileName
  check(`${label}: item type ${type}`, item.type === type, `got ${item.type}`)
  check(`${label}: uploaded bytes match the file`, Boolean(up?.plain.equals(plain)))
  check(`${label}: aes_key is base64 of the hex key`, Buffer.from(body.media?.aes_key ?? '', 'base64').toString() === up?.aesKeyHex)
  check(`${label}: encrypt_type and size fields`, body.media?.encrypt_type === 1 && sizeOk, JSON.stringify(body).slice(0, 200))
}

try {
  // ───────────────────────── basic session ─────────────────────────
  console.log('\n[1] tool surface')
  const cfg = makeConfig('main')
  let a = await start(cfg)
  const tools: any = await a.client.listTools()
  const replyTool = tools.tools.find((t: any) => t.name === 'reply')
  check('reply tool is listed', Boolean(replyTool))
  check('reply takes files and as_file', Boolean(replyTool?.inputSchema.properties.files && replyTool?.inputSchema.properties.as_file))
  check('instructions mention attachments', /image_path/.test(a.client.getInstructions() ?? '') && /attachment_path/.test(a.client.getInstructions() ?? ''))
  check('no setup warning by default', !/Setup problem/.test(a.client.getInstructions() ?? ''))
  const stateDir = join(cfg, 'channels', 'wxmedia')
  const inbox = join(stateDir, 'inbox')

  console.log('\n[2] inbound text')
  const m1 = inbound(OWNER, [{ type: 1, text_item: { text: '你好' } }])
  check('text delivered', await waitFor(() => a.events.length === 1, 5000))
  check('content and meta', a.events[0]?.content === '你好' && a.events[0]?.meta.user_id === OWNER &&
    a.events[0]?.meta.context_token === m1.context_token && a.events[0]?.meta.ts === '2025-10-09T08:53:20.000Z', JSON.stringify(a.events[0]))
  check('protocol version sent in base_info', fake.state.baseInfos.every(b => b?.channel_version === '2.4.9' && /^wxmedia\//.test(b?.bot_agent)))

  console.log('\n[3] inbound image (hex aeskey on the item)')
  const k1 = randomBytes(16)
  fake.state.downloads.set('IMG1', encrypt(PNG, k1))
  inbound(OWNER, [{ type: 2, image_item: { aeskey: k1.toString('hex'), media: { encrypt_query_param: 'IMG1', aes_key: b64hex(k1), encrypt_type: 1 }, mid_size: 5024 } }])
  check('image delivered', await waitFor(() => a.events.length === 2, 5000))
  const img = a.events[1]?.meta.image_path
  check('image saved to inbox as .png', Boolean(img) && dirname(img) === inbox && img.endsWith('.png') && readFileSync(img).equals(PNG), String(img))
  check('content is a placeholder, path only in meta', a.events[1]?.content === '(image)')

  console.log('\n[4] inbound file (base64-of-hex key)')
  const k2 = randomBytes(16)
  fake.state.downloads.set('FILE1', encrypt(DOCX, k2))
  inbound(OWNER, [{ type: 4, file_item: { media: { encrypt_query_param: 'FILE1', aes_key: b64hex(k2) }, file_name: '修回稿 v2.docx', len: String(DOCX.length) } }])
  check('file delivered', await waitFor(() => a.events.length === 3, 5000))
  const f = a.events[2]?.meta
  check('file saved with its name', Boolean(f?.attachment_path) && dirname(f.attachment_path) === inbox && f.attachment_path.endsWith('修回稿 v2.docx') && readFileSync(f.attachment_path).equals(DOCX), JSON.stringify(f))
  check('file meta', f?.attachment_kind === 'file' && f?.attachment_name === '修回稿 v2.docx' && f?.attachment_size === String(DOCX.length) && a.events[2]?.content === '(file: 修回稿 v2.docx)')
  const receivedDocx = f?.attachment_path as string

  console.log('\n[5] inbound video (raw-bytes key, full_url)')
  const k3 = randomBytes(16)
  fake.state.downloads.set('VID1', encrypt(MP4, k3))
  inbound(OWNER, [{ type: 5, video_item: { media: { full_url: `${fake.origin}/c2c/download?encrypted_query_param=VID1`, aes_key: k3.toString('base64') }, video_size: 9040 } }])
  check('video delivered', await waitFor(() => a.events.length === 4, 5000))
  const v = a.events[3]?.meta
  check('video saved as .mp4', v?.attachment_kind === 'video' && String(v?.attachment_path).endsWith('.mp4') && readFileSync(v.attachment_path).equals(MP4), JSON.stringify(v))

  console.log('\n[6] inbound edge cases')
  inbound(OWNER, [{ type: 4, file_item: { media: { encrypt_query_param: 'FILE1', aes_key: b64hex(k2) }, file_name: '../../evil<n>;[x]".sh', len: String(DOCX.length) } }])
  check('hostile file name delivered', await waitFor(() => a.events.length === 5, 5000))
  const evil = a.events[4]?.meta
  check('hostile name stays inside the inbox', dirname(String(evil?.attachment_path)) === inbox && !/[<>\[\];"]/.test(evil?.attachment_name + a.events[4]?.content), JSON.stringify(a.events[4]))
  const hitsBefore = fake.state.downloadHits
  inbound(OWNER, [{ type: 4, file_item: { media: { encrypt_query_param: 'FILE1', aes_key: b64hex(k2) }, file_name: 'huge.zip', len: String(300 * 1024 * 1024) } }])
  check('oversized file announced, not downloaded', await waitFor(() => a.events.length === 6, 5000) &&
    /over the 100MB download limit/.test(a.events[5]?.content) && !a.events[5]?.meta.attachment_path && fake.state.downloadHits === hitsBefore, JSON.stringify(a.events[5]))
  inbound(OWNER, [{ type: 4, file_item: { media: { encrypt_query_param: 'GONE', aes_key: b64hex(k2) }, file_name: 'gone.pdf', len: '10' } }])
  check('failed download still delivers the message', await waitFor(() => a.events.length === 7, 5000) && a.events[6]?.content === '(file: gone.pdf — download failed)')
  inbound(OWNER, [{ type: 3, voice_item: { text: '语音转文字' } }])
  check('voice transcript delivered as text', await waitFor(() => a.events.length === 8, 5000) && a.events[7]?.content === '语音转文字')

  console.log('\n[7] stranger is gated before any download')
  const hits = fake.state.downloadHits
  fake.state.sent.length = 0
  inbound('stranger@im.wechat', [{ type: 2, image_item: { aeskey: k1.toString('hex'), media: { encrypt_query_param: 'IMG1' } } }])
  check('stranger gets a pairing code', await waitFor(() => fake.state.sent.length === 1, 5000) &&
    /\/wxmedia:access pair [0-9a-f]{6}/.test(fake.state.sent[0]?.item_list[0].text_item.text) && fake.state.sent[0]?.to_user_id === 'stranger@im.wechat')
  await Bun.sleep(500)
  check('nothing delivered or downloaded for the stranger', a.events.length === 8 && fake.state.downloadHits === hits)

  // ───────────────────────── outbound ─────────────────────────
  console.log('\n[8] reply with text, image, video, files')
  fake.state.sent.length = 0
  fake.state.uploadAttempts.length = 0
  let r = await a.reply({ user_id: OWNER, context_token: 'ctx-1', text: '文件来了', files: [pngPath, mp4Path, pdfPath, bmpPath, notPngPath, docxPath] })
  check('reply succeeded', !r.isError, r.text)
  check('seven messages, one item each, token echoed', fake.state.sent.length === 7 && fake.state.sent.every(m => m.item_list.length === 1 && m.context_token === 'ctx-1' && m.to_user_id === OWNER && m.message_type === 2 && m.message_state === 2))
  check('text goes first', fake.state.sent[0]?.item_list[0].text_item?.text === '文件来了')
  checkMedia('png', fake.state.sent[1], 2, PNG)
  checkMedia('mp4', fake.state.sent[2], 5, MP4)
  checkMedia('pdf', fake.state.sent[3], 4, PDF, 'paper.pdf')
  checkMedia('bmp goes as a file', fake.state.sent[4], 4, BMP, 'scan.bmp')
  checkMedia('rejected image falls back to file', fake.state.sent[5], 4, BMP, 'renamed.png')
  checkMedia('docx', fake.state.sent[6], 4, DOCX, '修回稿 v2.docx')
  check('rejected image was tried as image twice, then as file', fake.state.uploadAttempts.join(',') === '1,2,3,3,1,1,3,3', fake.state.uploadAttempts.join(','))
  check('result names what was sent', /figure\.png as image/.test(r.text) && /clip\.mp4 as video/.test(r.text) && /scan\.bmp as file,/.test(r.text) &&
    /renamed\.png as file \(WeChat did not accept it as image\)/.test(r.text), r.text)

  console.log('\n[9] defaults: no user_id, no context_token, files only')
  fake.state.sent.length = 0
  r = await a.reply({ files: [pdfPath] })
  check('sent to the only allowlisted user with the latest token', !r.isError && fake.state.sent.length === 1 &&
    fake.state.sent[0].to_user_id === OWNER && fake.state.sent[0].context_token === `ctx-${ctxSeq - 1}`, `${r.text} ${JSON.stringify(fake.state.sent[0])?.slice(0, 200)}`)

  console.log('\n[10] as_file, and forwarding a received file')
  fake.state.sent.length = 0
  r = await a.reply({ text: '', files: [pngPath, receivedDocx], as_file: true })
  check('as_file sends the png as a file', !r.isError && fake.state.sent.length === 2, r.text)
  checkMedia('png as file', fake.state.sent[0], 4, PNG, 'figure.png')
  checkMedia('inbox file can be sent back', fake.state.sent[1], 4, DOCX, basename(receivedDocx))

  console.log('\n[11] refused context_token falls back to the latest one')
  fake.state.sent.length = 0
  fake.state.refuseTokens.add('stale-token')
  r = await a.reply({ user_id: OWNER, context_token: 'stale-token', text: 'a', files: [pngPath] })
  check('both messages went out with the latest token', !r.isError && fake.state.sent.length === 2 && fake.state.sent.every(m => m.context_token === `ctx-${ctxSeq - 1}`), r.text)

  console.log('\n[12] refusals')
  fake.state.sent.length = 0
  r = await a.reply({ user_id: 'stranger@im.wechat', text: 'hi' })
  check('non-allowlisted recipient', r.isError && /not allowlisted/.test(r.text), r.text)
  r = await a.reply({ text: '   ' })
  check('empty reply', r.isError && /nothing to send/.test(r.text), r.text)
  r = await a.reply({ text: 'x', files: ['figure.png'] })
  check('relative path', r.isError && /absolute/.test(r.text), r.text)
  r = await a.reply({ text: 'x', files: [join(files, 'missing.pdf')] })
  check('missing file', r.isError && /ENOENT/.test(r.text), r.text)
  r = await a.reply({ text: 'x', files: [join(stateDir, 'credentials.json')] })
  check('own credentials', r.isError && /refusing to send channel state/.test(r.text), r.text)
  mkdirSync(join(cfg, 'channels', 'telegram'))
  writeFileSync(join(cfg, 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=x')
  r = await a.reply({ text: 'x', files: [join(cfg, 'channels', 'telegram', '.env')] })
  check("another channel's state", r.isError && /refusing to send channel state/.test(r.text), r.text)
  const empty = path('empty.txt', Buffer.alloc(0))
  r = await a.reply({ text: 'x', files: [pdfPath, empty] })
  check('empty file', r.isError && /file is empty/.test(r.text), r.text)
  check('a refused reply sends nothing at all', fake.state.sent.length === 0, String(fake.state.sent.length))

  console.log('\n[13] long text is chunked')
  fake.state.sent.length = 0
  r = await a.reply({ text: ('段落。'.repeat(300) + '\n\n').repeat(4) })
  check('chunks of at most 2000 chars', !r.isError && fake.state.sent.length > 1 && fake.state.sent.every(m => m.item_list[0].text_item.text.length <= 2000), `${fake.state.sent.length} ${r.text}`)

  console.log('\n[14] state on disk, and restart')
  check('context tokens persisted privately', JSON.parse(readFileSync(join(stateDir, 'context_tokens.json'), 'utf8'))[OWNER] === `ctx-${ctxSeq - 1}` &&
    (statSync(join(stateDir, 'context_tokens.json')).mode & 0o077) === 0)
  check('cursor persisted', /^cursor-\d+$/.test(readFileSync(join(stateDir, 'sync_buf.txt'), 'utf8')))
  await a.close()
  check('heartbeat file removed on exit', await waitFor(() => readdirSync(join(stateDir, 'pollers')).length === 0, 3000), readdirSync(join(stateDir, 'pollers')).join(','))
  a = await start(cfg, { sessionId: 'sess-main' })
  fake.state.sent.length = 0
  fake.state.polls.length = 0
  r = await a.reply({ text: '重启后' })
  check('reply after restart uses the persisted token', !r.isError && fake.state.sent[0]?.context_token === `ctx-${ctxSeq - 1}`, r.text)
  check('polling resumes from the saved cursor', await waitFor(() => fake.state.polls.length > 0, 3000) && /^cursor-\d+$/.test(fake.state.polls[0]), fake.state.polls[0])

  // ───────────────────────── approvals and questions on WeChat ─────────────────────────
  const sessTranscript = join(cfg, 'projects', 'proj', 'sess-main.jsonl')
  const setRelay = (mode?: string) => {
    const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8'))
    if (mode) access.relay = mode
    else delete access.relay
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify(access))
  }
  const lastText = () => fake.state.sent.at(-1)?.item_list[0].text_item?.text ?? ''
  const pendingCount = () => existsSync(join(stateDir, 'pending')) ? readdirSync(join(stateDir, 'pending')).length : 0

  console.log('\n[15] tool approval goes to WeChat when the task came from WeChat')
  writeTranscript(sessTranscript, [fromTerminal(), fromWechat()])
  fake.state.sent.length = 0
  let seen = a.events.length
  await a.askPermission('abcde')
  check('prompt sent to the WeChat sender', await waitFor(() => fake.state.sent.length === 1, 3000) && fake.state.sent[0].to_user_id === OWNER &&
    /需要审批/.test(lastText()) && /Bash/.test(lastText()) && /ls -la/.test(lastText()) && /abcde/.test(lastText()), lastText())
  inbound(OWNER, [{ type: 1, text_item: { text: 'y' } }])
  check('bare "y" becomes an allow verdict', await waitFor(() => a.verdicts.length === 1, 4000) && a.verdicts[0]?.request_id === 'abcde' && a.verdicts[0]?.behavior === 'allow', JSON.stringify(a.verdicts))
  check('the reply is acknowledged and not passed to Claude', await waitFor(() => /已转达：允许/.test(lastText()), 2000) && a.events.length === seen && pendingCount() === 0)
  await a.askPermission('bcdef')
  await waitFor(() => /bcdef/.test(lastText()), 3000)
  inbound(OWNER, [{ type: 1, text_item: { text: 'N bcdef' } }])
  check('"n <id>" becomes a deny verdict', await waitFor(() => a.verdicts.length === 2, 4000) && a.verdicts[1]?.request_id === 'bcdef' && a.verdicts[1]?.behavior === 'deny', JSON.stringify(a.verdicts))
  await a.askPermission('cdefg')
  await waitFor(() => /cdefg/.test(lastText()), 3000)
  inbound(OWNER, [{ type: 1, text_item: { text: '先别急，我看看' } }])
  check('other text passes through to Claude while an approval is open', await waitFor(() => a.events.length === seen + 1, 4000) && a.events[seen]?.content === '先别急，我看看' && a.verdicts.length === 2)
  inbound(OWNER, [{ type: 1, text_item: { text: '同意' } }])
  check('"同意" is an allow verdict', await waitFor(() => a.verdicts.length === 3, 4000) && a.verdicts[2]?.request_id === 'cdefg' && a.verdicts[2]?.behavior === 'allow')
  seen = a.events.length

  console.log('\n[16] relay setting and task origin')
  writeTranscript(sessTranscript, [fromWechat(), fromTerminal()])
  fake.state.sent.length = 0
  await a.askPermission('defgh')
  await Bun.sleep(1200)
  check('auto: a task typed at the terminal is not relayed', fake.state.sent.length === 0 && pendingCount() === 0)
  setRelay('always')
  await a.askPermission('efghi')
  check('always: relayed regardless of origin', await waitFor(() => /efghi/.test(lastText()), 3000))
  setRelay('never')
  writeTranscript(sessTranscript, [fromWechat()])
  fake.state.sent.length = 0
  await a.askPermission('fghij')
  await Bun.sleep(1200)
  check('never: not relayed even for a WeChat task', fake.state.sent.length === 0)
  setRelay()
  rmSync(sessTranscript)
  await a.askPermission('ghijk')
  check('auto with unknown origin errs on the side of asking', await waitFor(() => /ghijk/.test(lastText()), 3000))
  writeTranscript(sessTranscript, [fromWechat()])
  fake.state.sent.length = 0
  await a.askPermission('hijkm', 'AskUserQuestion')
  await a.askPermission('ijkmn', 'ExitPlanMode')
  await Bun.sleep(1200)
  check('dialogs a yes/no cannot answer are left alone', fake.state.sent.length === 0)
  check('the relay setting survives the server rewriting access.json', (() => {
    setRelay('always')
    inbound('another-stranger@im.wechat', [{ type: 1, text_item: { text: 'hi' } }])
    return true
  })() && await waitFor(() => /pair/.test(lastText()), 4000) && JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')).relay === 'always')
  setRelay()

  console.log('\n[17] a late bare "y" is not taken as a verdict')
  for (const f of readdirSync(join(stateDir, 'pending'))) rmSync(join(stateDir, 'pending', f))
  writeFileSync(join(stateDir, 'pending', 'jkmnp.json'), JSON.stringify({
    id: 'jkmnp', kind: 'permission', users: [OWNER], owner: a.pid, createdAt: Date.now() - 11 * 60_000, expiresAt: Date.now() + 3600_000,
  }))
  seen = a.events.length
  inbound(OWNER, [{ type: 1, text_item: { text: 'y' } }])
  check('after ten minutes "y" is an ordinary message', await waitFor(() => a.events.length === seen + 1, 4000) && a.events[seen]?.content === 'y')
  inbound(OWNER, [{ type: 1, text_item: { text: 'y jkmnp' } }])
  await Bun.sleep(2500)
  check('"y <id>" still counts', a.events.length === seen + 1 && existsSync(join(stateDir, 'answers', 'jkmnp.json')))
  rmSync(join(stateDir, 'pending', 'jkmnp.json'))
  rmSync(join(stateDir, 'answers', 'jkmnp.json'))
  writeFileSync(join(stateDir, 'pending', 'kmnpq.json'), JSON.stringify({
    id: 'kmnpq', kind: 'question', users: [OWNER], owner: 999999, createdAt: Date.now(), expiresAt: Date.now() + 3600_000,
  }))
  seen = a.events.length
  inbound(OWNER, [{ type: 1, text_item: { text: '这条不该被吞掉' } }])
  check('a prompt whose owner is gone does not swallow messages', await waitFor(() => a.events.length === seen + 1, 4000) && pendingCount() === 0)

  fake.state.sent.length = 0
  await a.askPermission('npqrs')
  await waitFor(() => /npqrs/.test(lastText()), 3000)
  r = await a.reply({ text: '顺便问一句，要继续吗？' })
  seen = a.events.length
  inbound(OWNER, [{ type: 1, text_item: { text: 'y' } }])
  check('once Claude replies again, an unanswered approval is closed and "y" is a message', !r.isError && await waitFor(() => a.events.length === seen + 1, 4000) &&
    a.events[seen]?.content === 'y' && pendingCount() === 0, `${r.text} ${pendingCount()}`)

  console.log('\n[18] multiple-choice question hook')
  const Q1 = { question: '用哪个方案？', header: '方案', multiSelect: false, options: [{ label: '方案甲', description: '改动小' }, { label: '方案乙', description: '更彻底' }, { label: '都不要' }] }
  const Q2 = { question: '要哪些格式？', header: '格式', multiSelect: true, options: [{ label: 'PDF' }, { label: 'Word' }, { label: 'Markdown' }] }
  const hookTranscript = join(TMP, 'hook', 'session.jsonl')
  type HookRun = { done: Promise<{ stdout: string; code: number }>; kill: () => void }
  function runHook(input: object | string, env: Record<string, string> = {}): HookRun {
    const proc = Bun.spawn(['bun', join(PLUGIN, 'hooks', 'ask.ts')], {
      stdin: new Blob([typeof input === 'string' ? input : JSON.stringify(input)]),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, ...env },
    })
    return {
      done: (async () => ({ stdout: await new Response(proc.stdout).text(), code: await proc.exited }))(),
      kill: () => proc.kill('SIGTERM'),
    }
  }
  const hookInput = (questions: any[], transcript = hookTranscript) => ({
    session_id: 's', transcript_path: transcript, cwd: TMP, permission_mode: 'bypassPermissions',
    hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions },
  })
  const answerOnWechat = async (text: string, waitForPrompt: RegExp) => {
    await waitFor(() => waitForPrompt.test(lastText()), 5000)
    inbound(OWNER, [{ type: 1, text_item: { text } }])
  }

  writeTranscript(hookTranscript, [fromWechat(), askCall('toolu_q1', [Q1])])
  fake.state.sent.length = 0
  seen = a.events.length
  let hook = runHook(hookInput([Q1]))
  check('question arrives on WeChat with numbered options', await waitFor(() => fake.state.sent.length === 1, 5000) &&
    /【Claude提问】方案/.test(lastText()) && /用哪个方案？/.test(lastText()) && /1\. 方案甲：改动小/.test(lastText()) && /3\. 都不要/.test(lastText()), lastText())
  inbound(OWNER, [{ type: 1, text_item: { text: '2' } }])
  let out = await hook.done
  let decision = JSON.parse(out.stdout || '{}').hookSpecificOutput
  check('the hook answers with the chosen label', out.code === 0 && decision?.hookEventName === 'PermissionRequest' && decision?.decision.behavior === 'allow' &&
    decision?.decision.updatedInput.answers['用哪个方案？'] === '方案乙' && decision?.decision.updatedInput.questions.length === 1, out.stdout)
  check('the answer is confirmed on WeChat and kept from Claude', await waitFor(() => /已收到：方案乙/.test(lastText()), 3000) && a.events.length === seen && pendingCount() === 0)

  writeTranscript(hookTranscript, [fromWechat(), askCall('toolu_q2', [Q1, Q2])])
  fake.state.sent.length = 0
  hook = runHook(hookInput([Q1, Q2]))
  await answerOnWechat('9', /提问1\/2/)
  check('an option that does not exist gets a hint', await waitFor(() => /没有这个选项/.test(lastText()), 5000), lastText())
  inbound(OWNER, [{ type: 1, text_item: { text: '我想先看看再说' } }])
  await answerOnWechat('1，3', /提问2\/2/)
  out = await hook.done
  decision = JSON.parse(out.stdout || '{}').hookSpecificOutput?.decision
  check('free text and a multi-select both come back', decision?.updatedInput.answers['用哪个方案？'] === '我想先看看再说' && decision?.updatedInput.answers['要哪些格式？'] === 'PDF, Markdown', out.stdout)

  writeTranscript(hookTranscript, [fromWechat(), fromTerminal(), askCall('toolu_q3', [Q1])])
  fake.state.sent.length = 0
  out = await runHook(hookInput([Q1])).done
  check('auto: a question in a terminal task stays in the terminal', out.stdout === '' && out.code === 0 && fake.state.sent.length === 0)
  setRelay('always')
  hook = runHook(hookInput([Q1]))
  await answerOnWechat('方案甲', /用哪个方案/)
  out = await hook.done
  check('always: relayed, and a label typed out is accepted', JSON.parse(out.stdout || '{}').hookSpecificOutput?.decision.updatedInput.answers['用哪个方案？'] === '方案甲', out.stdout)
  setRelay('never')
  writeTranscript(hookTranscript, [fromWechat(), askCall('toolu_q4', [Q1])])
  fake.state.sent.length = 0
  out = await runHook(hookInput([Q1])).done
  check('never: not relayed', out.stdout === '' && fake.state.sent.length === 0)
  setRelay()

  fake.state.sent.length = 0
  hook = runHook(hookInput([Q1]))
  await waitFor(() => fake.state.sent.length === 1, 5000)
  writeFileSync(hookTranscript, readFileSync(hookTranscript, 'utf8') + JSON.stringify(toolResult('toolu_q4')) + '\n')
  out = await hook.done
  check('an answer given at the terminal ends the wait', out.stdout === '' && /已经在电脑上回答了/.test(lastText()) && pendingCount() === 0, `${out.stdout} ${lastText()}`)
  seen = a.events.length
  inbound(OWNER, [{ type: 1, text_item: { text: '2' } }])
  check('and the next message is an ordinary one again', await waitFor(() => a.events.length === seen + 1, 4000) && a.events[seen]?.content === '2')

  writeTranscript(hookTranscript, [fromWechat(), askCall('toolu_q5', [Q1])])
  fake.state.sent.length = 0
  out = await runHook(hookInput([Q1]), { WXMEDIA_ASK_WAIT_MS: '1500' }).done
  check('giving up after the wait says so on WeChat', out.stdout === '' && /等得太久/.test(lastText()) && pendingCount() === 0, lastText())
  fake.state.sent.length = 0
  hook = runHook(hookInput([Q1]))
  await waitFor(() => fake.state.sent.length === 1, 5000)
  hook.kill()
  out = await hook.done
  check('a killed hook leaves nothing pending', out.stdout === '' && pendingCount() === 0)

  fake.state.sent.length = 0
  out = await runHook(hookInput([Q2])).done
  check('a call that cannot be traced in the transcript is not relayed', out.stdout === '' && fake.state.sent.length === 0)
  out = await runHook('not json').done
  check('broken input: silent, exit 0', out.stdout === '' && out.code === 0)
  out = await runHook({ ...hookInput([Q1]), tool_name: 'Bash' }).done
  check('other tools: silent', out.stdout === '')
  const lonely = makeConfig('no-poller')
  out = await runHook(hookInput([Q1]), { CLAUDE_CONFIG_DIR: lonely }).done
  check('no channel session up: silent', out.stdout === '' && fake.state.sent.length === 0)

  // ───────────────────────── who polls ─────────────────────────
  console.log('\n[19] newest channel session polls, the older one stands by and takes over again')
  const b = await start(cfg)
  check('older session stands by', await waitFor(() => /standing by/.test(a.log()), 9000), a.log())
  const na = a.events.length
  inbound(OWNER, [{ type: 1, text_item: { text: 'to the newest' } }])
  check('newest session receives', await waitFor(() => b.events.length === 1, 5000) && b.events[0]?.content === 'to the newest')
  await Bun.sleep(1500)
  check('older session did not', a.events.length === na)

  console.log('\n[20] an approval asked by the standing-by session is answered through the polling one')
  writeTranscript(sessTranscript, [fromWechat()])
  const nv = a.verdicts.length
  await a.askPermission('mnpqr')
  check('the standing-by session still puts its prompt on WeChat', await waitFor(() => /mnpqr/.test(lastText()), 4000), lastText())
  inbound(OWNER, [{ type: 1, text_item: { text: 'y mnpqr' } }])
  check('its verdict comes back to it, not to the polling session', await waitFor(() => a.verdicts.length === nv + 1, 5000) &&
    a.verdicts[nv]?.request_id === 'mnpqr' && a.verdicts[nv]?.behavior === 'allow' && b.verdicts.length === 0 && b.events.length === 1, JSON.stringify([a.verdicts, b.verdicts]))
  await b.close()
  check('older session resumes', await waitFor(() => /polling again/.test(a.log()), 9000), a.log())
  inbound(OWNER, [{ type: 1, text_item: { text: 'back to the older' } }])
  check('older session receives again', await waitFor(() => a.events.length === na + 1, 5000) && a.events[na]?.content === 'back to the older')
  await a.close()
  await Bun.sleep(300)

  console.log('\n[21] a session not launched as this channel does not poll')
  fake.state.polls.length = 0
  fake.state.sent.length = 0
  const idle = await start(cfg, { poll: 'auto' })
  await Bun.sleep(2500)
  check('no getupdates from it', fake.state.polls.length === 0 && /not polling for inbound messages/.test(idle.log()), `${fake.state.polls.length} ${idle.log()}`)
  r = await idle.reply({ text: '主动发送', files: [pngPath] })
  check('its reply tool still works', !r.isError && fake.state.sent.length === 2, r.text)
  inbound(OWNER, [{ type: 1, text_item: { text: 'waiting for a channel session' } }])
  await Bun.sleep(1500)
  check('message stays queued', idle.events.length === 0 && fake.state.inbound.length === 1)
  const flagged = await start(cfg, { poll: 'auto', channelFlag: true })
  check('a session with the channel flag picks it up', await waitFor(() => flagged.events.length === 1, 6000) && idle.events.length === 0, flagged.log())
  await idle.close()
  await flagged.close()

  console.log('\n[21b] a session launched with wxmedia from another marketplace does not poll either')
  fake.state.polls.length = 0
  const stale = await start(cfg, { poll: 'auto', channelFlag: true, installedAs: 'wxmedia-renamed-marketplace' })
  await Bun.sleep(2500)
  check('no getupdates from it', fake.state.polls.length === 0 && /installed as wxmedia-renamed-marketplace/.test(stale.log()), `${fake.state.polls.length} ${stale.log()}`)
  check('the session is told why', /NOT being received/.test(stale.client.getInstructions() ?? '') && /plugin:wxmedia@test-marketplace/.test(stale.client.getInstructions() ?? ''), stale.client.getInstructions())
  inbound(OWNER, [{ type: 1, text_item: { text: 'not for the stale alias' } }])
  await Bun.sleep(1500)
  check('message stays queued', stale.events.length === 0 && fake.state.inbound.length === 1)
  const right = await start(cfg, { poll: 'auto', channelFlag: true, installedAs: 'wxmedia-test-marketplace' })
  check('the matching install picks it up', await waitFor(() => right.events.length === 1, 6000) && stale.events.length === 0, right.log())
  check('and carries no warning', !/NOT being received/.test(right.client.getInstructions() ?? ''))
  await stale.close()
  await right.close()
  await Bun.sleep(300)

  // ───────────────────────── migration and expiry ─────────────────────────
  console.log('\n[22] first start imports the weixin plugin state')
  const mig = join(TMP, 'migrate')
  const legacy = join(mig, 'channels', 'weixin')
  mkdirSync(legacy, { recursive: true })
  const legacyCreds = JSON.stringify({ token: 'test-token', baseUrl: fake.origin, cdnBaseUrl: `${fake.origin}/c2c`, userId: OWNER })
  writeFileSync(join(legacy, 'credentials.json'), legacyCreds)
  writeFileSync(join(legacy, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER], pending: {} }))
  writeFileSync(join(legacy, 'sync_buf.txt'), 'legacy-cursor-123')
  fake.state.polls.length = 0
  const m = await start(mig)
  const own = join(mig, 'channels', 'wxmedia')
  check('credentials and access copied, private', await waitFor(() => existsSync(join(own, 'access.json')), 3000) &&
    readFileSync(join(own, 'credentials.json'), 'utf8') === legacyCreds && (statSync(join(own, 'credentials.json')).mode & 0o077) === 0 &&
    JSON.parse(readFileSync(join(own, 'access.json'), 'utf8')).dmPolicy === 'allowlist')
  check('first poll resumes from the weixin cursor', await waitFor(() => fake.state.polls.length > 0, 3000) && fake.state.polls[0] === 'legacy-cursor-123', fake.state.polls[0])
  check('weixin plugin files untouched', readFileSync(join(legacy, 'sync_buf.txt'), 'utf8') === 'legacy-cursor-123' && readdirSync(legacy).length === 3)
  await m.close()
  await Bun.sleep(300)

  console.log('\n[23] warns when the weixin plugin is enabled alongside')
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'weixin@m1heng-plugins': true, 'wxmedia@richardu8-plugins': true } }))
  const w = await start(cfg)
  check('polling session carries the warning', /claude plugin disable weixin@m1heng-plugins/.test(w.client.getInstructions() ?? ''), w.client.getInstructions())
  await w.close()
  const w2 = await start(cfg, { poll: 'auto' })
  check('a session that does not poll has nothing to warn about', !/Setup problem/.test(w2.client.getInstructions() ?? ''))
  await w2.close()
  rmSync(join(cfg, 'settings.json'))
  await Bun.sleep(300)

  console.log('\n[24] expired login')
  fake.state.expired = true
  const x = await start(cfg)
  check('poll loop reports it once and backs off', await waitFor(() => /login expired \(errcode -14\)/.test(x.log()), 5000), x.log())
  r = await x.reply({ text: 'x' })
  check('reply explains what to do', r.isError && /login expired/.test(r.text) && /wxmedia:configure login/.test(r.text), r.text)
  const pollsAtExpiry = fake.state.polls.length
  await Bun.sleep(3000)
  check('no retry storm', fake.state.polls.length === pollsAtExpiry, `${fake.state.polls.length} vs ${pollsAtExpiry}`)
  await x.close()
  fake.state.expired = false

  console.log('\n[25] without credentials the server refuses to start')
  let startError = ''
  try {
    const none = await start(join(TMP, 'nothing'))
    await none.close()
  } catch (err) {
    startError = String(err)
  }
  check('exits instead of serving', startError !== '', startError)

  check('every API call was authenticated', fake.state.authFailures === 0, String(fake.state.authFailures))
} catch (err) {
  failed++
  console.log(`  FAIL unexpected error: ${(err as Error)?.stack ?? err}`)
} finally {
  fake.stop()
  rmSync(TMP, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
