/**
 * Conversation archiving: appends one turn per `turn/end` into a dated note
 * under `Deepseek Harness/` in the vault, so chats become searchable,
 * linkable Obsidian notes that sync outward like any other edit.
 *
 * The archive writes through the Vault API directly (user's own transcript —
 * it never goes through the agent write-approval gate) and is strictly
 * append-only per file: one note per conversation, frontmatter on first
 * create, turns appended in order.
 *
 * @module
 */

import type { App, TFile } from 'obsidian'

export interface TurnRecord {
  sessionId: string
  sessionTitle: string | null
  model: string | null
  userText: string
  assistantText: string
  toolLines: string[]
}

/** Sanitize a string into an Obsidian-safe filename fragment. */
function safeName(raw: string): string {
  return raw.replace(/[\\/:|^]|\[|\]|#|"/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function todayStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function timeHM(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Build the archive file name for a conversation. */
export function archiveFileName(title: string | null, sessionId: string): string {
  const label = safeName(title ?? '') || safeName(sessionId).slice(0, 12)
  return `${todayStamp()} ${safeName(label)}.md`
}

/** Render one turn as markdown. */
export function renderTurn(turn: TurnRecord): string {
  const parts: string[] = []
  parts.push(`## 🧑 你 · ${now()}`)
  parts.push('')
  parts.push(turn.userText)
  parts.push('')
  if (turn.toolLines.length > 0) {
    parts.push(`> 🔧 ${turn.toolLines.join(' → ')}`)
    parts.push('')
  }
  parts.push(`## 🤖 DSH · ${now()}${turn.model !== null ? `（${turn.model}）` : ''}`)
  parts.push('')
  parts.push(turn.assistantText !== '' ? turn.assistantText : '（本轮无文本回复）')
  parts.push('')
  return parts.join('\n')
}

function frontMatter(turn: TurnRecord): string {
  return [
    '---',
    `dsh-session: ${turn.sessionId}`,
    ...(turn.model !== null ? [`dsh-model: ${turn.model}`] : []),
    `dsh-archived: ${todayStamp()}`,
    'tags:',
    '  - dsh-对话',
    '---',
    '',
    `# DSH 对话 · ${todayStamp()}`,
    '',
  ].join('\n')
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(folder) !== null) return
  const parts = folder.split('/')
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`
    if (app.vault.getAbstractFileByPath(current) === null) {
      await app.vault.createFolder(current)
    }
  }
}

/**
 * Append one turn to the conversation's archive note (creating it with
 * frontmatter on the first turn).
 * @returns the archive file path, or null when the turn produced nothing.
 */
export async function appendTurn(
  app: App,
  folder: string,
  turn: TurnRecord,
): Promise<string | null> {
  if (turn.userText.trim() === '' && turn.assistantText.trim() === '') return null
  const fileName = archiveFileName(turn.sessionTitle, turn.sessionId)
  const path = `${folder}/${fileName}`
  const section = renderTurn(turn)

  const existing = app.vault.getAbstractFileByPath(path)
  if (existing !== null && existing instanceof Object && 'stat' in existing) {
    await app.vault.process(existing as TFile, data => `${data.endsWith('\n') ? data : `${data}\n`}\n${section}\n`)
    return path
  }
  await ensureFolder(app, folder)
  await app.vault.create(path, `${frontMatter(turn)}${section}\n`)
  return path
}

/** Export a full rendered conversation as one note (manual archive). */
export async function exportConversation(
  app: App,
  folder: string,
  title: string,
  sessionId: string,
  model: string | null,
  body: string,
): Promise<string> {
  const turn: TurnRecord = {
    sessionId,
    sessionTitle: title,
    model,
    userText: body,
    assistantText: '',
    toolLines: [],
  }
  const fileName = `对话存档 ${archiveFileName(title, sessionId)}`
  const path = `${folder}/${fileName}`
  const existing = app.vault.getAbstractFileByPath(path)
  if (existing !== null && existing instanceof Object && 'stat' in existing) {
    await app.vault.process(existing as TFile, data => `${data.endsWith('\n') ? data : `${data}\n`}\n${renderTurn(turn)}\n`)
    return path
  }
  await ensureFolder(app, folder)
  await app.vault.create(path, `${frontMatter(turn)}${renderTurn(turn)}\n`)
  return path
}
