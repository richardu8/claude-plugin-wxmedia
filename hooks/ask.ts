#!/usr/bin/env bun
/**
 * PermissionRequest hook for AskUserQuestion: put Claude's multiple-choice
 * question on WeChat as well, and hand back the answer given there.
 *
 * Claude Code runs this hook while the question is on screen in the terminal,
 * so both stay answerable and the first answer wins. The question goes to
 * WeChat when the session's latest input came from WeChat (access.json relay
 * "auto", the default) or every time (relay "always"), and only while a
 * channel session is up to receive the reply.
 *
 * This runs in every session that has the plugin enabled. Whatever goes wrong,
 * it prints nothing and exits 0, which leaves the terminal dialog as it was.
 */

import { statSync } from 'fs'

import {
  addPending, findQuestionToolUse, isThisChannel, latestInputOrigin, newId,
  parseQuestionAnswer, questionText, relayMode, relayRecipients, removePending,
  sendText, takeAnswer, toolResultRecorded,
  type Question,
} from '../relay'
import { apiFor, findClaude, isAlive, livePollers, loadCredentials, log } from '../state'

const WAIT_MS = Number(process.env.WXMEDIA_ASK_WAIT_MS) || 24 * 60 * 60_000

// The prompt currently waiting on WeChat. Left behind, it would swallow the
// user's next message as its answer, so every way out goes through cleanup().
let open: string | null = null

function cleanup(): void {
  if (open) removePending(open)
  open = null
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    cleanup()
    process.exit(0)
  })
}

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text())
  const questions: Question[] = input?.tool_input?.questions
  const transcript: string = input?.transcript_path
  if (input?.tool_name !== 'AskUserQuestion' || !Array.isArray(questions) || questions.length === 0) return
  if (typeof transcript !== 'string') return

  const mode = relayMode()
  if (mode === 'never') return
  const origin = latestInputOrigin(transcript)
  if (mode === 'auto' && !isThisChannel(origin)) return
  if (livePollers().length === 0) return // no channel session to receive the reply

  const creds = loadCredentials()
  if (!creds?.token || !creds?.baseUrl) return
  const api = apiFor(creds)

  // One person answers: the WeChat sender of the task, else the bot's owner.
  const candidates = relayRecipients(origin)
  const user = candidates.length === 1 ? candidates[0] : candidates.find(u => u === creds.userId)
  if (!user) return

  // An answer given at the terminal shows up in the transcript as the result
  // of this tool call. Without a handle on the call there is no telling when
  // to stop waiting, so then the question is not relayed at all.
  let toolUseId: string | null = null
  for (let attempt = 0; attempt < 10 && !toolUseId; attempt++) {
    if (attempt > 0) await Bun.sleep(500)
    toolUseId = findQuestionToolUse(transcript, questions[0].question)
  }
  if (!toolUseId) return
  const watchFrom = Math.max(0, statSync(transcript).size - 1024 * 1024)

  const claude = findClaude()
  const deadline = Date.now() + WAIT_MS
  const answers: Record<string, string> = {}

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const id = newId()
    addPending({ id, kind: 'question', users: [user], owner: process.pid, createdAt: Date.now(), expiresAt: deadline })
    open = id
    await sendText(api, user, questionText(id, q, i, questions.length))

    for (let tick = 0; ; tick++) {
      const reply = takeAnswer(id)?.text
      if (reply !== undefined) {
        const parsed = parseQuestionAnswer(q, reply)
        if ('answer' in parsed) {
          answers[q.question] = parsed.answer
          break
        }
        await sendText(api, user, parsed.problem)
      }
      if (tick % 4 === 0) {
        if (toolResultRecorded(transcript, toolUseId, watchFrom)) {
          cleanup()
          await sendText(api, user, '这道题已经在电脑上回答了。').catch(() => {})
          return
        }
        if (claude && !isAlive(claude.pid)) return // the session is gone
      }
      if (Date.now() > deadline) {
        cleanup()
        await sendText(api, user, '这道题等得太久，微信上不再接收答案，请回到电脑终端作答。').catch(() => {})
        return
      }
      await Bun.sleep(500)
    }
    cleanup()
  }

  await sendText(api, user, `已收到：${questions.map(q => answers[q.question]).join('；')}`).catch(() => {})
  // updatedInput replaces the whole tool input, so the questions go back with the answers.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { ...input.tool_input, answers } },
    },
  }))
}

main()
  .catch(err => log(`question relay failed: ${err}`))
  .finally(() => {
    cleanup()
    process.exit(0)
  })
