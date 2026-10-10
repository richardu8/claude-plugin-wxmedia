/**
 * Relaying terminal prompts to WeChat: tool approvals and multiple-choice questions.
 *
 * A prompt waiting for a WeChat answer is a file in pending/. Whichever server
 * is polling routes the user's reply to it by writing answers/<id>.json, and
 * the process that owns the prompt (a server, or the question hook) picks that
 * up. The detour through files is what lets the owner and the poller be
 * different processes: with two channel sessions open only one of them polls,
 * and the question hook is a process of its own.
 */

import { closeSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

import { IlinkError, sendItem, STALE_TOKEN_ERRCODE, type Api } from './ilink'
import { ACCESS_FILE, NAME, STATE_DIR, isAlive, readContextTokens, readJson } from './state'

const PENDING_DIR = join(STATE_DIR, 'pending')
const ANSWERS_DIR = join(STATE_DIR, 'answers')

// --- When to relay ---

/**
 * access.json `relay`: auto sends a prompt to WeChat only while the session's
 * latest input came from WeChat, always sends every prompt, never sends none.
 */
export type RelayMode = 'auto' | 'always' | 'never'

export function relayMode(): RelayMode {
  const v = readJson(ACCESS_FILE)?.relay
  return v === 'always' || v === 'never' ? v : 'auto'
}

/** Where a session's latest input came from, as Claude Code records it in the transcript. */
export type Origin = { kind: string; server?: string; userId?: string }

export function isThisChannel(origin: Origin | null): boolean {
  return origin?.kind === 'channel' && (origin.server === `plugin:${NAME}:${NAME}` || origin.server === NAME)
}

const MB = 1024 * 1024

function readRange(path: string, start: number, end: number): string {
  const buf = Buffer.alloc(Math.max(0, end - start))
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

// Walk a transcript's lines from the end, in growing windows, until `pick`
// returns something. Lines are JSON objects; `marker` is a cheap pre-filter.
function scanBack<T>(path: string, marker: string, pick: (entry: any) => T | undefined): T | null {
  let size: number
  try {
    size = statSync(path).size
  } catch { return null }
  for (let window = 2 * MB; ; window *= 4) {
    const start = Math.max(0, size - window)
    const lines = readRange(path, start, size).split('\n')
    if (start > 0) lines.shift() // cut mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(marker)) continue
      let entry: any
      try {
        entry = JSON.parse(lines[i])
      } catch { continue }
      const got = pick(entry)
      if (got !== undefined) return got
    }
    if (start === 0 || window >= 128 * MB) return null
  }
}

/**
 * Typed prompts are user entries with origin {kind: "human"}; channel messages
 * carry {kind: "channel", server: "plugin:wxmedia:wxmedia"}. Tool results and
 * injected reminders have no origin and are skipped.
 */
export function latestInputOrigin(transcriptPath: string): Origin | null {
  return scanBack(transcriptPath, '"origin"', entry => {
    if (entry?.type !== 'user' || entry.isSidechain || typeof entry.origin?.kind !== 'string') return undefined
    const content = typeof entry.message?.content === 'string' ? entry.message.content : ''
    return {
      kind: entry.origin.kind,
      server: entry.origin.server,
      userId: /^<channel [^>]*\buser_id="([^"]+)"/.exec(content)?.[1],
    }
  })
}

/** The id of the AskUserQuestion call that is on screen, found by its first question. */
export function findQuestionToolUse(transcriptPath: string, firstQuestion: string): string | null {
  return scanBack(transcriptPath, '"AskUserQuestion"', entry => {
    const blocks = entry?.type === 'assistant' && Array.isArray(entry.message?.content) ? entry.message.content : []
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && b.input?.questions?.[0]?.question === firstQuestion) {
        return b.id as string
      }
    }
    return undefined
  })
}

/** Whether the transcript, from byte `since` on, holds the result of that tool call. */
export function toolResultRecorded(transcriptPath: string, toolUseId: string, since: number): boolean {
  try {
    const size = statSync(transcriptPath).size
    if (size <= since) return false
    return readRange(transcriptPath, since, size)
      .split('\n')
      .some(line => line.includes(toolUseId) && line.includes('"tool_result"'))
  } catch {
    return false
  }
}

/** Who gets the prompt: the WeChat sender of the task if there is one, else everyone on the allowlist. */
export function relayRecipients(origin: Origin | null): string[] {
  const allowFrom: string[] = readJson(ACCESS_FILE)?.allowFrom ?? []
  if (isThisChannel(origin) && origin!.userId && allowFrom.includes(origin!.userId)) return [origin!.userId]
  return allowFrom
}

// --- Pending prompts and their answers ---

export type Pending = {
  id: string
  kind: 'permission' | 'question'
  users: string[]   // who may answer
  owner: number     // pid of the process waiting for the answer
  createdAt: number
  expiresAt: number
}

export type Answer = { verdict?: 'allow' | 'deny'; text?: string }

/** Five lowercase letters without 'l', the shape of Claude Code's own permission request ids. */
export function newId(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let id = ''
  for (let i = 0; i < 5; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return id
}

function writeAtomic(file: string, data: object): void {
  writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 })
  renameSync(file + '.tmp', file)
}

export function addPending(p: Pending): void {
  mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 })
  writeAtomic(join(PENDING_DIR, `${p.id}.json`), p)
}

export function removePending(id: string): void {
  rmSync(join(PENDING_DIR, `${id}.json`), { force: true })
  rmSync(join(ANSWERS_DIR, `${id}.json`), { force: true })
}

