/**
 * On-disk state of the channel, shared by the server and the hook.
 * Everything lives in ~/.claude/channels/wxmedia/.
 */

import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

import { DEFAULT_CDN_BASE_URL, type Api } from './ilink'

export const NAME = 'wxmedia'
export const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
export const CHANNELS_DIR = join(CONFIG_DIR, 'channels')
export const STATE_DIR = join(CHANNELS_DIR, NAME)
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const CREDENTIALS_FILE = join(STATE_DIR, 'credentials.json')
export const SYNC_BUF_FILE = join(STATE_DIR, 'sync_buf.txt')
export const CONTEXT_TOKENS_FILE = join(STATE_DIR, 'context_tokens.json')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const POLLERS_DIR = join(STATE_DIR, 'pollers')

export function log(msg: string): void {
  process.stderr.write(`wxmedia channel: ${msg}\n`)
}

export function writePrivate(file: string, text: string): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** Parsed JSON, or null when the file is missing or unreadable. */
export function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The claude process this server or hook belongs to, found among its ancestors. */
export function findClaude(): { pid: number; args: string } | null {
  let pid = process.ppid
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    let out: string
    try {
      out = execFileSync('ps', ['-ww', '-o', 'ppid=', '-o', 'args=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch { return null }
    const m = /^\s*(\d+)\s+([\s\S]*)$/.exec(out)
    if (!m) return null
    const [exe, script] = m[2].split(/\s+/)
    // The native binary runs as `claude`, an npm install as `node …/claude`.
    const isClaude = /^claude(\.exe)?$/.test(basename(exe)) ||
      (/^(node|bun)$/.test(basename(exe)) && /claude/.test(script ?? ''))
    if (isClaude) return { pid, args: m[2] }
    pid = Number(m[1])
  }
  return null
}

// --- Credentials ---

export type Credentials = {
  token: string
  baseUrl: string
  userId?: string
  accountId?: string
  cdnBaseUrl?: string
}

export function loadCredentials(file = CREDENTIALS_FILE): Credentials | null {
  return readJson(file)
}

export function apiFor(creds: Credentials): Api {
  return {
    token: creds.token,
    baseUrl: creds.baseUrl,
    cdnBaseUrl: creds.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
  }
}

// --- Context tokens ---

// iLink issues a context_token with every inbound message and wants it echoed
// on sends. The latest one per sender is kept on disk so a reply still goes
// out after a restart, or from a process that is not the one polling.

export function readContextTokens(): Record<string, string> {
  return readJson(CONTEXT_TOKENS_FILE) ?? {}
}

export function rememberContextToken(userId: string, token: string): void {
  const all = readContextTokens()
  if (all[userId] === token) return
  all[userId] = token
  writePrivate(CONTEXT_TOKENS_FILE, JSON.stringify(all, null, 2) + '\n')
}

// --- Pollers ---

// Each server that polls, or stands by to, keeps a heartbeat file in pollers/.
export const POLLER_STALE_MS = 30_000

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Servers with a fresh heartbeat, i.e. channel sessions that are up right now. */
export function livePollers(): { pid: number; boot: number }[] {
  let names: string[]
  try {
    names = readdirSync(POLLERS_DIR)
  } catch { return [] }
  const live: { pid: number; boot: number }[] = []
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ''))
    if (!name.endsWith('.json') || !pid) continue
    const file = join(POLLERS_DIR, name)
    const p = readJson(file)
    if (!p) continue
    const age = Date.now() - (p.at ?? 0)
    if (age < POLLER_STALE_MS && isAlive(pid)) {
      live.push({ pid, boot: p.boot ?? 0 })
    } else if (age > 10 * 60_000) {
      // Left behind by a session that died without cleaning up.
      rmSync(file, { force: true })
    }
  }
  return live
}