export function isPending(id: string): boolean {
  return readJson(join(PENDING_DIR, `${id}.json`)) !== null
}

/**
 * Prompts this user may answer, newest first. Expired ones and ones whose
 * owner is gone are deleted on the way — a prompt nobody is waiting on must
 * not swallow the user's next message.
 */
export function listPending(userId: string): Pending[] {
  let names: string[]
  try {
    names = readdirSync(PENDING_DIR)
  } catch { return [] }
  const out: Pending[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const p = readJson(join(PENDING_DIR, name)) as Pending | null
    if (!p) continue
    if (p.expiresAt < Date.now() || !isAlive(p.owner)) {
      removePending(p.id)
      continue
    }
    if (p.users.includes(userId)) out.push(p)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function takeAnswer(id: string): Answer | null {
  const file = join(ANSWERS_DIR, `${id}.json`)
  const answer = readJson(file) as Answer | null
  if (answer) rmSync(file, { force: true })
  return answer
}

function putAnswer(id: string, answer: Answer): void {
  mkdirSync(ANSWERS_DIR, { recursive: true, mode: 0o700 })
  writeAtomic(join(ANSWERS_DIR, `${id}.json`), answer)
}

// "y" / "n abcde". Bare forms are only taken for a short while after the
// prompt went out: a terminal answer does not tell us the prompt is closed,
// and a stray "y" an hour later is more likely about something else.
const VERDICT_RE = /^\s*(y|yes|n|no|同意|允许|拒绝|不允许)(?:\s+([a-km-z]{5}))?\s*$/i
const ADDRESSED_RE = /^\s*([a-km-z]{5})[\s:：]+([\s\S]+)$/i
const BARE_VERDICT_WINDOW_MS = 10 * 60_000

/**
 * If this text answers a pending prompt, hand it to the prompt's owner and
 * return the prompt. Otherwise return null and the text goes to Claude as an
 * ordinary message.
 */
export function routeReply(userId: string, text: string): (Pending & Answer) | null {
  const pending = listPending(userId)
  if (pending.length === 0) return null

  const v = VERDICT_RE.exec(text)
  if (v) {
    const verdict = /^(y|yes|同意|允许)$/i.test(v[1]) ? 'allow' : 'deny'
    const id = v[2]?.toLowerCase()
    const target = pending.find(p =>
      p.kind === 'permission' && (id ? p.id === id : Date.now() - p.createdAt < BARE_VERDICT_WINDOW_MS))
    if (target) {
      putAnswer(target.id, { verdict })
      return { ...target, verdict }
    }
  }

  const a = ADDRESSED_RE.exec(text)
  const addressed = a && pending.find(p => p.kind === 'question' && p.id === a[1].toLowerCase())
  const target = addressed || pending.find(p => p.kind === 'question')
  if (!target) return null
  const answer = (addressed ? a![2] : text).trim()
  putAnswer(target.id, { text: answer })
  return { ...target, text: answer }
}

// --- What goes to WeChat ---

/** Text to one user, with the latest context_token seen from them; once more without it if refused. */
export async function sendText(api: Api, userId: string, text: string, contextToken?: string): Promise<void> {
  const token = contextToken ?? readContextTokens()[userId]
  const item = { type: 1, text_item: { text } }
  try {
    await sendItem(api, userId, item, token)
  } catch (err) {
    if (!token || !(err instanceof IlinkError) || err.code === STALE_TOKEN_ERRCODE) throw err
    await sendItem(api, userId, item)
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function permissionPromptText(id: string, toolName: string, description: string, inputPreview: string): string {
  const lines = [`【需要审批】${toolName}`]
  if (description) lines.push(clip(description, 300))
  if (inputPreview) lines.push(clip(inputPreview, 1200))
  lines.push(
    '',
    '回复“y”允许，“n”拒绝。电脑终端上也可以直接选，先答的生效。',
    `编号${id}。超过10分钟才回复时，请写成“y ${id}”或“n ${id}”。`,
  )
  return lines.join('\n')
}

export type Question = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export function questionText(id: string, q: Question, index: number, total: number): string {
  const lines = [`【Claude提问${total > 1 ? `${index + 1}/${total}` : ''}】${q.header ?? ''}`, clip(q.question, 600), '']
  q.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.description ? `：${clip(o.description, 200)}` : ''}`)
  })
  lines.push(
    '',
    q.multiSelect
      ? '回复序号作答，可以多选，例如“1,3”；也可以直接回复文字。'
      : '回复序号作答；也可以直接回复文字。',
    `电脑终端上也可以作答，先答的生效。（编号${id}）`,
  )
  return clip(lines.join('\n'), 1900)
}

/**
 * Turn a WeChat reply into the answer AskUserQuestion expects: an option
 * label, several labels joined by ", ", or the user's own words.
 */
export function parseQuestionAnswer(q: Question, reply: string): { answer: string } | { problem: string } {
  const text = reply.trim()
  if (/^\d+(?:[\s,，、]+\d+)*$/.test(text)) {
    const picks = [...new Set(text.split(/[\s,，、]+/).map(Number))]
    if (picks.some(n => n < 1 || n > q.options.length)) {
      return { problem: `没有这个选项。请回复1到${q.options.length}之间的序号，或直接回复文字。` }
    }
    if (picks.length > 1 && !q.multiSelect) {
      return { problem: '这道题只能选一个。请回复一个序号，或直接回复文字。' }
    }
    return { answer: picks.map(n => q.options[n - 1].label).join(', ') }
  }
  const byLabel = q.options.find(o => o.label.toLowerCase() === text.toLowerCase())
  return { answer: byLabel ? byLabel.label : text }
}
